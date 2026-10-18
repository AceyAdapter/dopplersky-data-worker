ALTER TABLE analytics.protocol_activity
  ADD COLUMN IF NOT EXISTS subject_did text;

ALTER TABLE analytics.engagement_edges
  ADD COLUMN IF NOT EXISTS edge_key text;

ALTER TABLE analytics.engagement_edges
  ADD COLUMN IF NOT EXISTS removed_at timestamptz;

UPDATE analytics.engagement_edges
SET edge_key = CASE
  WHEN kind IN ('reply', 'quote') AND record_uri IS NOT NULL
    THEN 'record:' || record_uri
  ELSE 'actor:' || post_uri || chr(31) || actor_did || chr(31) || kind
END
WHERE edge_key IS NULL;

ALTER TABLE analytics.engagement_edges
  ALTER COLUMN edge_key SET NOT NULL;

ALTER TABLE analytics.engagement_edges
  DROP CONSTRAINT IF EXISTS engagement_edges_pkey;

ALTER TABLE analytics.engagement_edges
  ADD CONSTRAINT engagement_edges_pkey PRIMARY KEY (edge_key);

CREATE INDEX IF NOT EXISTS engagement_edges_post_actor_idx
  ON analytics.engagement_edges (post_uri, actor_did, kind);

CREATE OR REPLACE VIEW analytics.post_replay_reconstructed AS
WITH changes AS (
  SELECT
    edge.post_uri AS uri,
    edge.occurred_at AS changed_at,
    edge.kind,
    1::bigint AS delta
  FROM analytics.engagement_edges edge
  WHERE edge.occurred_at IS NOT NULL

  UNION ALL

  SELECT
    edge.post_uri AS uri,
    edge.removed_at AS changed_at,
    edge.kind,
    (-1)::bigint AS delta
  FROM analytics.engagement_edges edge
  WHERE edge.removed_at IS NOT NULL
), buckets AS (
  SELECT
    uri,
    changed_at,
    sum(delta) FILTER (WHERE kind = 'like') AS likes_delta,
    sum(delta) FILTER (WHERE kind = 'reply') AS replies_delta,
    sum(delta) FILTER (WHERE kind = 'quote') AS quotes_delta,
    sum(delta) FILTER (WHERE kind = 'repost') AS reposts_delta
  FROM changes
  GROUP BY uri, changed_at
)
SELECT
  bucket.uri,
  bucket.changed_at,
  bucket.changed_at - post.created_at AS post_age,
  COALESCE(bucket.likes_delta, 0) AS likes_delta,
  COALESCE(bucket.replies_delta, 0) AS replies_delta,
  COALESCE(bucket.quotes_delta, 0) AS quotes_delta,
  COALESCE(bucket.reposts_delta, 0) AS reposts_delta,
  sum(COALESCE(bucket.likes_delta, 0)) OVER replay AS likes,
  sum(COALESCE(bucket.replies_delta, 0)) OVER replay AS replies,
  sum(COALESCE(bucket.quotes_delta, 0)) OVER replay AS quotes,
  sum(COALESCE(bucket.reposts_delta, 0)) OVER replay AS reposts
FROM buckets bucket
JOIN analytics.posts post ON post.uri = bucket.uri
WINDOW replay AS (
  PARTITION BY bucket.uri
  ORDER BY bucket.changed_at
  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
);

CREATE OR REPLACE VIEW analytics.account_engagement_reconstructed_daily AS
WITH changes AS (
  SELECT
    post.author_did AS did,
    edge.occurred_at::date AS date,
    edge.kind,
    1::bigint AS delta
  FROM analytics.engagement_edges edge
  JOIN analytics.posts post ON post.uri = edge.post_uri
  WHERE edge.occurred_at IS NOT NULL

  UNION ALL

  SELECT
    post.author_did AS did,
    edge.removed_at::date AS date,
    edge.kind,
    (-1)::bigint AS delta
  FROM analytics.engagement_edges edge
  JOIN analytics.posts post ON post.uri = edge.post_uri
  WHERE edge.removed_at IS NOT NULL
), daily AS (
  SELECT
    did,
    date,
    COALESCE(sum(delta) FILTER (WHERE kind = 'like'), 0) AS likes_delta,
    COALESCE(sum(delta) FILTER (WHERE kind = 'reply'), 0) AS replies_delta,
    COALESCE(sum(delta) FILTER (WHERE kind = 'quote'), 0) AS quotes_delta,
    COALESCE(sum(delta) FILTER (WHERE kind = 'repost'), 0) AS reposts_delta
  FROM changes
  GROUP BY did, date
)
SELECT
  daily.*,
  sum(likes_delta) OVER actor_time AS likes,
  sum(replies_delta) OVER actor_time AS replies,
  sum(quotes_delta) OVER actor_time AS quotes,
  sum(reposts_delta) OVER actor_time AS reposts
FROM daily
WINDOW actor_time AS (
  PARTITION BY did
  ORDER BY date
  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
);

CREATE OR REPLACE VIEW analytics.audience_follower_acquisition_daily AS
WITH latest_cohort AS (
  SELECT DISTINCT ON (target_did)
    id,
    target_did,
    population_size,
    sample_size,
    scan_complete
  FROM analytics.audience_cohorts
  ORDER BY target_did, created_at DESC, id DESC
), daily AS (
  SELECT
    cohort.target_did,
    activity.occurred_at::date AS date,
    cohort.population_size,
    cohort.sample_size,
    cohort.scan_complete,
    count(*)::bigint AS sample_followers_acquired,
    CASE
      WHEN cohort.scan_complete
        THEN sum(1.0 / member.inclusion_probability)
      ELSE NULL
    END AS estimated_followers_acquired
  FROM latest_cohort cohort
  JOIN analytics.audience_cohort_members member ON member.cohort_id = cohort.id
  JOIN analytics.protocol_activity activity
    ON activity.actor_did = member.actor_did
   AND activity.kind = 'follow'
   AND activity.subject_did = cohort.target_did
   AND activity.active
  GROUP BY
    cohort.target_did,
    activity.occurred_at::date,
    cohort.population_size,
    cohort.sample_size,
    cohort.scan_complete
)
SELECT
  daily.*,
  sum(sample_followers_acquired) OVER acquisition AS sample_followers_by_date,
  CASE
    WHEN scan_complete THEN sum(estimated_followers_acquired) OVER acquisition
    ELSE NULL
  END AS estimated_surviving_followers_by_date
FROM daily
WINDOW acquisition AS (
  PARTITION BY target_did
  ORDER BY date
  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
);
