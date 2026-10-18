import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { readRisingPosts } from "./rising-posts.js";

const sampledAt = "2026-09-15T02:00:00.000Z";
function rawRow(overrides: Record<string, unknown> = {}) {
  return {
    sampled_at: new Date(sampledAt),
    uri: "at://did:plc:alice/app.bsky.feed.post/one",
    author_did: "did:plc:alice",
    handle: "alice.test",
    text: "A post <not HTML>",
    created_at: new Date("2026-09-14T22:00:00.000Z"),
    latest_sample_at: new Date("2026-09-15T01:55:00.000Z"),
    observed_minutes: "50.5000000000000000",
    sample_count: "6",
    interactions: "1500",
    gained_interactions: "101",
    interactions_per_hour: "120.0000000000000000",
    previous_interactions_per_hour: null,
    max_gap_minutes: "10.5",
    total_eligible: "42",
    ...overrides,
  };
}

function stubPool(rows = [rawRow()]) {
  const query = vi.fn(async (text: string, _values?: unknown[]) => ({
    rows: text.includes("WITH clock") ? rows : [],
  }));
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  return { pool: { connect } as unknown as Pool, connect, query, release };
}

function statementList(query: ReturnType<typeof stubPool>["query"]): string[] {
  return query.mock.calls.map(([text]) => text);
}

