-- Daily account view: stop a null-engagement profile sample from shadowing the
-- real engagement total on the same day.
--
-- account_metric_samples holds one row per observation, and different observers
-- fill different columns. The daily `account.profile` job writes followers/
-- following/posts and leaves the four engagement columns NULL (it only reads the
-- profile). The post-baseline finalize writes the engagement total. Both land on
-- the same calendar day, and in dev every page view pulls another profile sample.
--
-- The 001 view collapsed each day with DISTINCT ON (did, date) ORDER BY
-- sampled_at DESC: the single most recent row of the day won wholesale. So a
-- profile sample taken after the baseline (which happens every day, and repeatedly
-- in dev) hid the day's real likes/replies/quotes/reposts behind its own NULLs —
-- account_growth_daily reported engagement NULL even though a populated sample
-- existed hours earlier. The API's /snapshots reads this view, so the web viewer
-- showed no engagement for accounts that plainly had it.
--
-- Collapse per column instead: for each metric take the most recent NON-NULL
-- observation within the day, independently. Missing still means missing — a day
-- with no engagement sample at all stays NULL and gaps stay gaps — but a value
-- observed earlier the same day is no longer erased by a later profile-only
-- sample. Output columns are unchanged, so CREATE OR REPLACE is safe and every
-- consumer keeps working.

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
    (array_agg(reposts   ORDER BY sampled_at DESC) FILTER (WHERE reposts   IS NOT NULL))[1] AS reposts
  FROM analytics.account_metric_samples
  GROUP BY did, sampled_at::date
)
SELECT
  daily.*,
  followers - lag(followers) OVER actor_time AS followers_delta,
  following - lag(following) OVER actor_time AS following_delta,
  posts - lag(posts) OVER actor_time AS posts_delta,
  likes - lag(likes) OVER actor_time AS likes_delta,
  replies - lag(replies) OVER actor_time AS replies_delta,
  quotes - lag(quotes) OVER actor_time AS quotes_delta,
  reposts - lag(reposts) OVER actor_time AS reposts_delta
FROM daily
WINDOW actor_time AS (PARTITION BY did ORDER BY date);
