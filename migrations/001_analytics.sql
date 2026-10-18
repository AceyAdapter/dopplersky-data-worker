CREATE SCHEMA IF NOT EXISTS analytics;

CREATE TABLE IF NOT EXISTS analytics.schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analytics.actors (
  did text PRIMARY KEY,
  handle text,
  display_name text,
  avatar_url text,
  repo_status text NOT NULL DEFAULT 'active',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analytics.tracked_accounts (
  did text PRIMARY KEY REFERENCES analytics.actors(did) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  priority smallint NOT NULL DEFAULT 50,
  posts_backfilled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analytics.account_metric_samples (
  did text NOT NULL REFERENCES analytics.actors(did) ON DELETE CASCADE,
  sampled_at timestamptz NOT NULL,
  followers bigint NOT NULL,
  following bigint NOT NULL,
  posts bigint NOT NULL,
  likes bigint,
  replies bigint,
  quotes bigint,
  reposts bigint,
  source text NOT NULL DEFAULT 'appview',
  PRIMARY KEY (did, sampled_at)
) PARTITION BY RANGE (sampled_at);

CREATE TABLE IF NOT EXISTS analytics.account_metric_samples_default
  PARTITION OF analytics.account_metric_samples DEFAULT;

CREATE TABLE IF NOT EXISTS analytics.posts (
  uri text PRIMARY KEY,
  cid text NOT NULL,
  author_did text NOT NULL REFERENCES analytics.actors(did),
  created_at timestamptz NOT NULL,
  indexed_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analytics.tracked_posts (
  uri text PRIMARY KEY REFERENCES analytics.posts(uri) ON DELETE CASCADE,
  account_did text REFERENCES analytics.tracked_accounts(did) ON DELETE CASCADE,
  reason text NOT NULL CHECK (reason IN ('account', 'explicit')),
  enabled boolean NOT NULL DEFAULT true,
  last_changed_at timestamptz,
  next_poll_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tracked_posts_due_idx
  ON analytics.tracked_posts (next_poll_at)
  WHERE enabled;

CREATE TABLE IF NOT EXISTS analytics.post_metric_samples (
  uri text NOT NULL REFERENCES analytics.posts(uri) ON DELETE CASCADE,
  sampled_at timestamptz NOT NULL,
  likes bigint NOT NULL,
  replies bigint NOT NULL,
  quotes bigint NOT NULL,
  reposts bigint NOT NULL,
  source text NOT NULL DEFAULT 'appview',
  PRIMARY KEY (uri, sampled_at)
) PARTITION BY RANGE (sampled_at);

CREATE TABLE IF NOT EXISTS analytics.post_metric_samples_default
  PARTITION OF analytics.post_metric_samples DEFAULT;

CREATE TABLE IF NOT EXISTS analytics.audience_cohorts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_did text NOT NULL REFERENCES analytics.tracked_accounts(did) ON DELETE CASCADE,
  method text NOT NULL,
  population_size bigint NOT NULL,
  sample_size integer NOT NULL,
  scan_complete boolean NOT NULL,
  seed text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analytics.audience_members (
  target_did text NOT NULL REFERENCES analytics.tracked_accounts(did) ON DELETE CASCADE,
  actor_did text NOT NULL REFERENCES analytics.actors(did) ON DELETE CASCADE,
  is_follower boolean,
  is_engager boolean NOT NULL DEFAULT false,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (target_did, actor_did)
);

CREATE INDEX IF NOT EXISTS audience_members_actor_idx
  ON analytics.audience_members (actor_did);

CREATE TABLE IF NOT EXISTS analytics.audience_cohort_members (
  cohort_id uuid NOT NULL REFERENCES analytics.audience_cohorts(id) ON DELETE CASCADE,
  actor_did text NOT NULL REFERENCES analytics.actors(did) ON DELETE CASCADE,
  inclusion_probability double precision NOT NULL
    CHECK (inclusion_probability > 0 AND inclusion_probability <= 1),
  PRIMARY KEY (cohort_id, actor_did)
);

CREATE INDEX IF NOT EXISTS audience_cohort_members_actor_idx
  ON analytics.audience_cohort_members (actor_did);

CREATE TABLE IF NOT EXISTS analytics.protocol_activity (
  record_uri text PRIMARY KEY,
  actor_did text NOT NULL REFERENCES analytics.actors(did) ON DELETE CASCADE,
  collection text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('post', 'reply', 'quote', 'like', 'repost', 'follow')),
  subject_uri text,
  cid text,
  occurred_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT true,
  live boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS protocol_activity_actor_time_idx
  ON analytics.protocol_activity (actor_did, occurred_at)
  WHERE active;

CREATE TABLE IF NOT EXISTS analytics.engagement_edges (
  post_uri text NOT NULL,
  actor_did text NOT NULL REFERENCES analytics.actors(did) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('reply', 'quote', 'like', 'repost')),
  record_uri text,
  occurred_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_uri, actor_did, kind)
);

CREATE INDEX IF NOT EXISTS engagement_edges_actor_idx
  ON analytics.engagement_edges (actor_did, active);

CREATE TABLE IF NOT EXISTS analytics.engagement_scan_status (
  post_uri text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('reply', 'quote', 'like', 'repost')),
  enumerated integer NOT NULL,
  complete boolean NOT NULL,
  continuation_cursor text,
  scanned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_uri, kind)
);

