-- Subscription / free-trial state for the premium tier.
--
-- The landing page sells a $20/month premium offering with a no-card, 7-day
-- free trial that the visitor must *actively click to activate* — the operator
-- wants the activation click itself as a conversion signal, not an implicit
-- "trial started the moment you signed in". This table records that click.
--
-- It lives in the `auth` schema next to `oauth_session` (migration 003), for the
-- same reason: a signed-in user is an identity, not necessarily a tracked
-- account, and entitlement must not take a dependency on the collector's
-- `analytics.*` model. Keyed by DID — `did` is durable identity and never
-- changes even as the handle does (design note).
--
-- Scope note: this stores the *state* only. There is no billing here yet — no
-- card, no processor, no charge. `status` therefore only ever holds 'trialing'
-- today; 'active'/'expired'/'canceled' are reserved for when real billing lands
-- so consumers can be written against the final shape now. Writes go through the
-- API's bearer-guarded server-to-server route; the web service holds no DB
-- credentials.

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.subscription (
  -- The authenticated user's DID (the OAuth `sub`). Stable primary key.
  did text PRIMARY KEY,
  -- Which plan the trial/subscription is for. One tier today ('premium').
  plan text NOT NULL DEFAULT 'premium',
  -- 'trialing' while inside the free window; the rest are reserved for billing.
  status text NOT NULL DEFAULT 'trialing',
  -- When the trial was activated (the tracked click) and when it lapses. Set
  -- once on first activation and never moved — re-clicking Activate must not
  -- extend the window, so the first-activation timestamp stays the true
  -- conversion signal.
  trial_started_at timestamptz,
  trial_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Trials expiring soon / recently — the query behind "who is mid-trial" and any
-- future lapse sweep. Partial: only rows with a trial window are of interest.
CREATE INDEX IF NOT EXISTS subscription_trial_expires_at_idx
  ON auth.subscription (trial_expires_at)
  WHERE trial_expires_at IS NOT NULL;
