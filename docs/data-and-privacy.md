# Data and privacy deployment contract

This worker ran on dopplersky.com from September 2026 until the product shut
down. If you run it yourself, your own disclosure and retention decisions are
yours to make. Until those decisions exist, the code's honest default is indefinite
retention of the normalized rows described below.

## Public data collected

- Public profile identifiers and metadata: DID, current handle, display name,
  avatar URL, and public follower/following/post counts.
- Public post identifiers, text, timestamps, reply/embed-presence flags, and
  cumulative engagement counts. Embedded media bytes are not stored; only the
  fact that an embed is present is retained for the analytics display.
- Public follower membership for sampled cohorts.
- Public accounts that like, repost, quote, or reply to tracked posts, including
  the public record URI/time when available and their current public follower
  relationship to the target.
- Public post/like/repost/follow activity from a bounded, rotating cohort of an
  account's recent engagers, captured **forward-only** from the public Jetstream
  firehose (`wantedDids` = the cohort), used to aggregate activity time (D16).
  The worker stores record/subject URIs and timestamps, not post text or media.
  There is no repository backfill, so no pre-enrollment audience history is
  collected; capture begins when a member enters the cohort and ends when they
  rotate out.
- Surviving records' own `createdAt` timestamps, used to reconstruct a
  pre-enrollment timeline (post replay, account engagement, and sampled follower
  acquisition). Only records that still exist in a repo at backfill time are
  visible; records deleted before enrollment are unrecoverable.
- Operational jobs, scan-completeness metadata, and API outbox events.
- Live notification that a tracked account published or deleted a post, via the
  public Jetstream firehose filtered to the tracked authors' DIDs
  (`app.bsky.feed.post` only). This is used solely to *schedule* metric sampling
  of that post; the Jetstream record body is not stored by the launch tracker.

The worker does not authenticate as a user, read private chat, or ingest email or
payment data. Both Jetstream sockets are server-side filtered by `wantedDids`,
never the full network: the launch tracker to the tracked accounts' own post
events, and the audience socket to the bounded engager cohort's public
like/repost/post/follow events. Tap full-network/backfill collection is not used.

## Deletion and status behavior

Jetstream delete events for a watched cohort member mark protocol activity and
matching engagement edges inactive (setting `removed_at`) without erasing the
audit row. A Jetstream post-delete event for a tracked account disables that
tracked post (stops further sampling); a post AppView no longer returns is
likewise disabled. A missing AppView post stops replay polling but retains
historical metric observations. Account-level erasure is not yet an operator
command; production deployment therefore requires a tested deletion procedure
(and, if promised by policy, an API/product path) covering the target DID across
the `analytics` schema. Audience v2 needs no repository detach — a DID simply
stops being watched when it leaves the live cohort (no Tap, D16).

Reconstructed history reflects only records that still exist: a delete observed
after enrollment is subtracted at the observation time, and records deleted
before enrollment never enter the dataset. Reconstructed relationship and
segment labels (follower vs non-follower) describe the *current* public graph
unless the record is independently timestamped, so product copy must not present
them as historical facts about an earlier date.

## Required before production

1. Publish policy language covering stored public post text, follower sampling,
   non-follower engagers, audience repository activity, purposes, legal basis,
   processors, retention, and deletion/contact rights.
2. Choose and implement retention/partition pruning for metric samples,
   activity, engagement edges, cohorts, jobs, and delivered outbox rows.
3. Add a tested DID deletion command that deletes transactional data across the
   `analytics` schema. Audience v2 needs no repo detach — the DID just leaves the
   Jetstream cohort; a future Tap backfill phase would re-add a repo-removal step.
4. Restrict `/internal/worker-sync` to an internal network with distinct secrets,
   and back up Postgres state.
5. Document whether aggregate results may survive source-record deletion and
   ensure product copy matches that choice.
