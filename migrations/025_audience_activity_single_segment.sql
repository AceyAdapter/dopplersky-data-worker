-- Audience time grid: drop the per-segment split so the read stays cheap.
--
-- 024 made the grid count real engagements (`engagement_edges ⋈ posts`) and left
-- the roster's follower/non-follower split in place. Measuring it on the heaviest
-- account showed where the time went (2026-09-11, operator: "the query takes a
-- LONG time in the browser. Speed is important"):
--
--   roster query   1355 ms
--   this grid       654 ms  -> 169 ms once the segment join is not in the GROUP BY
--   summary          71 ms
--   sampled/enabled  ~4 ms
--
-- The 485 ms was the join to `audience_members` (one index probe per engagement)
-- plus grouping by the resulting CASE expression. No surface reads the split:
-- `dopplersky-web`'s `buildHeatmap` explicitly sums the segments ("the heatmap
-- answers 'when is my audience active', not 'which segment'"), so every cell it
-- renders is a sum over all segments. Carrying an unused dimension cost ~3/4 of
-- the grid's time.
--
-- The column stays, holding one value, so the reader contract the API selects
-- (`segment`) is unchanged and a per-segment view can return later as its own
-- query if a surface ever wants follower-vs-non-follower timing.
--
-- `active_sample_members` remains the distinct engagers behind each bucket.
-- Migration 024's indexes are unchanged and still drive this plan: posts by
-- author, then `engagement_edges_post_active_idx` per post.

DROP VIEW IF EXISTS analytics.audience_activity_hour_of_week;

CREATE VIEW analytics.audience_activity_hour_of_week AS
SELECT
  post.author_did AS target_did,
  'engager'::text AS segment,
  extract(isodow FROM edge.occurred_at)::smallint AS iso_weekday,
  extract(hour FROM edge.occurred_at)::smallint AS utc_hour,
  count(*) AS activity_events,
  count(DISTINCT edge.actor_did) AS active_sample_members
FROM analytics.engagement_edges edge
JOIN analytics.posts post ON post.uri = edge.post_uri
WHERE edge.active
  AND edge.occurred_at IS NOT NULL
GROUP BY post.author_did, iso_weekday, utc_hour;

INSERT INTO analytics.schema_migrations (version)
VALUES ('025_audience_activity_single_segment')
ON CONFLICT (version) DO NOTHING;
