-- Contract phase of the auth.app_user change (migration 022).
--
-- 022 created `auth.app_user` and backfilled it, deliberately leaving
-- `auth.subscription` in place so the API container still running the old code
-- kept working through the rolling deploy. Both services are now on the new
-- code — the API reads and writes `auth.app_user` only, and `dopplersky-web`
-- calls `/users/*` (confirmed in production: PUT and GET /users/:did returning
-- 200 after the deploy) — so the old table is retired here.
--
-- Re-run the backfill first. Anything written to `auth.subscription` during the
-- deploy window (an activation served by the old container) would otherwise be
-- lost, and this is the last moment it can be carried over. `DO NOTHING` on
-- conflict is the same first-activation-wins guard as 022: a real row in
-- app_user always wins over the retired table.

INSERT INTO auth.app_user (
  did, plan, status, trial_started_at, trial_expires_at,
  first_seen_at, last_sign_in_at, sign_in_count, created_at, updated_at
)
SELECT
  did, plan, status, trial_started_at, trial_expires_at,
  created_at, updated_at, 1, created_at, updated_at
FROM auth.subscription
ON CONFLICT (did) DO NOTHING;

DROP TABLE IF EXISTS auth.subscription;

INSERT INTO analytics.schema_migrations (version)
VALUES ('023_drop_subscription')
ON CONFLICT (version) DO NOTHING;
