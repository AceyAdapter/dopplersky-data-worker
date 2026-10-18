# Architecture

The worker combines selective polling with filtered, forward Jetstream capture.
AppView supplies hydrated profiles, post counters, and bounded graph/feed
enumeration. Jetstream follows tracked authors and the opted-in audience cohort;
Tap is mothballed. Postgres is the durable control plane and feature query store.

## File map

```text
lexicons/                     committed, CID-pinned protocol schemas
migrations/001_analytics.sql  analytics schema, indexes, queues, and views
migrations/002_historical_reconstruction.sql
                              subject_did, edge_key/removed_at, reconstructed views
migrations/003_oauth.sql      auth schema for dopplersky-web sign-in (separate concern)
migrations/004_bounded_collection.sql
                              collection_runs, post_current_metrics, account/post
                              collection state (design note)
src/
  config.ts                   validated environment boundary
  main.ts                     long-running process and graceful shutdown
  cli.ts                      migration and tracking entry points
  runtime.ts                  dependency composition
  domain/types.ts             branded domain/job/outbox types
  protocol/
    appview-client.ts         generated-schema XRPC reads and mapping
    tap-consumer.ts           verified record/identity event indexing
  observability/
    metrics.ts                bounded in-memory job/AppView rate windows
    observed-fetch.ts         request timing around actual XRPC attempts
    database-snapshot.ts      aggregate queue/workload/operator queries
    rising-posts.ts            read-only recent post momentum + observation coverage
    dashboard-server.ts       Basic Auth + connected-client-only SSE / cached rising read
    dashboard-html.ts         dependency-free local operator surface
  scheduling/cadence.ts       adaptive replay and retry cadence
  services/
    account-collector.ts      profile snapshot, baseline pages, batched maintenance
    post-collector.ts         changed-only replay sampling (explicit posts)
    audience-collector.ts     follower cohorts, engagers, relationship state (opt-in)
    orchestrator.ts           durable leased-job dispatch, generations, cancellation
    sampling.ts               deterministic bottom-k sampler
  storage/
    store.ts                  persistence boundary
    postgres-store.ts         transactional Postgres implementation
  sync/api-sync.ts            transactional-outbox delivery to the API seam
tests/_util.ts                typed protocol/store test doubles
scripts/verify.sh             repository definition of done
scripts/run.sh                production-build launcher
compose.yaml                  local Postgres + Tap + worker stack
```

`src/lexicons/` and `dist/` are generated and ignored.

## Production resilience (2026-09-10; cold-start fixes 2026-09-14/15)

- Replay bootstrap reconciles the eligible cohort in ONE set-based statement
  (`ensureReplayJobs`): recent posts are materialized, each is looked up by
  primary key, and only a missing or below-target `post.metrics` job is written.
  The URI-keyset page walk this replaced filtered correctly but re-ran its merge
  join per page, so a page cost O(cursor depth) — measured on production at
  250 ms for page 1 rising to 2.8 s by page 155, ~335 pages, 6m37s of a 6m38s
  cold start (D36). The earlier unbounded `trackedPosts()` read had loaded all
  enabled historical posts before filtering by age in JavaScript, exhausting the
  heap before the dashboard could listen. Explicit tracking still resumes at any
  age; account posts resume only inside the existing 30-day replay window and
  only when launch tracking is enabled. A fixed bootstrap cutoff and the
  unchanged `ON CONFLICT` policy preserve due dates, leases, payloads and
  priorities.
- The cohort scan has an access path (migration 027, D37): `analytics.posts
  (created_at, uri)`. It turns the window lookup into an index-only range read —
  production `EXPLAIN (ANALYZE)` went from 122,883 buffers / 247 ms to 96 buffers
  / 12 ms on the production-shaped set. **The index is only half of it**: an
  index-only scan still fetches the heap for any page the visibility map has not
  marked all-visible, and the first production plan showed exactly that —
  `Heap Fetches: 171,740`, 4.7 s, i.e. a random heap fetch per row. After
  `VACUUM (ANALYZE, PARALLEL 0) analytics.posts`: `Heap Fetches: 461`, 67 ms. A
  routine vacuum is load-bearing for this query, not hygiene. (The `PARALLEL 0`
  is required because the container runs Docker's 64 MB `/dev/shm` while
  `maintenance_work_mem` is 256 MB.)
- No bootstrap watermark, deliberately: a tracked post's `created_at` can predate
  its row (baseline backfill inserts posts carrying their real publication time),
  so a watermark can exclude an in-window post forever and leave it without a
  launch replay. The window stays absolute.
