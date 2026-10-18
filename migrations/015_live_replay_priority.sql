-- Account-owned post replay is the freshness-sensitive path. Keep it above the
-- bounded audience scan for its entire 30-day lifetime. Normalize restart jobs
-- too: a Docker outage may create catch-up debt, but it must not demote the same
-- post replay merely because bootstrap recreated it.

UPDATE analytics.jobs
SET priority = 75,
    updated_at = now()
WHERE kind = 'post.metrics'
  AND priority < 75
  AND payload ->> 'explicit' IS DISTINCT FROM 'true';

INSERT INTO analytics.schema_migrations (version)
VALUES ('015_live_replay_priority')
ON CONFLICT (version) DO NOTHING;
