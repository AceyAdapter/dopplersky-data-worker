-- Indexes for the API's hot read paths.
--
-- Two reads dominate the API and had no supporting index; both were confirmed
-- with EXPLAIN (ANALYZE, BUFFERS) against a 105k-tracked_post local database.
--
--   1. tracked_posts filtered by account_did (+ enabled). The `/posts` register
--      scans it and counts it, and `/collection_status` — polled every ~2s while
--      onboarding collects (design note) — takes max(metrics_sampled_at) over
--      it. With only the (uri) PK and the next_poll_at partial index, every one
--      of these was a full sequential scan of every tracked post on the network
--      (seq scan, ~2,667 shared buffers, all 105k rows filtered per call).
--
--   2. actors looked up by lower(handle). `/user/{handle}` is the SSR growth and
--      SEO surface (design note): every server-rendered profile resolves the
--      handle here with lower(actor.handle) = lower($1), which no plain index on
--      `handle` can serve. Trivial at today's row count, linear as signups grow.
--
-- All analytics.*; the auth schema (003) is untouched. In-transaction like the
-- other migrations, so plain CREATE INDEX (not CONCURRENTLY). A production
-- backfill against a live table would build these CONCURRENTLY out of band;
-- there is no production yet, and the local build is fast.

-- Leading column account_did serves the `/posts` scan and count; the trailing
-- metrics_sampled_at lets `/collection_status` answer max(metrics_sampled_at)
-- from an index-only scan (~1,048 buffers -> 5) instead of a heap aggregate.
-- Partial on `enabled` because every consumer filters enabled = true and the
-- lifecycle only ever disables, never re-enables in the hot path.
CREATE INDEX IF NOT EXISTS tracked_posts_account_metrics_idx
  ON analytics.tracked_posts (account_did, metrics_sampled_at DESC)
  WHERE enabled;

-- Functional index matching the case-insensitive handle resolution the SSR
-- profile route runs on every render. did stays identity (W3); this only speeds
-- the mutable-handle lookup, it does not make handle unique.
CREATE INDEX IF NOT EXISTS actors_lower_handle_idx
  ON analytics.actors (lower(handle));
