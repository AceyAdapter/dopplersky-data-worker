-- Expose the collector `source` on the daily account view so the chart can tell
-- legacy history from v2 history.
--
-- On 2026-08-31 legacy DopplerSky history was merged into account_metric_samples
-- (source='legacy', daily, back to 2024) ahead of the v2 rows (source='appview'/
-- 'registration', hourly, from cutover on). The two eras compute engagement
-- differently: legacy summed every post the old scraper ever saw and never pruned
-- deletions, so delete-heavy accounts carry years of since-deleted posts' likes;
-- v2 counts only posts currently live. Differencing across that single
-- legacy->non-legacy boundary manufactures a one-time ~99% "cliff" that is not
-- real engagement loss. There is no honest way to reconstruct legacy's
-- then-live figures, so the DB stays as-is and the fix is presentation-only: the
-- reader breaks the engagement series at the boundary. It needs `source` per day.
--
-- The daily view already collapses each metric to its most-recent NON-NULL
-- observation of the day (migration 005). We attach the day's `source` to the
-- engagement figure specifically: the source of the most recent sample that
-- carried a likes value. Tying `source` to the same observation `likes` came
-- from keeps the boundary honest even on the cutover day, when early v2 hourly
-- ticks can skip the engagement recompute (likes NULL): the day is labelled by
-- whichever era actually produced the engagement number shown, never by a later
-- profile-only tick. Days with no engagement sample at all get source NULL (they
-- are an engagement gap regardless), which the reader treats as "not the
-- boundary". followers/following/posts are unaffected and stay continuous.
--
-- Output adds `source` as a trailing column only, so CREATE OR REPLACE is safe
-- and every existing consumer keeps working unchanged.

CREATE OR REPLACE VIEW analytics.account_growth_daily AS
WITH daily AS (
  SELECT
    did,
    sampled_at::date AS date,
    (array_agg(followers ORDER BY sampled_at DESC) FILTER (WHERE followers IS NOT NULL))[1] AS followers,
    (array_agg(following ORDER BY sampled_at DESC) FILTER (WHERE following IS NOT NULL))[1] AS following,
    (array_agg(posts     ORDER BY sampled_at DESC) FILTER (WHERE posts     IS NOT NULL))[1] AS posts,
    (array_agg(likes     ORDER BY sampled_at DESC) FILTER (WHERE likes     IS NOT NULL))[1] AS likes,
    (array_agg(replies   ORDER BY sampled_at DESC) FILTER (WHERE replies   IS NOT NULL))[1] AS replies,
    (array_agg(quotes    ORDER BY sampled_at DESC) FILTER (WHERE quotes    IS NOT NULL))[1] AS quotes,
    (array_agg(reposts   ORDER BY sampled_at DESC) FILTER (WHERE reposts   IS NOT NULL))[1] AS reposts,
    (array_agg(source    ORDER BY sampled_at DESC) FILTER (WHERE likes     IS NOT NULL))[1] AS source
  FROM analytics.account_metric_samples
  GROUP BY did, sampled_at::date
)
SELECT
  did,
  date,
  followers,
  following,
  posts,
  likes,
  replies,
  quotes,
  reposts,
  followers - lag(followers) OVER actor_time AS followers_delta,
  following - lag(following) OVER actor_time AS following_delta,
  posts    - lag(posts)     OVER actor_time AS posts_delta,
  likes    - lag(likes)     OVER actor_time AS likes_delta,
  replies  - lag(replies)   OVER actor_time AS replies_delta,
  quotes   - lag(quotes)    OVER actor_time AS quotes_delta,
  reposts  - lag(reposts)   OVER actor_time AS reposts_delta,
  source
FROM daily
WINDOW actor_time AS (PARTITION BY did ORDER BY date);
