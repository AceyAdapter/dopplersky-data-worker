import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAnalyticsStore } from "./postgres-store.js";

// Never fall back to DATABASE_URL: this suite writes fixture rows. CI provisions
// this dedicated database; local runs opt in using TEST_DATABASE_URL.
const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl && new URL(databaseUrl).pathname !== "/dopplersky_worker_test") {
  throw new Error("TEST_DATABASE_URL must name the disposable dopplersky_worker_test database");
}

/**
 * Migration 027 exists to give the replay reconciliation's cohort scan an access
 * path. That is a property of the *plan*, not of the SQL string, so asserting it
 * against real PostgreSQL is the only thing that would notice the index going
 * away or the planner quietly falling back to a sequential scan of
 * `analytics.posts` — which is exactly how a 21 s cold start becomes a 6-minute
 * one again without any test turning red.
 */
describe.skipIf(!databaseUrl)("replay cohort scan uses its index", () => {
  let store: PostgresAnalyticsStore;
  const actorDid = "did:plc:replayindextest";
  const prefix = `at://${actorDid}/app.bsky.feed.post/`;
  // Selectivity is the whole point of this index: production qualifies ~2.9% of
  // `analytics.posts` (167.7k of 5.78M), and the planner only chooses the index
  // when the window is a small slice of the table. With a third of the rows
  // qualifying — which an earlier version of this test seeded — a sequential scan
  // is genuinely cheaper and the planner rightly ignores the index. So this seeds
  // the shape, not the size: a large mostly-old table with a small recent edge.
  const rows = 300_000;
  const recentRows = 300;

  beforeAll(async () => {
    store = new PostgresAnalyticsStore(databaseUrl!);
    await store.migrate();
    await store.pool.query(
      `INSERT INTO analytics.actors (did, handle)
       VALUES ($1, 'replay-index.test')
       ON CONFLICT (did) DO NOTHING`,
      [actorDid],
    );
    await store.pool.query(
      `INSERT INTO analytics.posts (uri, cid, author_did, created_at)
       SELECT $1 || g, 'test-cid', $3,
              now() - (g::float / $2::int) * interval '30 days'
       FROM generate_series(1, $2::int) g`,
      [`${prefix}recent-`, recentRows, actorDid],
    );
    // An older block so the index range is a real subset of the table.
    await store.pool.query(
      `INSERT INTO analytics.posts (uri, cid, author_did, created_at)
       SELECT $1 || g, 'test-cid', $3, now() - interval '400 days'
       FROM generate_series(1, $2::int) g`,
      [`${prefix}old-`, rows, actorDid],
    );
    await store.pool.query("ANALYZE analytics.posts");
  }, 60_000);

  // Cleanup is required, not tidiness: the other suites in this directory query
  // `analytics.posts` with a `created_at` cutoff, so a few hundred thousand
  // leftover fixture rows would change their results. Delete by `author_did`
  // (indexed) so it stays a bounded index scan, and give the teardown room: this
  // seeds a production-shaped table, and the default 10 s hook timeout is not
  // enough to remove it.
  afterAll(async () => {
    if (!store) return;
    try {
      await store.pool.query("DELETE FROM analytics.posts WHERE author_did = $1", [actorDid]);
      await store.pool.query("DELETE FROM analytics.actors WHERE did = $1", [actorDid]);
    } finally {
      await store.close();
    }
  }, 120_000);

  it("declares the (created_at, uri) index the reconciliation depends on", async () => {
    const { rows: indexRows } = await store.pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'posts' AND indexname = 'posts_created_uri_idx'",
    );
    expect(indexRows).toHaveLength(1);
    expect(indexRows[0]!.indexdef).toContain("(created_at, uri)");
  });

  it("answers the cohort window from the index, never a sequential scan", async () => {
    const { rows: planRows } = await store.pool.query<{ "QUERY PLAN": string }>(
      `EXPLAIN (ANALYZE, BUFFERS)
       SELECT uri FROM analytics.posts
       WHERE $1::timestamptz IS NOT NULL AND created_at > $1`,
      [new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString()],
    );
    const plan = planRows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(plan).toContain("posts_created_uri_idx");
    expect(plan).not.toMatch(/Seq Scan on posts/);
  });

  it("reconciles the cohort through the indexed plan", async () => {
    const { rows: planRows } = await store.pool.query<{ "QUERY PLAN": string }>(
      `EXPLAIN (ANALYZE, BUFFERS) ${replaySql()}`,
      [new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString()],
    );
    const plan = planRows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(plan).toContain("posts_created_uri_idx");
    expect(plan).not.toMatch(/Seq Scan on posts/);
  });
});

/** The cohort half of `ensureReplayJobs`, without the write. */
function replaySql(): string {
  return `SELECT tracked.uri
          FROM analytics.tracked_posts tracked
          LEFT JOIN (SELECT uri FROM analytics.posts WHERE created_at > $1) recent
            ON recent.uri = tracked.uri
          WHERE tracked.enabled AND (tracked.reason = 'explicit' OR recent.uri IS NOT NULL)`;
}
