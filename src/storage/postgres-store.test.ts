import { asAtUriString, asDatetimeString, type DidString } from "@atproto/lex";
import { describe, expect, it, vi } from "vitest";
import type { Engagement } from "../domain/types.js";
import { ACCOUNT_POST_METRICS_PRIORITY, EXPLICIT_POST_METRICS_PRIORITY } from "../scheduling/cadence.js";
import { dedupeEngagements, engagementEdgeKey, PostgresAnalyticsStore } from "./postgres-store.js";

const actorDid = "did:plc:audience" as DidString;
const postUri = asAtUriString("at://did:plc:target/app.bsky.feed.post/3target");

describe(engagementEdgeKey, () => {
  it("deduplicates an AppView like with the same record later delivered by Tap", () => {
    const appview: Engagement = { postUri, actorDid, kind: "like" };
    const tap: Engagement = {
      ...appview,
      recordUri: asAtUriString(`at://${actorDid}/app.bsky.feed.like/3like`),
    };

    expect(engagementEdgeKey(appview)).toBe(engagementEdgeKey(tap));
  });

  it("keeps multiple replies from one actor as separate historical events", () => {
    const first: Engagement = {
      postUri,
      actorDid,
      kind: "reply",
      recordUri: asAtUriString(`at://${actorDid}/app.bsky.feed.post/3reply1`),
    };
    const second: Engagement = {
      ...first,
      recordUri: asAtUriString(`at://${actorDid}/app.bsky.feed.post/3reply2`),
    };

    expect(engagementEdgeKey(first)).not.toBe(engagementEdgeKey(second));
  });
});

describe(dedupeEngagements, () => {
  it("collapses a like the AppView returned twice, so the ON CONFLICT batch is safe", () => {
    const like: Engagement = { postUri, actorDid, kind: "like" };
    // Same (post, actor, like) delivered twice across pages → one row.
    expect(dedupeEngagements([like, { ...like }])).toHaveLength(1);
  });

  it("keeps distinct engagements — different actors, posts, or reply records", () => {
    const other = "did:plc:someone" as DidString;
    const reply1: Engagement = {
      postUri, actorDid, kind: "reply",
      recordUri: asAtUriString(`at://${actorDid}/app.bsky.feed.post/3r1`),
    };
    const reply2: Engagement = { ...reply1, recordUri: asAtUriString(`at://${actorDid}/app.bsky.feed.post/3r2`) };
    const deduped = dedupeEngagements([
      { postUri, actorDid, kind: "like" },
      { postUri, actorDid: other, kind: "like" },
      reply1,
      reply2,
    ]);
    expect(deduped).toHaveLength(4);
  });
});

describe("ensureReplayJobs reconciles the cohort in one statement", () => {
  const cutoff = asDatetimeString("2026-09-01T00:00:00.000Z");

  function replayFixture(rows: { cohort: number; affected: number }[] = [{ cohort: 7, affected: 2 }]) {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows }));
    // Query-only receiver: the real method, with no connection string, socket, or
    // real database reachable from this unit fixture.
    const store = { pool: { query }, ensureReplayJobs: PostgresAnalyticsStore.prototype.ensureReplayJobs };
    return { store, query };
  }

  it("cohorts in the database, counting the change rather than the scan", async () => {
    const { store, query } = replayFixture();
    expect(await store.ensureReplayJobs(cutoff)).toEqual({ cohort: 7, affected: 2 });
    expect(query).toHaveBeenCalledExactlyOnceWith(expect.any(String), [cutoff]);
  });

  it("applies the created_at filter before the join, in a materialized CTE", async () => {
    const { store, query } = replayFixture();
    await store.ensureReplayJobs(cutoff);
    const sql = query.mock.calls[0]![0];
    // The shape is the fix: leaving the age test as a join filter makes the
    // planner hash all tracked posts against all posts and spill to disk —
    // 26.6 s on production against 4.5 s for this form.
    expect(sql).toMatch(/WITH recent AS MATERIALIZED \(/);
    expect(sql).toMatch(/WHERE \$1::timestamptz IS NOT NULL AND created_at > \$1/);
    expect(sql).toMatch(/payloads AS MATERIALIZED \(/);
    expect(sql).toMatch(/ORDER BY tracked\.uri/);
    // Explicit posts outrank the account cohort; both are cohort priorities.
    expect(sql).toContain(`THEN ${EXPLICIT_POST_METRICS_PRIORITY}`);
    expect(sql).toContain(`ELSE ${ACCOUNT_POST_METRICS_PRIORITY}`);
    // Same conflict policy as `ensureJobs`: raise, never reschedule.
    expect(sql).toContain("ON CONFLICT (dedupe_key) DO UPDATE SET");
    expect(sql).toContain("WHERE analytics.jobs.priority < EXCLUDED.priority");
    expect(sql).not.toContain("LIMIT");
  });

  it("passes a null cutoff for explicit-only reconciliation", async () => {
    const { store, query } = replayFixture([{ cohort: 1, affected: 1 }]);
    expect(await store.ensureReplayJobs(null)).toEqual({ cohort: 1, affected: 1 });
    expect(query).toHaveBeenCalledExactlyOnceWith(expect.any(String), [null]);
  });
});

