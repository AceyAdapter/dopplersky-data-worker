import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAnalyticsStore } from "./postgres-store.js";

// Never fall back to DATABASE_URL: this suite writes fixture rows. CI provisions
// this dedicated database; local runs opt in using TEST_DATABASE_URL.
const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl && new URL(databaseUrl).pathname !== "/dopplersky_worker_test") {
  throw new Error("TEST_DATABASE_URL must name the disposable dopplersky_worker_test database");
}

/**
 * The batched ensure is three claims at once — a whole cohort in one statement,
 * exactly the sequential method's conflict policy, and a bounded statement size
 * — and every one of them is a property of the SQL, not of the JavaScript. This
 * suite runs it against the real migrations.
 */
describe.skipIf(!databaseUrl)("ensureJobs batching against real PostgreSQL", () => {
  let store: PostgresAnalyticsStore;
  const prefix = "at://did:plc:ensurejobstest/app.bsky.feed.post/";
  const dueAt = new Date("2026-09-15T14:07:50.000Z");

  const entry = (subject: string, priority = 75, due = dueAt) => ({
    kind: "post.metrics" as const,
    subject,
    dueAt: due,
    payload: { uri: subject },
    priority,
  });

  const rowFor = async (subject: string) => {
    const { rows } = await store.pool.query<{ priority: number; due_at: Date }>(
      "SELECT priority, due_at FROM analytics.jobs WHERE dedupe_key = $1",
      [`post.metrics:${subject}`],
    );
    return rows[0];
  };

  const countPrefixed = async (like: string) => {
    const { rows } = await store.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM analytics.jobs WHERE subject LIKE $1",
      [`${prefix}${like}%`],
    );
    return rows[0]!.n;
  };

  beforeAll(async () => {
    store = new PostgresAnalyticsStore(databaseUrl!);
    await store.migrate();
    await store.migrate(); // Migration runner must remain idempotent.
  }, 30_000);

  afterAll(async () => {
    if (!store) return;
    try {
      await store.pool.query("DELETE FROM analytics.jobs WHERE subject LIKE $1", [`${prefix}%`]);
    } finally {
      await store.close();
    }
  });

  it("inserts a full page of new jobs", async () => {
    await store.ensureJobs(Array.from({ length: 500 }, (_, i) => entry(`${prefix}page${i}`)));

    expect(await countPrefixed("page")).toBe(500);
    expect(await rowFor(`${prefix}page7`)).toMatchObject({ priority: 75 });
  });

  it("never pulls an existing schedule forward, and only raises priority", async () => {
    const subject = `${prefix}stable`;
    const scheduled = new Date(dueAt.getTime() + 3_600_000);
    await store.ensureJobs([entry(subject, 75, scheduled)]);

    // A later ensure with a lower priority and an earlier due time must change
    // neither: bootstrap re-asserts standing jobs on every restart, and an
    // ensure that moved due_at would silently re-run a whole cohort.
    await store.ensureJobs([entry(subject, 40, dueAt)]);
    expect(await rowFor(subject)).toMatchObject({ priority: 75 });
    expect((await rowFor(subject))!.due_at.toISOString()).toBe(scheduled.toISOString());

    await store.ensureJobs([entry(subject, 90, dueAt)]);
    expect(await rowFor(subject)).toMatchObject({ priority: 90 });
    expect((await rowFor(subject))!.due_at.toISOString()).toBe(scheduled.toISOString());
  });

  it("collapses a repeated key inside one statement instead of erroring", async () => {
    // Postgres refuses an ON CONFLICT that would touch the same row twice, so a
    // page carrying one key at two priorities has to arrive pre-collapsed.
    const subject = `${prefix}duplicate`;
    await store.ensureJobs([entry(subject, 55), entry(subject, 90)]);

    expect(await rowFor(subject)).toMatchObject({ priority: 90 });
    expect(await countPrefixed("duplicate")).toBe(1);
  });

  it("writes every row when the cohort exceeds one statement", async () => {
    await store.ensureJobs(Array.from({ length: 1100 }, (_, i) => entry(`${prefix}big${i}`)));

    expect(await countPrefixed("big")).toBe(1100);
  });

  it("leaves re-ensuring an unchanged cohort as a no-op", async () => {
    // The production case: 164,590 jobs that all already existed. Nothing about
    // the row may move, including updated_at, which is the pulse's signal that
    // something actually happened.
    const subject = `${prefix}unchanged`;
    await store.ensureJobs([entry(subject, 75)]);
    const before = await store.pool.query<{ updated_at: Date }>(
      "SELECT updated_at FROM analytics.jobs WHERE dedupe_key = $1",
      [`post.metrics:${subject}`],
    );

    await store.ensureJobs([entry(subject, 75)]);

    const after = await store.pool.query<{ updated_at: Date }>(
      "SELECT updated_at FROM analytics.jobs WHERE dedupe_key = $1",
      [`post.metrics:${subject}`],
    );
    expect(after.rows[0]!.updated_at.toISOString()).toBe(before.rows[0]!.updated_at.toISOString());
  });
});
