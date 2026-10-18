-- Bounded onboarding and collection.
--
-- Registering the largest account on the network proved the old shape fanned
-- out one `post.metrics` and one `post.engagers` job per discovered post, then
-- registered every engager's repository with Tap — 1,635 jobs and ~1.8 GB from
-- one signup (design note, notes/2026-08-26-bounded-onboarding-and-collection-plan.md).
-- This migration adds the state the bounded path needs:
--   * a current-metrics table (one row per post) so "rank all posts now" and the
--     account engagement total are cheap and coherent, separate from the
--     append-only `post_metric_samples` time series;
--   * a collection-run generation so a completed baseline publishes a total that
--     exactly equals the sum of the posts it observed (the old finalize summed
--     `post_metric_samples` with a `sampled_at <= profile_sampled_at` cutoff,
--     which excluded every page processed after the profile sample and published
--     roughly half the real total);
--   * account collection state and post maintenance lifecycle columns so daily
--     profile observation, batched cold-post maintenance, degraded state, and
--     hard cancellation have somewhere to live.
--
-- All `analytics.*`; the `auth` schema (003) is untouched.

-- One resumable run per account. The baseline run is the collection generation
-- that makes account totals coherent; `recent_discovery` is reserved for the
-- daily newest-page scan.
CREATE TABLE IF NOT EXISTS analytics.collection_runs (
  id bigserial PRIMARY KEY,
  did text NOT NULL REFERENCES analytics.tracked_accounts(did) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('post_baseline', 'recent_discovery')),
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'collecting', 'ready', 'degraded', 'cancelled')),
  cursor text,
  pages_processed integer NOT NULL DEFAULT 0,
  posts_discovered integer NOT NULL DEFAULT 0,
  appview_requests integer NOT NULL DEFAULT 0,
  profile_sampled_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_progress_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_safe_error text
);

-- Fast lookup of the active run for an account, newest first.
CREATE INDEX IF NOT EXISTS collection_runs_did_kind_idx
  ON analytics.collection_runs (did, kind, started_at DESC);

-- At most one live baseline run per account. A partial unique index keeps the
-- generation single without blocking a later re-baseline once the old one ends.
CREATE UNIQUE INDEX IF NOT EXISTS collection_runs_one_live_baseline_idx
  ON analytics.collection_runs (did)
  WHERE kind = 'post_baseline' AND state IN ('queued', 'collecting');

-- Current known metrics, one row per post. This is what account totals sum and
-- what future post rankings read; the time series in `post_metric_samples`
-- stays append-only and changed-only for replay.
CREATE TABLE IF NOT EXISTS analytics.post_current_metrics (
  uri text PRIMARY KEY REFERENCES analytics.posts(uri) ON DELETE CASCADE,
  likes bigint NOT NULL,
  replies bigint NOT NULL,
  quotes bigint NOT NULL,
  reposts bigint NOT NULL,
  metrics_sampled_at timestamptz NOT NULL,
  source text NOT NULL DEFAULT 'appview',
  collection_run_id bigint REFERENCES analytics.collection_runs(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Account collection state, so a page read answers readiness without inferring
-- it from nullable engagement columns.
ALTER TABLE analytics.tracked_accounts
  ADD COLUMN IF NOT EXISTS baseline_state text NOT NULL DEFAULT 'queued'
    CHECK (baseline_state IN ('queued', 'collecting', 'ready', 'degraded', 'cancelled'));
ALTER TABLE analytics.tracked_accounts
  ADD COLUMN IF NOT EXISTS last_safe_error text;
-- Daily newest-page discovery is guarded off this timestamp so a page view
-- cannot trigger a feed scan more often than the freshness policy allows.
ALTER TABLE analytics.tracked_accounts
  ADD COLUMN IF NOT EXISTS last_recent_scan_at timestamptz;

-- Post maintenance lifecycle. `next_poll_at` already exists (001); these record
-- when the current metrics were last observed and how many times, so the cold
-- rotation and honest `metricsSampledAt` surfacing have a home.
ALTER TABLE analytics.tracked_posts
  ADD COLUMN IF NOT EXISTS metrics_sampled_at timestamptz;
ALTER TABLE analytics.tracked_posts
  ADD COLUMN IF NOT EXISTS refresh_count integer NOT NULL DEFAULT 0;

-- Accounts already past their baseline before this migration keep their settled
-- state; anything mid-flight falls back to the default 'queued' and the daily
-- profile job re-derives it.
UPDATE analytics.tracked_accounts
SET baseline_state = 'ready'
WHERE posts_backfilled_at IS NOT NULL
  AND baseline_state = 'queued';
