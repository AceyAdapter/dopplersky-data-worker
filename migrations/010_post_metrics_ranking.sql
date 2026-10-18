-- Rank an account's posts by engagement without sorting the whole register.
--
-- `/posts` defaults to "most interactions". The filter (account_did) lives on
-- tracked_posts and the metric (likes+replies+quotes+reposts) lives on
-- post_current_metrics, so no single index could serve "top posts for this
-- account": Postgres scanned every one of the account's posts and sorted them
-- to return 25. This denormalizes both onto post_current_metrics so the ranking
-- is an ordered index scan that stops after the page.
--
--   * account_did mirrors tracked_posts.account_did. A post's owning account is
--     immutable (a post never changes authors), so the copy never drifts once
--     set; the write path keeps it in sync and this backfills what exists.
--   * interactions is the stored sum of the four counters — GENERATED so it is
--     always exact and never writable, STORED so it can be indexed.
--
-- All analytics.*; the auth schema (003) is untouched. NOTE: adding a STORED
-- generated column rewrites the table under an ACCESS EXCLUSIVE lock. Fine on
-- the local dataset; a production run would build this out of band (add nullable
-- column, backfill in batches, then the index CONCURRENTLY) rather than in one
-- migration transaction.

ALTER TABLE analytics.post_current_metrics
  ADD COLUMN IF NOT EXISTS account_did text;

ALTER TABLE analytics.post_current_metrics
  ADD COLUMN IF NOT EXISTS interactions bigint
    GENERATED ALWAYS AS (likes + replies + quotes + reposts) STORED;

-- Backfill the owning account from the tracking row, the scoping source of truth.
UPDATE analytics.post_current_metrics metric
SET account_did = tracked.account_did
FROM analytics.tracked_posts tracked
WHERE tracked.uri = metric.uri
  AND metric.account_did IS DISTINCT FROM tracked.account_did;

-- The ranking index: account first (equality), interactions descending (order).
-- Partial on account_did IS NOT NULL — explicit posts with no owning account are
-- never ranked through this per-account path, so they stay out of the index.
CREATE INDEX IF NOT EXISTS post_current_metrics_account_interactions_idx
  ON analytics.post_current_metrics (account_did, interactions DESC)
  WHERE account_did IS NOT NULL;
