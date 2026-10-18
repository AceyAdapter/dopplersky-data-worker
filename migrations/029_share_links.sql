-- Short share links for one post's replay (2026-09-17).
--
-- ## Why a table now, when the feature shipped stateless
--
-- `docs/decisions.md` (2026-09-14) chose a sealed token over a stored row, and
-- named the trade explicitly: "if per-link revocation is ever wanted, that is the
-- moment to add the table". The operator asked for the table for a different
-- reason — the sealed form is a 152-character base64 blob, so a link pasted into
-- a Bluesky reply reads as machine output and eats 159 of the 300 available
-- characters. Readability of a share URL IS the feature. A 12-character slug
-- fixes both, and revocation, click counts and per-link audit come with it.
--
-- Old `v1.*` tokens keep resolving: the web layer keeps its decrypt branch and
-- still mints nothing into it. This table is additive.
--
-- ## Why `public` and not `analytics`
--
-- `analytics` is the worker's own schema for collected protocol data. This is a
-- web-layer record about what the operator chose to publish — the same category
-- as `auth.app_user`. `public` is currently the retired legacy schema, which this
-- stack now owns (cutover 2026-09-13), so new application tables land there.
--
-- ## Why `post_uri` is UNIQUE
--
-- One post has at most one share link. Re-minting returns the existing row rather
-- than piling up a second slug for the same post, so an operator who shares the
-- same post twice pastes the same URL and any reply already carrying it keeps
-- working. That uniqueness is also the idempotence story for a double-click on
-- the share control.
--
-- The slug is generated in the API (`dopplersky-api`), not here: a 12-character
-- base62 string is 72 bits, which is unguessable at any realistic request rate
-- and is what buys unlistedness in place of confidentiality. Nothing in this
-- schema can lengthen or shorten it.

CREATE TABLE IF NOT EXISTS public.share_links (
  -- Primary key because every read is "resolve this slug": a PK lookup, not a scan.
  slug text PRIMARY KEY,
  post_uri text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- The DID that asked for the link. Audit only: it is not consulted on read, and
  -- reads are public, because the page shows one public post's public counters.
  minted_by text
);

-- Defense in depth on the alphabet. The API only ever generates base62, so a row
-- that violates this could only arrive by hand — and a hand-inserted `/r/../../`
-- would be a path problem rather than a data problem.
ALTER TABLE public.share_links
  DROP CONSTRAINT IF EXISTS share_links_slug_shape;
ALTER TABLE public.share_links
  ADD CONSTRAINT share_links_slug_shape CHECK (slug ~ '^[0-9A-Za-z]{8,32}$');

INSERT INTO analytics.schema_migrations (version)
VALUES ('029_share_links')
ON CONFLICT (version) DO NOTHING;
