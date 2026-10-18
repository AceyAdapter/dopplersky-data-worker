-- Per-account audience scope (W41). Audience collection is bounded and exposes
-- individual engagers, so it is not run for every tracked account: `enabled`
-- governs core profile/post collection (free), while `audience_enabled` governs
-- the engager audience scan (the premium surface). The orchestrator only enqueues
-- `account.audience` for accounts that are BOTH enabled and audience_enabled, and
-- the global AUDIENCE_COLLECTION_ENABLED flag remains the kill-switch above both.
-- Default false: turning the feature on database-wide still scans nobody until a
-- DID is explicitly opted in (e.g. on a premium purchase).

ALTER TABLE analytics.tracked_accounts
  ADD COLUMN IF NOT EXISTS audience_enabled boolean NOT NULL DEFAULT false;

INSERT INTO analytics.schema_migrations (version)
VALUES ('014_audience_scope')
ON CONFLICT (version) DO NOTHING;