- What remains in the statement is the cohort match (~2.6 s) and the INSERT's
  ~168k conflict checks against `jobs_dedupe_key_key` (~6.5 s). An anti-join to
  skip those checks is measurably worse (it materializes all 5.78M job rows into
  a hash). Going below this means not doing the reconciliation on the startup
  path at all.
- Deployment now waits for the authenticated worker health endpoint and checks
  that it remains ready with zero restarts before reporting success. A container
  merely entering Docker's `running` state is insufficient.

- Profile retirement after three misses uses the existing `cancelled` baseline
  state, with the reason in `last_safe_error`. It atomically disables collection,
  cancels active baseline runs and removes account jobs. Reactivation resets the
  streak. No schema or public collection-state expansion is needed.
- Scheduler connection/availability errors use abortable exponential backoff
  (1–30 seconds with jitter), rather than exiting the process. Failed or uncertain
  job acknowledgements recover through lease expiry, not delayed ID-only writes.
  Application failures retain their existing retry/degrade policy. Idle pool
  errors are handled, and fatal shutdown drains sibling consumers before DB close.
- `protocol/jetstream-session.ts` runs one event handler per socket and bounds its
  pending buffer (256 messages / 4 MiB, including active work). Native WebSocket
  has no receive pause: overflow or failed persistence closes the connection and
  replays from completed work. Remote close/error reconnects with bounded jitter;
  logs include connection state, close code and retry delay. Maintenance callbacks
  do not overlap themselves; shutdown/reconnect awaits in-flight writes.
- Both filters use short URLs, `requireHello=true` and `options_update`. Empty
  cohorts close the socket (an empty upstream DID filter means **all** repos).
  Launch uses one filtered stream, not independently advancing shards sharing a
  cursor. Its durable checkpoint tracks completed work and flushes periodically,
  after settled sessions and on shutdown. Resume inclusively at that timestamp on
  the same configured endpoint, without repeatedly replaying a fixed-time prefix
  that could exceed the buffer. The single-stream protocol cap is 10,000 DIDs:
  exceeding it emits an error rather than silently truncating; add independently
  checkpointed partitions before growing past that cap. Audience remains
  forward-only with an in-process cursor; restarting does not claim historical
  coverage for a newly selected cohort.
- `src/storage/profile-misses.integration.test.ts` applies all migrations twice
  against PostgreSQL 16 and exercises retirement plus reactivation. Run with
  `TEST_DATABASE_URL` pointing to a **disposable** database named
  `dopplersky_worker_test`; it never falls back to `DATABASE_URL`. Deployment CI
  supplies that database and runs the suite before image publication.

## Data flow

### Local worker pulse (W44/D19)

Root Compose enables an HTTP server inside the worker and publishes it only on
`127.0.0.1:3002`. Every route uses HTTP Basic Auth. The page has no runtime
dependency or asset request: one inline HTML/CSS/JS response opens an SSE stream,
which triggers a two-second Postgres aggregate query only while at least one
browser is connected. Disconnecting the last browser stops the timer.

Queue depth/age, lease owners, onboarding runs, replay/maintenance workload,
database size, and connection count are shared database facts and therefore
cover every worker using that queue. Job outcomes, active slots, AppView request
latency/status, and recent errors are bounded in-memory windows for the process
serving the page; they reset on restart and are labelled as such. Multiple
workers can share the queue unchanged, but a fleet-wide historical rate needs a
future durable collector rather than pretending one process is the fleet.

### Private rising-post radar (2026-09-14)

The same Basic-Auth worker dashboard adds `GET /rising-posts`, independently of
SSE. It refreshes on demand at most once per 30 seconds across all viewers;
concurrent requests share one read, failures return generic 503s with a 30-second
cooldown, and no connected page means no periodic rising query. The browser
stops rising polling while hidden. A failed refresh visibly marks retained rows
as older data instead of presenting a fresh empty ranking.

`readRisingPosts` uses an indexed, read-only transaction with a five-second local
statement timeout. It ranks up to 30 enabled tracked accounts' own original posts
created in the last 48 hours by the actual interaction gain over 10–60 minutes of
saved observations. The latest saved observation must be at most 15 minutes old;
future points, synthetic creation-time origins and intervals with any per-counter
decrease are excluded. Prior rates require an adjacent observed interval covering
80–100% of the current span. Missing comparison stays null. These are changed-only
saved samples, not polling logs; counts and maximum gaps are shown, no gap is
filled, and the result is not a comprehensive 48-hour leaderboard. Existing
sampling slows with post age, so many older posts cannot meet these bounds.

