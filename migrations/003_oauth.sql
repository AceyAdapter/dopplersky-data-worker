-- AT Protocol OAuth persistence for `dopplersky-web`'s sign-in flow.
--
-- The web service holds no database credentials, so its OAuth client
-- (@atproto/oauth-client-node) reaches these tables only through the API,
-- which guards them behind a server-to-server bearer token. Two stores,
-- matching the client's NodeSavedStateStore / NodeSavedSessionStore shapes.
--
-- This lives in a dedicated `auth` schema, deliberately independent of
-- `analytics.*`: a signed-in user is not necessarily a tracked account, and
-- authentication must not take a dependency on the collector's model.

CREATE SCHEMA IF NOT EXISTS auth;

-- Short-lived authorization-flow state (PKCE verifier, DPoP key, issuer,
-- nonce), keyed by the client's opaque state key. Written at /authorize,
-- read once at /callback, then deleted. `expires_at` bounds a stale/abandoned
-- flow (~1h) so it cannot be replayed; the index supports opportunistic sweeps.
CREATE TABLE IF NOT EXISTS auth.oauth_state (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_state_expires_at_idx ON auth.oauth_state (expires_at);

-- Long-lived session, keyed by the authenticated user's DID (the OAuth `sub`).
-- Holds the access/refresh tokens and DPoP key the client refreshes over time.
-- `did` is identity and never changes, so it is the stable primary key even as
-- the account's handle does (design note).
CREATE TABLE IF NOT EXISTS auth.oauth_session (
  sub text PRIMARY KEY,
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
