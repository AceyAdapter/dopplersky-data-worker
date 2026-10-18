-- One row per authenticated user (auth.app_user) — identity + entitlement.
--
-- Why this supersedes migration 017's `auth.subscription`: the operator wants an
-- actual row for every user who signs in, not one that materialises the first
-- time somebody clicks "start trial" (2026-09-11). The trial window still lives
-- on that row, so activation is an UPDATE of a row that already exists rather
-- than an INSERT that creates the user, and there is exactly one source of
-- truth for "is this user premium".
--
-- Scope: this stores state only. There is still no billing — no card, no
-- processor, no charge — so `status` is 'none' for a signed-in user who has not
-- activated, 'trialing' inside the free window, and 'active'/'expired'/'canceled'
-- are reserved for when real payment lands so consumers can be written against
-- the final shape now.
--
-- It lives in `auth` next to `oauth_session` (migration 003) for the same
-- reason: a signed-in user is an identity, not necessarily a tracked account,
-- and entitlement must not take a dependency on the collector's `analytics.*`
-- model. Keyed by DID — `did` is durable identity and never changes even as the
-- handle does (design note). Writes go through the API's bearer-guarded
-- server-to-server routes; the web service holds no DB credentials.
--
-- Expand/contract: this migration only CREATES and BACKFILLS. `auth.subscription`
-- is deliberately left in place so the API container still running the old code
-- keeps working through the deploy window (worker migrations land before the API
-- image is recreated). It is dropped by migration 023, in a later push once the
-- API + web no longer read it.

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.app_user (
  -- The authenticated user's DID (the OAuth `sub`). Stable primary key.
  did text PRIMARY KEY,
  -- Last identity we saw for this DID, refreshed on every sign-in. Denormalised
  -- on purpose: the operator wants to read the user table without joining the
  -- collector's model, and handle is mutable so this is explicitly a cache.
  handle text,
  display_name text,
  avatar_url text,
  -- Sign-in history. `first_seen_at` is row creation; `last_sign_in_at` and
  -- `sign_in_count` move on every completed OAuth callback.
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_sign_in_at timestamptz,
  sign_in_count integer NOT NULL DEFAULT 0,
  -- Which plan the trial/subscription is for. One tier today ('premium').
  plan text NOT NULL DEFAULT 'premium',
  -- 'none' until a trial is activated — the state of every signed-in user who
  -- has not clicked. The rest are the reserved billing lifecycle.
  status text NOT NULL DEFAULT 'none'
    CHECK (status IN ('none', 'trialing', 'active', 'expired', 'canceled')),
  -- When the trial was activated (the tracked click) and when it lapses. Set
  -- once on first activation and never moved — re-clicking Activate must not
  -- extend the window, so the first-activation timestamp stays the true
  -- conversion signal.
  trial_started_at timestamptz,
  trial_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Trials expiring soon / recently — the query behind "who is mid-trial".
-- Partial: only rows with a trial window are of interest.
CREATE INDEX IF NOT EXISTS app_user_trial_expires_at_idx
  ON auth.app_user (trial_expires_at)
  WHERE trial_expires_at IS NOT NULL;

-- Carry over every row migration 017 wrote. In production this is the small set
-- of users who already activated a trial; their window and activation timestamp
-- are preserved exactly, so nobody's trial restarts or extends across this
-- change. `sign_in_count` starts at 1: the row exists because they signed in.
INSERT INTO auth.app_user (
  did, plan, status, trial_started_at, trial_expires_at,
  first_seen_at, last_sign_in_at, sign_in_count, created_at, updated_at
)
SELECT
  did, plan, status, trial_started_at, trial_expires_at,
  created_at, updated_at, 1, created_at, updated_at
FROM auth.subscription
ON CONFLICT (did) DO NOTHING;

-- Every signed-in user already has a credential row (auth.oauth_session) even
-- when they never activated a trial — that is exactly the population this
-- migration exists to give a user row. Identity fields stay NULL here; they fill
-- in on the next sign-in through the web's provisioning call.
INSERT INTO auth.app_user (
  did, first_seen_at, last_sign_in_at, sign_in_count, created_at, updated_at
)
SELECT sub, created_at, updated_at, 1, created_at, updated_at
FROM auth.oauth_session
ON CONFLICT (did) DO NOTHING;

INSERT INTO analytics.schema_migrations (version)
VALUES ('022_app_user')
ON CONFLICT (version) DO NOTHING;