The panel shows post text, age, actual gain/span, current/prior rates, sample
freshness, and source links. `Dopplersky` opens
`https://dopplersky.com/user/{handle}/posts?post={encodedATURI}&internal=1`;
`Bluesky` uses the stable author DID and post rkey. Links are escaped, fixed-origin,
new-tab/no-referrer navigations, with no prefetch. The internal marker prevents
operator visits contaminating Umami. Normal site login/Premium gates still apply;
these are operator deep links, not automatically minted public share tokens.
No audience reads, new account enrollment, collector cadence changes, schema
changes, or public API routes are part of this panel.

### Account stats and growth (bounded, design note)

1. Enrollment (API) or `track-account` writes actor/tracking state and enqueues
   a `account.profile` and a `posts.maintenance` job. A follower job is enqueued
   only when `AUDIENCE_COLLECTION_ENABLED` is set.
2. `account.profile` stores cumulative followers/following/posts and reschedules
   **hourly** (W32), so today's growth shows within the day. While the baseline
   is incomplete it ensures a `collection_run` is progressing; once complete it
   runs a guarded (~3h) newest-page recent scan. A page view can pull it due, but
   the recent-scan guard bounds feed reads.
3. A baseline is a chain of `account.posts` slices under one run. Each page
   writes every post's current metrics to `post_current_metrics` and a
   changed-only `post_metric_samples` row — and enqueues **no per-post job**. At
   completion the account engagement total is the sum of `post_current_metrics`
   for the account's enabled posts (no timestamp cutoff), and the run and
   account transition to `ready`.
4. `posts.maintenance` claims up to 25 due posts by `next_poll_at` and refreshes
   them in one `getPosts` call; posts AppView drops are disabled. Cadence is
   front-loaded — ~15m/1h/3h/6h/12h then 1d/2d/7d/30d, then a 30-day cold
   rotation (W32). The heartbeat idles ~15m when nothing is due, and a due-less
   wake makes no AppView call.
5. `account_growth_daily` chooses the last observation per UTC day and derives
   deltas with `lag`. No row means no observation.

### Post replay (live launch tracking, W34)

Going-forward account posts get high-resolution replay from the moment they go
live, via the `post.metrics` job driven by `nextPostPollDelayMs` — the same
machinery that serves explicit operator posts, now fed by Jetstream.

1. `JetstreamConsumer` (default on) subscribes to the public firehose filtered
   (`wantedCollections=app.bsky.feed.post`, `wantedDids=<tracked authors>`). On a
   tracked author's post `create`/`update` it enqueues a dense `post.metrics`
   replay (deduped on the URI); on `delete` it disables the tracked post. It only
   detects and schedules — the job does the sampling. It reconnects with backoff,
   re-filters when the tracked set changes, and degrades gracefully.
   (`track-post` still creates explicit operator posts the same way.)
2. `PostCollector.refreshMetrics` polls `getPosts`, writes the changed-only
   sample and current metrics, and reschedules on the dense ladder
   (~30s→2m→10m→30m→6h→daily). `unchangedRuns` adds bounded backoff.
3. It parks `next_poll_at` past the replay window so batched maintenance never
   double-samples a post the replay job owns. An account post graduates to
   maintenance after `POST_REPLAY_WINDOW_MS` (30 days); explicit posts never do.
   Account replay remains priority 75 for that whole bounded lifetime, above the
   bounded `account.audience` scan at 70. Bootstrap resumes in-window account
   posts at the same priority after a restart, but `ensureJob` preserves every
   existing `due_at`, lease, retry state, and cadence payload. Only a missing job
   starts immediately. Explicit operator jobs remain at 90.
4. A sample is inserted only when at least one cumulative metric changes;
   deletion disables future polling without deleting replay history.
5. `post_replay` returns totals, age since post creation, and interval deltas.

### Historical reconstruction

Observation only starts at enrollment, but each repo still carries surviving
records with their own `createdAt`. Tap backfill indexes those into
`protocol_activity` and `engagement_edges`, and a second family of views
reconstructs a pre-enrollment timeline from them:

1. `post_replay_reconstructed` and `account_engagement_reconstructed_daily`
   turn each surviving like/reply/quote/repost into a `+1` at its `createdAt`;
   a delete observed after enrollment writes `removed_at` and contributes `-1`
   at that observation time (the true deletion time is unknowable). Cumulative
   totals are running sums over those signed events.
