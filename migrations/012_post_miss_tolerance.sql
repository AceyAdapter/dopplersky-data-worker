-- Stop transient AppView blips from permanently disabling live posts.
--
-- Batched cold maintenance (`refreshDuePosts`) calls `getPosts` for up to 25 due
-- URIs and disables any due post the response omits, treating "absent from this
-- batch" as "deleted". That is right for a real deletion but indistinguishable
-- from a transient empty/partial 200 (an AppView blip, a truncated body, or the
-- drain loop rate-limiting itself). On 2026-08-28 that fired on live posts and
-- disabled ~223k of them in bulk spikes at worker restarts — a disabled post is
-- excluded from the API by contract, so the Posts register, Lifetime panel, and
-- virality bands went blank for every account but the one still posting live
-- (design note, notes/2026-08-28-posts-mass-disabled-empty-register.md).
--
-- The fix hardens the read: a wholly empty response never disables anything, and
-- a post missing from a *nonempty* response is a soft miss that must recur for
-- `POST_MAINTENANCE_MISS_THRESHOLD` consecutive maintenance cycles before the
-- post is disabled. Jetstream still honors real deletions instantly on the
-- delete event; this counter is only the cold backstop. `consecutive_misses`
-- holds the run of misses and is reset to 0 on any successful sample.
--
-- All `analytics.*`.

ALTER TABLE analytics.tracked_posts
  ADD COLUMN IF NOT EXISTS consecutive_misses integer NOT NULL DEFAULT 0;

-- One-time repair of the W40 damage: re-enable every post the old loop disabled
-- and clear the miss counter, so the product shows real data again. This
-- re-enables the handful of genuinely-deleted posts too, but that self-heals —
-- maintenance will find them missing from nonempty responses and re-disable them
-- after the threshold, and Jetstream re-disables any that delete live. Their
-- next_poll_at is already in the past, so they simply rejoin the due rotation.
-- Local dataset only; this must run only after the hardened loop is deployed, or
-- the next bad `getPosts` window would just disable them again (D-note below).
UPDATE analytics.tracked_posts
SET enabled = true,
    consecutive_misses = 0,
    updated_at = now()
WHERE NOT enabled;