function ensureJobsFixture() {
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [] }));
  // Same query-only receiver as `trackedPostFixture`: the real method, no
  // connection string, socket, or database.
  const store = { pool: { query }, ensureJobs: PostgresAnalyticsStore.prototype.ensureJobs };
  return { store, query };
}

function ensureEntry(subject: string, priority = 75) {
  return { kind: "post.metrics" as const, subject, dueAt: new Date("2026-09-15T14:07:50.000Z"), payload: { uri: subject }, priority };
}

describe("ensureJobs batches standing-job writes", () => {
  it("writes a whole page in one statement instead of one per job", async () => {
    const { store, query } = ensureJobsFixture();
    const entries = Array.from({ length: 500 }, (_, i) => ensureEntry(`at://alice/app.bsky.feed.post/p${i}`));

    await store.ensureJobs(entries);

    expect(query).toHaveBeenCalledTimes(1);
    const rows = JSON.parse(query.mock.calls[0]![1]![0] as string);
    expect(rows).toHaveLength(500);
    expect(rows[0]).toMatchObject({
      kind: "post.metrics",
      subject: "at://alice/app.bsky.feed.post/p0",
      dedupe_key: "post.metrics:at://alice/app.bsky.feed.post/p0",
      priority: 75,
      due_at: "2026-09-15T14:07:50.000Z",
      payload: { uri: "at://alice/app.bsky.feed.post/p0" },
    });
  });

  it("keeps the sequential 'highest priority wins' result when a batch repeats a key", async () => {
    // ON CONFLICT cannot touch the same row twice in one statement, so a
    // duplicate must be collapsed before the statement is sent.
    const { store, query } = ensureJobsFixture();

    await store.ensureJobs([ensureEntry("at://alice/p", 75), ensureEntry("at://alice/p", 55)]);

    expect(query).toHaveBeenCalledTimes(1);
    const rows = JSON.parse(query.mock.calls[0]![1]![0] as string);
    expect(rows).toHaveLength(1);
    expect(rows[0].priority).toBe(75);
  });

  it("chunks above the batch bound and sends nothing for an empty list", async () => {
    const { store, query } = ensureJobsFixture();
    await store.ensureJobs(Array.from({ length: 1100 }, (_, i) => ensureEntry(`at://alice/p${i}`)));

    expect(query).toHaveBeenCalledTimes(3);
    expect(JSON.parse(query.mock.calls[0]![1]![0] as string)).toHaveLength(500);
    expect(JSON.parse(query.mock.calls[2]![1]![0] as string)).toHaveLength(100);

    query.mockClear();
    await store.ensureJobs([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("keeps the ensure guarantee in SQL: insert, or raise priority only", async () => {
    const { store, query } = ensureJobsFixture();
    await store.ensureJobs([ensureEntry("at://alice/p")]);

    const sql = query.mock.calls[0]![0] as string;
    expect(sql).toContain("jsonb_to_recordset");
    expect(sql).toContain("ON CONFLICT (dedupe_key) DO UPDATE SET");
    expect(sql).toContain("priority = EXCLUDED.priority");
    expect(sql).toContain("WHERE analytics.jobs.priority < EXCLUDED.priority");
    // An ensure must never pull an existing schedule forward.
    expect(sql).not.toContain("due_at = EXCLUDED.due_at");
  });
});
