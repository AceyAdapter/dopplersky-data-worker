# dopplersky-data-worker

The data-collection worker behind **Dopplersky**, a Bluesky analytics product
that ran from 2024 until it shut down in 2026. Published here as-is.

It collects public Bluesky data into Postgres and gives you a durable, leased
job queue to do it with:

- **Selective polling** of the public AppView for tracked accounts' profiles,
  post counters, and bounded graph/feed pages.
- **Forward-only Jetstream capture** of tracked authors and an opt-in engager
  cohort.
- **Cumulative lifetime counters**, never per-day deltas — everything downstream
  is derived by differencing rows, so a gap stays a gap and never becomes a zero.
- **`analytics.jobs`** — a leased queue with backoff and per-kind priority, in
  place of an external broker.

The repo carries all **29 migrations**, which are the whole schema (`analytics`
for collection, `auth` for accounts and the read side). The read API that sits on
top of it is a separate repo.

## Run it

Requires Node 22+ and Postgres 16.

```bash
npm ci
cp .env.example .env        # set DATABASE_URL
npm run migrate             # creates analytics + auth
npm run build && npm start
```

Useful verbs: `collect:once`, `track:account`, `track:post`.

Tests: `npm test`. The SQL integration suite needs `TEST_DATABASE_URL` pointing
at a disposable database; without it those tests skip.

## Read this before you run it

`docs/data-and-privacy.md` is the contract for what this collects: public
profiles, public post text and counters, and follower/engager membership for
sampled cohorts. If you point it at real accounts, you inherit the obligation to
disclose that and to pick a retention period — the code's default is to keep the
normalized rows indefinitely.

## Licence

MIT. The "Dopplersky" name and logo are not licensed with the code.
