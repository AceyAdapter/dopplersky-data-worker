-- "When they engage" grid: source it from real engagements, not the live-watch slice.
--
-- Operator call, 2026-09-11. `analytics.audience_activity_hour_of_week` counted
-- `analytics.protocol_activity` rows, and those exist only for DIDs currently
-- inside the Jetstream watch filter — AUDIENCE_WATCH_PER_TARGET (300) per
-- account, deduped under AUDIENCE_WATCH_GLOBAL_CAP (5,000), rotating toward
-- whoever engaged most recently (`audienceWatchDids`). Two consequences:
--
--   1. It was a running total with no normalisation for how long a bucket or a
--      DID had been observed, so it drifted with the watch list, not the audience.
--   2. The sample was tiny. On the account inspected, the page reported 62,285
--      engagers while the grid's whole week ("peak Thu 16:00") came from FOUR
--      watched accounts and 1,548 events.
--
-- `analytics.engagement_edges` already holds every engagement enumerated on the
-- account's scanned posts — likes, replies, quotes and reposts, each with the
-- engagement's own timestamp — covering thousands of actors per account (the same
-- source the roster's per-engager counts already use). The view now answers "when
-- do people engage with this account's posts", which is the question the panel's
-- copy asks and the one a poster can act on.
--
-- Follows are no longer part of the grid: an edge is an engagement with a post,
-- so the legend drops "follows" (the follower-acquisition view in migration 002
-- still reads protocol_activity and is untouched).
--
-- Reader contract is unchanged — `dopplersky-api/src/stores.ts` selects
-- target_did, iso_weekday, utc_hour, segment, activity_events and
-- active_sample_members. The two trailing columns the old view exposed
-- (`sample_is_complete`, `weighted_activity`) are gone: nothing read them, and
-- the sample-completeness notion belonged to the cohort path being replaced.
-- Dropping them is why this drops and recreates rather than replaces — the
-- migration runner wraps each file in one transaction, so readers never see a
-- missing view.

-- Support the new access path. `engagement_edges` lost its (post_uri, …) primary
-- key in migration 002 (it is keyed by `edge_key` now) and `posts` is only ever
-- joined by `uri`, so both joins were sequential scans. Partial on `active`
-- because the view filters there.
CREATE INDEX IF NOT EXISTS engagement_edges_post_active_idx
  ON analytics.engagement_edges (post_uri) WHERE active;

CREATE INDEX IF NOT EXISTS posts_author_idx
  ON analytics.posts (author_did);

DROP VIEW IF EXISTS analytics.audience_activity_hour_of_week;

CREATE VIEW analytics.audience_activity_hour_of_week AS
SELECT
  target_did,
  segment,
  extract(isodow FROM occurred_at)::smallint AS iso_weekday,
  extract(hour FROM occurred_at)::smallint AS utc_hour,
  count(*) AS activity_events,
  count(DISTINCT actor_did) AS active_sample_members
FROM (
  SELECT
    post.author_did AS target_did,
    edge.actor_did,
    edge.occurred_at,
    -- Segment stays the roster's follower split; an engager we never persisted
    -- to `audience_members` is reported as unresolved rather than dropped, since
    -- the engagement itself is real.
    CASE member.is_follower
      WHEN true THEN 'follower_engager'
      WHEN false THEN 'non_follower_engager'
      ELSE 'unresolved_engager'
    END AS segment
  FROM analytics.engagement_edges edge
  JOIN analytics.posts post ON post.uri = edge.post_uri
  LEFT JOIN analytics.audience_members member
    ON member.target_did = post.author_did
   AND member.actor_did = edge.actor_did
  WHERE edge.active
    AND edge.occurred_at IS NOT NULL
) routed
GROUP BY target_did, segment, iso_weekday, utc_hour;

INSERT INTO analytics.schema_migrations (version)
VALUES ('024_audience_activity_from_engagements')
ON CONFLICT (version) DO NOTHING;
