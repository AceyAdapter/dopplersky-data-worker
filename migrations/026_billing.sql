-- Real billing state on `auth.app_user` (Polar, chosen 2026-09-13).
--
-- Why columns here rather than a billing table: entitlement is already ONE row
-- per authenticated DID, and "is this person premium" must stay a single read.
-- A separate table would put a join in front of every gated request and give the
-- question two homes. The trial columns stay exactly as they are — this ADDS the
-- subscription, it does not replace the trial.
--
-- Provider-agnostic on purpose. W12 shaped the retired `auth.subscription` with
-- `stripe_customer_id` / `stripe_subscription_id`; that naming is not repeated,
-- because the provider is a configuration choice and a switch must not be a
-- schema migration. `billing_provider` records who the row's ids belong to.
--
-- Raw, not derived: `billing_status` is the provider's own status verbatim
-- (active, trialing, past_due, canceled, revoked, ...) and `status` keeps the
-- coarse lifecycle the CHECK constraint already allows. Entitlement decides what
-- a status is worth against the clock, at read time, exactly as the trial window
-- does — nothing sweeps rows.
--
-- Additive and idempotent: existing rows keep NULL billing columns, and an
-- application that predates this migration keeps working unchanged.

ALTER TABLE auth.app_user
  ADD COLUMN IF NOT EXISTS billing_provider text,
  ADD COLUMN IF NOT EXISTS billing_customer_id text,
  ADD COLUMN IF NOT EXISTS billing_subscription_id text,
  ADD COLUMN IF NOT EXISTS billing_status text,
  ADD COLUMN IF NOT EXISTS billing_current_period_end timestamptz,
  ADD COLUMN IF NOT EXISTS billing_cancel_at_period_end boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS billing_updated_at timestamptz;

-- "Which account is this Polar customer?" during a webhook that carries no
-- external id, and the reconciliation query an operator would run by hand.
CREATE INDEX IF NOT EXISTS app_user_billing_customer_id_idx
  ON auth.app_user (billing_customer_id)
  WHERE billing_customer_id IS NOT NULL;

-- Who is paying: the query behind "subscribers and their renewal dates".
CREATE INDEX IF NOT EXISTS app_user_billing_period_end_idx
  ON auth.app_user (billing_current_period_end)
  WHERE billing_current_period_end IS NOT NULL;

INSERT INTO analytics.schema_migrations (version)
VALUES ('026_billing')
ON CONFLICT (version) DO NOTHING;
