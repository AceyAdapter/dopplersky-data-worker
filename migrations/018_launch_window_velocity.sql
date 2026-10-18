-- Rank an account's posts by how well they launched — the AVERAGE interactions
-- gained per hour across the post's first 24 hours — rather than by the single
-- steepest interval (peak velocity, migration 011).
--
-- Peak velocity answers "what was the sharpest spike". That is exactly the
-- signal a bought burst of engagement games: a few hundred fake likes in one
-- hour set a peak/hour nothing organic touches, even when the post never really
-- took off. The launch-window average dilutes that same burst across the whole
-- day, so a post that gained steadily beats a post with one purchased spike and
-- an otherwise flat curve. It is the "did this post take off well", not "what
-- was its highest moment", lens (operator call, 2026-08-31).
--
--   * launch_window_interactions is the cumulative interactions
--     (likes+replies+quotes+reposts) observed at the LAST sample within the
--     first 24 hours of the post's life (from posts.created_at). A post starts
--     at zero interactions at creation, so this IS the interactions gained in
--     the launch window. The displayed/ranked figure is a RATE derived at read
--     time by the API: this count / min(24h, hours-since-posted), floored at 1h.
--
-- Storing the WINDOW COUNT (not a precomputed rate) is deliberate:
--   - It auto-finalizes with no timer. While the post is under 24h old the
--     read-time denominator (elapsed hours) grows, so the rate is a live
--     "average so far"; once the post passes 24h the denominator locks at 24
--     and the value freezes — even for a post that went quiet at hour 20 and
--     stopped producing samples (samples are only written on change). A stored
--     rate would freeze at that stale 20h denominator instead.
--   - The API derives "launch window complete" from now() - created_at >= 24h,
--     so no second column and no exact-24h re-write is needed.
--
-- NULL whenever no sample landed inside the first 24 hours — a pre-enrollment
-- post discovered after its launch window closed has no launch data and stays
-- NULL, sorting last, never a fabricated zero. Peak velocity (migration 011)
-- stays populated and is kept as a secondary "peaked at" detail. All analytics.*.

ALTER TABLE analytics.post_current_metrics
  ADD COLUMN IF NOT EXISTS launch_window_interactions bigint;

-- One-time backfill from the existing sample series. For each post, the last
-- sample whose age is within the 24h launch window carries the cumulative
-- interactions gained in that window. Set-based; a production run would batch
-- this rather than run it as one statement over the whole table.
UPDATE analytics.post_current_metrics metric
SET launch_window_interactions = w.interactions
FROM (
  SELECT DISTINCT ON (sample.uri)
    sample.uri,
    (sample.likes + sample.replies + sample.quotes + sample.reposts) AS interactions
  FROM analytics.post_metric_samples sample
  JOIN analytics.posts post ON post.uri = sample.uri
  WHERE sample.sampled_at <= post.created_at + INTERVAL '24 hours'
  ORDER BY sample.uri, sample.sampled_at DESC
) w
WHERE w.uri = metric.uri;

-- Ranking indexes, mirroring the peak indexes (migrations 011/016). The read
-- orders by a rate computed from now(), which the planner cannot serve straight
-- from a static column index; but for the mature majority (age >= 24h) the
-- denominator is the constant 24, so the rate is monotonic in this count and
-- these partial indexes drive the prefilter + coarse order, with the sort step
-- only reshuffling the handful of posts still inside their launch window. Both
-- are partial on the count being non-null so unscored posts never bloat them.

-- Account-first (equality) then count descending — the per-account virality sort.
CREATE INDEX IF NOT EXISTS post_current_metrics_account_launch_idx
  ON analytics.post_current_metrics (account_did, launch_window_interactions DESC)
  WHERE account_did IS NOT NULL AND launch_window_interactions IS NOT NULL;

-- Account-agnostic analog for the cross-account homepage /posts/top_movers feed.
CREATE INDEX IF NOT EXISTS post_current_metrics_launch_idx
  ON analytics.post_current_metrics (launch_window_interactions DESC)
  WHERE launch_window_interactions IS NOT NULL;
