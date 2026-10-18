-- Email capture + the user-facing notification ledger (2026-09-17).
--
-- ## Why there is an email column at all
--
-- There was nowhere to send a message. `auth.app_user` is provisioned from
-- Bluesky sign-in, which yields a DID, a handle, a display name and an avatar —
-- and no address, because the AT Protocol never exposes an account's email. So a
-- mail integration with no capture is dead code: it has no recipients. These
-- columns are what make the notification pass able to address anybody.
--
-- `email` is null until the account owner types one in on their account page,
-- and clearing it is the unsubscribe. Presence IS the consent: the only way it
-- becomes non-null is that person asking, on a form that says what it is for. No
-- separate opt-in flag, because two fields that can disagree about consent is
-- worse than one that cannot.
--
-- Deliberately NOT recorded here: no verification token, so nothing stops a typo
-- or a third party's address being entered. At this volume that is a known,
-- bounded trade (a bounce, not a breach), and double opt-in is the follow-up if
-- deliverability ever matters. Do not quietly treat a stored address as verified.
--
-- ## The ledger
--
-- One row per (did, kind, window) that has been SENT. Uniqueness is the whole
-- idempotence story: the dispatch job runs hourly, a deploy restarts the worker
-- mid-pass, and an operator may run the pass by hand while the scheduled one is
-- in flight — and a person must still receive each lifecycle message once.
-- `ON CONFLICT DO NOTHING` on this constraint is what makes the claim atomic, so
-- two concurrent passes cannot both send.
--
-- `window_key` is the trial window the message is about (its `trial_expires_at`
-- as an ISO string) rather than a constant like 'once'. `reset-trial <did>` hands
-- an operator a way to give someone a fresh trial, and that fresh window has to
-- be able to send its own messages; a fixed key would mute the second trial
-- forever.
--
-- Only delivered messages keep a row. The claim and the delivery are the same
-- row, so a send that throws deletes its claim and the next pass retries, rather
-- than a failure being swallowed by an already-present record.
--
-- Read and written by `dopplersky-api`, which owns reads of `auth.app_user`; the
-- schema is created here because this service owns it.
ALTER TABLE auth.app_user
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS email_updated_at timestamptz;

CREATE TABLE IF NOT EXISTS auth.notification (
  id bigserial PRIMARY KEY,
  did text NOT NULL REFERENCES auth.app_user (did) ON DELETE CASCADE,
  kind text NOT NULL,
  window_key text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  provider text,
  provider_message_id text,
  CONSTRAINT notification_did_kind_window_key_key UNIQUE (did, kind, window_key)
);

-- "what has this account been told, newest first" — the operator question, and
-- the reason this table is worth keeping at all.
CREATE INDEX IF NOT EXISTS notification_did_sent_at_idx
  ON auth.notification (did, sent_at DESC);

-- The notification pass only ever wants accounts that have an address and a
-- trial window in play; both are partial, because most rows have neither.
CREATE INDEX IF NOT EXISTS app_user_email_idx
  ON auth.app_user (did)
  WHERE email IS NOT NULL;

INSERT INTO analytics.schema_migrations (version)
VALUES ('028_notification')
ON CONFLICT (version) DO NOTHING;
