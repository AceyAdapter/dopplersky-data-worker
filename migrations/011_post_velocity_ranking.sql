-- Rank an account's posts by virality — peak interactions gained per hour —
-- without recomputing from the sample time series on every request.
--
-- Total interactions (migration 010) answers "which posts are biggest". It does
-- not answer "which posts took off": a slow evergreen post and an overnight
-- viral hit can share a lifetime total. Peak velocity is the steepest sustained
-- rise the dense post-launch replay observed (design note) — the signal that
-- makes "what happened to make this one spike" a rankable question.
--
--   * peak_interactions_per_hour mirrors the replay view's `peakPerHour`
--     (dopplersky-web `replay-metrics.ts`): the maximum of
--     Δinteractions / Δhours across consecutive samples. The web view uses raw
--     consecutive pairs; this stored ranking value additionally FLOORS the
--     interval at 600s so a lone like inside a 30-second early sample cannot
--     read as thousands/hour. The two therefore agree once the post has any
--     sample gap of ten minutes or more, which every tracked post reaches
--     within its first hour on the launch ladder.
--   * peak_velocity_at_seconds is the post age (from posts.created_at) at the
--     end of that peak interval — the replay's `peakAtSeconds`, i.e. "time to
--     peak". NULL whenever the peak itself is NULL.
--
-- Only posts with at least one qualifying (>=600s) interval and a positive gain
-- get a value; a post that was tracked but never rose, or has only sub-floor
-- samples so far, stays NULL and sorts last — never a fabricated zero. Older
-- posts discovered before enrollment have no dense early series and so no peak,
-- exactly as their replay page already shows. All analytics.*.

ALTER TABLE analytics.post_current_metrics
  ADD COLUMN IF NOT EXISTS peak_interactions_per_hour double precision;

ALTER TABLE analytics.post_current_metrics
  ADD COLUMN IF NOT EXISTS peak_velocity_at_seconds integer;

-- One-time backfill from the existing sample series. Set-based over every post's
-- samples: window the per-interval rate, keep intervals at least the floor long
-- with a positive gain, take the steepest per post. Local dataset only; a
-- production run would batch this rather than one statement.
WITH rated AS (
  SELECT
    sample.uri,
    sample.sampled_at,
    lag(sample.sampled_at) OVER w AS prev_at,
    (
      (sample.likes + sample.replies + sample.quotes + sample.reposts)
      - lag(sample.likes + sample.replies + sample.quotes + sample.reposts) OVER w
    )::double precision AS gain,
    extract(epoch FROM (sample.sampled_at - lag(sample.sampled_at) OVER w)) AS interval_seconds
  FROM analytics.post_metric_samples sample
  WINDOW w AS (PARTITION BY sample.uri ORDER BY sample.sampled_at)
),
qualified AS (
  SELECT
    uri,
    sampled_at,
    gain / (interval_seconds / 3600.0) AS rate
  FROM rated
  WHERE prev_at IS NOT NULL
    AND interval_seconds >= 600
    AND gain > 0
),
peak AS (
  SELECT DISTINCT ON (uri)
    uri,
    rate,
    sampled_at
  FROM qualified
  ORDER BY uri, rate DESC
)
UPDATE analytics.post_current_metrics metric
SET
  peak_interactions_per_hour = peak.rate,
  peak_velocity_at_seconds = GREATEST(
    0,
    extract(epoch FROM (peak.sampled_at - post.created_at))
  )::integer
FROM peak
JOIN analytics.posts post ON post.uri = peak.uri
WHERE peak.uri = metric.uri;

-- Ranking index: account first (equality), peak descending (order). Partial on
-- both columns non-null so unscored posts never bloat it and NULLS LAST scans
-- stop at the page, mirroring the interactions index in migration 010.
CREATE INDEX IF NOT EXISTS post_current_metrics_account_peak_idx
  ON analytics.post_current_metrics (account_did, peak_interactions_per_hour DESC)
  WHERE account_did IS NOT NULL AND peak_interactions_per_hour IS NOT NULL;
