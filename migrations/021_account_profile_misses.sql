-- A tracked account whose profile the AppView no longer returns — deleted,
-- deactivated, or suspended — failed its hourly `account.profile` job forever
-- with "Profile not found for <did>", one error an hour, indefinitely, and no
-- amount of retrying can resurrect a dead DID. Count the consecutive misses so
-- the worker can retire a durably-unresolvable account after a small threshold
-- instead of re-checking it every hour until the end of time.
--
-- The counter resets to 0 on any successful observation, so a transient AppView
-- blip (a brief 404 while a PDS migrates) never trips it — only a sustained run
-- of misses does. This mirrors the existing `tracked_posts.consecutive_misses`
-- pattern for cold posts (migration 012). All analytics.*; additive and
-- idempotent.
ALTER TABLE analytics.tracked_accounts
  ADD COLUMN IF NOT EXISTS profile_miss_count smallint NOT NULL DEFAULT 0;