describe(readRisingPosts, () => {
  it("returns database time, explicit bounds, exact integers and nullable comparison", async () => {
    const { pool, query, release } = stubPool();
    const snapshot = await readRisingPosts(pool);
    expect(snapshot).toMatchObject({
      sampledAt,
      windowMinutes: 60,
      postAgeHours: 48,
      freshnessMinutes: 15,
      minSpanMinutes: 10,
      previousMinCoverageRatio: 0.8,
      totalEligible: 42,
      rows: [{
        uri: "at://did:plc:alice/app.bsky.feed.post/one", authorDid: "did:plc:alice",
        handle: "alice.test", text: "A post <not HTML>",
        createdAt: "2026-09-14T22:00:00.000Z", latestSampleAt: "2026-09-15T01:55:00.000Z",
        interactions: 1500, gainedInteractions: 101, interactionsPerHour: 120,
        previousInteractionsPerHour: null, observedMinutes: 50.5, sampleCount: 6, maxGapMinutes: 10.5,
      }],
    });
    expect(Number.isFinite(snapshot.queryDurationMs)).toBe(true);
    expect(snapshot.queryDurationMs).toBeGreaterThanOrEqual(0);
    const statements = statementList(query);
    expect(statements[0]).toBe("BEGIN READ ONLY");
    expect(statements[1]).toBe("SET LOCAL statement_timeout = '5s'");
    expect(query.mock.calls[2]?.[1]).toEqual([48, 15, 60, 10, 0.8, 30]);
    expect(statements[3]).toBe("COMMIT");
    expect(statements).toHaveLength(4);
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("preserves genuinely observed previous zero and absent handle/text", async () => {
    const { pool } = stubPool([rawRow({
      handle: null, text: null, previous_interactions_per_hour: "0.000000",
      sampled_at: sampledAt, created_at: "2026-09-14T18:00:00-04:00",
    })]);
    expect((await readRisingPosts(pool)).rows[0]).toMatchObject({
      handle: null, text: null, previousInteractionsPerHour: 0, createdAt: "2026-09-14T22:00:00.000Z",
    });
  });

  it("returns a timed empty snapshot rather than a fabricated zero-rate row", async () => {
    const { pool } = stubPool([rawRow({ uri: null, total_eligible: null })]);
    expect(await readRisingPosts(pool)).toMatchObject({ sampledAt, totalEligible: 0, rows: [] });
  });

  it("bounds candidate and sample reads before ranking, using deterministic ties", async () => {
    const { pool, query } = stubPool();
    await readRisingPosts(pool);
    const sql = query.mock.calls[2]![0];
    expect(sql).toContain("tracked.account_did = account.did");
    expect(sql).toContain("JOIN analytics.tracked_accounts account ON account.enabled");
    expect(sql).toContain("tracked.enabled AND tracked.reason = 'account'");
    expect(sql).toContain("post.author_did = tracked.account_did");
    expect(sql).toContain("post.is_reply = false");
    expect(sql).toContain("OFFSET 0");
    expect(sql).toContain("sample.uri = candidate.uri");
    expect(sql).toContain("sample.sampled_at >= clock.sampled_at - ($3 * 2 + $2) * interval '1 minute'");
    expect(sql).toContain("sample.sampled_at <= clock.sampled_at");
    expect(sql).toContain("sample.sampled_at > candidate.created_at");
    expect(sql).toContain("sample.source = 'appview'");
    expect(sql).toContain("likes < lag(likes)");
    expect(sql).toContain("replies < lag(replies)");
    expect(sql).toContain("quotes < lag(quotes)");
    expect(sql).toContain("reposts < lag(reposts)");
    expect(sql).toContain('latest_sample_at DESC, uri COLLATE "C" ASC');
    expect(sql).toContain("count(*) OVER () AS total_eligible");
    expect(sql).toContain("LIMIT $6");
    expect(sql).not.toContain("launch_window_interactions");
    expect(sql).not.toContain("peak_interactions_per_hour");
  });

  it.each(["9007199254740992", "9007199254740993", "1.5", 1.5, null, "", " ", "NaN", "Infinity", -1])(
    "rejects unrepresentable or invalid cumulative integer %j instead of coercing to zero/rounding",
    async (interactions) => {
      const { pool, query, release } = stubPool([rawRow({ interactions })]);
      await expect(readRisingPosts(pool)).rejects.toThrow(/Rising posts query returned/);
      expect(statementList(query).at(-1)).toBe("ROLLBACK");
      expect(statementList(query)).not.toContain("COMMIT");
      expect(release).toHaveBeenCalledExactlyOnceWith(false);
    },
  );

  it("accepts the maximum safe exact integer without truncating it", async () => {
    const { pool } = stubPool([rawRow({ interactions: "9007199254740991" })]);
    expect((await readRisingPosts(pool)).rows[0]?.interactions).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([NaN, Infinity, -Infinity, -0.1, "1e999", null])("rejects an invalid rate %j", async (rate) => {
    const { pool } = stubPool([rawRow({ interactions_per_hour: rate })]);
    await expect(readRisingPosts(pool)).rejects.toThrow(/Rising posts query returned/);
  });

  it("does not turn a malformed result or timestamp into an empty healthy snapshot", async () => {
    await expect(readRisingPosts(stubPool([]).pool)).rejects.toThrow("no snapshot");
    await expect(readRisingPosts(stubPool([rawRow({ sampled_at: "bad" })]).pool))
      .rejects.toThrow("invalid timestamp");
  });

  it("rolls back a server-side timeout, propagates it and releases the connection", async () => {
    const { pool, query, release } = stubPool();
    const timeout = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    query.mockImplementation(async (sql) => {
      if (sql.includes("WITH clock")) throw timeout;
      return { rows: [] };
    });
    await expect(readRisingPosts(pool)).rejects.toBe(timeout);
    expect(statementList(query).at(-1)).toBe("ROLLBACK");
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("discards a client when rollback fails, without masking the original error", async () => {
    const { pool, query, release } = stubPool();
    const original = new Error("read failed");
    query.mockImplementation(async (sql) => {
      if (sql.includes("WITH clock")) throw original;
      if (sql === "ROLLBACK") throw new Error("connection lost");
      return { rows: [] };
    });
    await expect(readRisingPosts(pool)).rejects.toBe(original);
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("propagates a pool connection failure without attempting a query", async () => {
    const { pool, connect, query, release } = stubPool();
    const error = new Error("pool unavailable");
    connect.mockRejectedValueOnce(error);
    await expect(readRisingPosts(pool)).rejects.toBe(error);
    expect(query).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
});