CREATE TABLE IF NOT EXISTS analytics.jobs (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  subject text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text NOT NULL UNIQUE,
  priority smallint NOT NULL DEFAULT 50,
  due_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  leased_by text,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jobs_claim_idx
  ON analytics.jobs (due_at, priority DESC)
  WHERE leased_by IS NULL;

CREATE TABLE IF NOT EXISTS analytics.sync_outbox (
  id bigserial PRIMARY KEY,
  event_type text NOT NULL,
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);

CREATE INDEX IF NOT EXISTS sync_outbox_pending_idx
  ON analytics.sync_outbox (id)
  WHERE delivered_at IS NULL;

CREATE OR REPLACE VIEW analytics.account_growth_daily AS
WITH daily AS (
  SELECT DISTINCT ON (did, sampled_at::date)
    did,
    sampled_at::date AS date,
    followers,
    following,
    posts,
    likes,
    replies,
    quotes,
    reposts
  FROM analytics.account_metric_samples
  ORDER BY did, sampled_at::date, sampled_at DESC
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

CREATE OR REPLACE VIEW analytics.post_replay AS
SELECT
  sample.uri,
  sample.sampled_at,
  sample.sampled_at - post.created_at AS post_age,
  sample.likes,
  sample.replies,
  sample.quotes,
  sample.reposts,
  sample.likes - lag(sample.likes) OVER replay AS likes_delta,
  sample.replies - lag(sample.replies) OVER replay AS replies_delta,
  sample.quotes - lag(sample.quotes) OVER replay AS quotes_delta,
  sample.reposts - lag(sample.reposts) OVER replay AS reposts_delta
FROM analytics.post_metric_samples sample
JOIN analytics.posts post ON post.uri = sample.uri
WINDOW replay AS (PARTITION BY sample.uri ORDER BY sample.sampled_at);

CREATE OR REPLACE VIEW analytics.audience_activity_hour_of_week AS
WITH latest_cohort AS (
  SELECT DISTINCT ON (target_did)
    id,
    target_did,
    scan_complete
  FROM analytics.audience_cohorts
  ORDER BY target_did, created_at DESC, id DESC
), audience AS (
  SELECT
    cohort.target_did,
    member.actor_did,
    'follower_sample'::text AS segment,
    member.inclusion_probability,
    cohort.scan_complete AS sample_is_complete
  FROM latest_cohort cohort
  JOIN analytics.audience_cohort_members member ON member.cohort_id = cohort.id

  UNION ALL

  SELECT
    member.target_did,
    member.actor_did,
    CASE member.is_follower
      WHEN true THEN 'follower_engager'
      WHEN false THEN 'non_follower_engager'
      ELSE 'unresolved_engager'
    END AS segment,
    1::double precision AS inclusion_probability,
    true AS sample_is_complete
  FROM analytics.audience_members member
  WHERE member.is_engager
)
SELECT
  audience.target_did,
  audience.segment,
  extract(isodow FROM activity.occurred_at)::smallint AS iso_weekday,
  extract(hour FROM activity.occurred_at)::smallint AS utc_hour,
  count(*) AS activity_events,
  count(DISTINCT activity.actor_did) AS active_sample_members,
  bool_and(audience.sample_is_complete) AS sample_is_complete,
  CASE
    WHEN bool_and(audience.sample_is_complete)
      THEN sum(1.0 / audience.inclusion_probability)
    ELSE NULL
  END AS weighted_activity
FROM analytics.protocol_activity activity
JOIN audience ON audience.actor_did = activity.actor_did
WHERE activity.active
GROUP BY audience.target_did, audience.segment, iso_weekday, utc_hour;

INSERT INTO analytics.schema_migrations (version)
VALUES ('001_analytics')
ON CONFLICT (version) DO NOTHING;
