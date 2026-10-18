-- Throttle clock for piggybacked profile refreshes.
--
-- While a tracked account's own post is actively replaying (the dense
-- post.metrics ladder, ~30s early), we opportunistically re-observe the account
-- profile so follower gains show up alongside the post's rising engagement,
-- instead of waiting up to an hour for the next account.profile sample (W32).
--
-- This column is the guard that keeps that bounded: beginProfileRefreshIfDue
-- claims it atomically, so a burst of simultaneously-replaying posts can trigger
-- at most one getProfiles per account per window. recordAccountSample stamps it
-- on every profile observation, so the hourly account.profile job and the
-- piggyback share one clock and never double up.
ALTER TABLE analytics.tracked_accounts
  ADD COLUMN IF NOT EXISTS last_profile_refresh_at timestamptz;
