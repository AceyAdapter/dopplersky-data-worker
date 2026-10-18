-- Audience v2 (D17): hydrate engager profiles so the audience can be ranked by
-- follower size ("who in my audience is a big account"). The engagement/graph
-- endpoints return no counts (only getProfiles does), so the bounded
-- `account.audience` scan does one getProfiles pass over its top engagers and
-- stores the counts here. NULL means not yet hydrated, never a measured zero.

ALTER TABLE analytics.actors
  ADD COLUMN IF NOT EXISTS followers_count bigint,
  ADD COLUMN IF NOT EXISTS following_count bigint,
  ADD COLUMN IF NOT EXISTS posts_count bigint,
  ADD COLUMN IF NOT EXISTS profile_hydrated_at timestamptz;

INSERT INTO analytics.schema_migrations (version)
VALUES ('013_audience_profile')
ON CONFLICT (version) DO NOTHING;