2. `audience_follower_acquisition_daily` uses `protocol_activity.subject_did`
   from `graph.follow` records to date sampled followers' acquisition, weighting
   by inclusion probability only when the cohort scan is complete.
3. Engagement identity is `edge_key`: `record:<uri>` keeps each reply/quote
   distinct; `actor:<post>+<actor>+<kind>` lets an AppView like/repost and its
   later Tap record collapse to one edge. Backfill is prioritized by post age
   (`engagerBackfillPriority`) so recent posts reconstruct first.

This is a strictly lower confidence level than observation — see the two truth
levels in the README and `docs/data-and-privacy.md`. Records deleted before
enrollment are unknowable; gaps stay gaps, never zeros.

### Audience intelligence (opt-in, off by default)

This whole subsystem is gated behind `AUDIENCE_COLLECTION_ENABLED` (D10). With it
off, no follower/engager job is enqueued, a stale one is dropped on claim, and
the Tap channel never starts — so a signup adds zero audience rows and zero Tap
repos. The steps below apply only when it is explicitly enabled.

1. `getFollowers` is scanned up to `FOLLOWER_FULL_SCAN_LIMIT`; bottom-k hashing
   produces a stable monthly cohort of `FOLLOWER_SAMPLE_SIZE` DIDs. A complete
   scan is an unbiased sample with a known inclusion probability. A bounded
   scan is explicitly incomplete and is not population-weighted.
2. Likes, reposts, quotes, and replies on tracked posts create exact engagement
   edges. `getRelationships` classifies each discovered engager in batches of
   30; absent/not-found responses remain unresolved rather than being guessed.
3. Cohort members and engagers are added to Tap. Tap discovers each repo's PDS,
   backfills its public post/like/repost/follow records, then provides live
   at-least-once changes. Deletes deactivate activity and engagement edges.
4. `audience_activity_hour_of_week` groups the audience's own public activity
   by UTC ISO weekday/hour and segment: follower sample, follower engager,
   non-follower engager, or unresolved engager.

### API sync

Outbox events are appended **only when a remote sync transport is configured**
(`API_SYNC_URL`). In the converged same-database topology the API reads this
database directly, so the outbox would otherwise grow unbounded and never
deliver (D10 §outbox). When enabled, `ApiSyncClient` sends stable batches and
marks them delivered only after a successful HTTP response. The current receiver
is intentionally non-durable; the worker database remains the read-model source
until that adapter is designed.

## Efficiency and correctness boundaries

- AppView requests use built-in retry and generated response validation;
  profile/post/relationship calls respect lexicon batch limits.
- Jobs use `FOR UPDATE SKIP LOCKED`, leases, unique dedupe keys, jittered
  exponential retry, and a continuously refilled bounded pool, so one long job
  cannot leave the other slots idle and more worker processes can share a queue.
  Bootstrap uses a separate insert-if-missing path for all standing job kinds;
  ordinary event/command enqueue may pull work forward, restart never does.
  Retries stop at `MAX_JOB_ATTEMPTS`: the job is dropped and its account
  rests `degraded`, which the daily profile job later resumes from the committed
  cursor. Account/post handlers recheck `enabled` before doing work, so
  `disable-account` (which also deletes queued jobs) is a real cancellation, not
  just a selection filter.
- The migrator discovers `NNN_name.sql` files under `migrations/`, applies each
  unrecorded one in filename order inside a transaction, and records it in
  `analytics.schema_migrations`. Migrations must stay idempotent and forward-only;
  002 backfills `edge_key` before swapping the `engagement_edges` primary key so
  no edge is lost on upgrade.
- Time-series parents are range partitioned with default partitions. Create
  time partitions operationally before volume warrants it; the default keeps
  inserts safe during early deployment.
- Tap collection filters must remain
  `app.bsky.feed.post,app.bsky.feed.like,app.bsky.feed.repost,app.bsky.graph.follow`.
  Full-network mode defeats this design.
- AppView enumerations can be bounded and `getPostThread` has no cursor. Read
  `engagement_scan_status` before presenting audience completeness.

## External boundaries

- Public AppView: default `https://public.api.bsky.app`.
- Tap: official beta service, default local port 2480, WebSocket acknowledgments
  enabled for at-least-once delivery.
- PostgreSQL 16: `analytics` schema only. It can live in the existing database
  without changing legacy tables.
- `dopplersky-api`: optional internal bearer-authenticated sync endpoint.
