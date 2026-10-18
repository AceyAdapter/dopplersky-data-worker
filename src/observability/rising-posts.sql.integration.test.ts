import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readRisingPosts } from "./rising-posts.js";

// Explicit disposable DB opt-in only. Never use DATABASE_URL or production.
const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl && new URL(databaseUrl).pathname !== "/dopplersky_worker_test") {
  throw new Error("TEST_DATABASE_URL must name the disposable dopplersky_worker_test database");
}

const now = new Date("2026-09-15T02:00:00.000Z");
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
type Sample = {
  ago: number;
  likes: number | string;
  replies?: number;
  quotes?: number;
  reposts?: number;
  source?: string;
};
type FixtureOptions = {
  age?: number;
  metadataAge?: number;
  enabledAccount?: boolean;
  enabledPost?: boolean;
  isReply?: boolean | null;
  mismatchedOwner?: boolean;
  standalone?: boolean;
  reason?: "account" | "explicit";
  handle?: string | null;
  text?: string | null;
};

/**
 * Execute the reader's actual parameterized SELECT against PostgreSQL, not a JS
 * simulation. Connection-local fixture tables mirror the columns/types and
 * indexes this read uses (migrations 001/004/007/008). Only schema qualifiers and
 * the clock are substituted, so math, filters, ranking and transactions are the
 * production code. Temp tables avoid racing the existing migration integration
 * suite or deleting its fixtures; no application schema is created/modified.
 * This tests SQL semantics, not a historical-volume query plan or migrations.
 */
describe.skipIf(!databaseUrl)("rising posts SQL on disposable PostgreSQL", () => {
  let database: Pool;
  let client: PoolClient;
  let readerPool: Pool;
  let inReadSettings: { transaction_read_only: string; statement_timeout: string };

  beforeAll(async () => {
    database = new Pool({ connectionString: databaseUrl!, max: 1 });
    client = await database.connect();
    await client.query(`
      CREATE TEMP TABLE rising_actors (did text PRIMARY KEY, handle text);
      CREATE TEMP TABLE rising_tracked_accounts (did text PRIMARY KEY, enabled boolean NOT NULL DEFAULT true);
      CREATE TEMP TABLE rising_posts (
        uri text PRIMARY KEY, author_did text NOT NULL, created_at timestamptz NOT NULL,
        text text, is_reply boolean
      );
      CREATE TEMP TABLE rising_tracked_posts (
        uri text PRIMARY KEY, account_did text, reason text NOT NULL,
        enabled boolean NOT NULL DEFAULT true, metrics_sampled_at timestamptz
      );
      CREATE INDEX ON rising_tracked_posts (account_did, metrics_sampled_at DESC) WHERE enabled;
      CREATE TEMP TABLE rising_post_metric_samples (
        uri text NOT NULL, sampled_at timestamptz NOT NULL,
        likes bigint NOT NULL, replies bigint NOT NULL, quotes bigint NOT NULL, reposts bigint NOT NULL,
        source text NOT NULL DEFAULT 'appview', PRIMARY KEY (uri, sampled_at)
      );
    `);
    readerPool = {
      connect: async () => ({
        query: async (sql: string, values?: unknown[]) => {
          if (sql.includes("WITH clock")) {
            const readOnly = (await client.query("SHOW transaction_read_only")).rows[0];
            const timeout = (await client.query("SHOW statement_timeout")).rows[0];
            inReadSettings = { ...readOnly, ...timeout };
            sql = sql.replace("SELECT now() AS sampled_at", `SELECT timestamptz '${now.toISOString()}' AS sampled_at`);
            for (const name of ["actors", "tracked_accounts", "posts", "tracked_posts", "post_metric_samples"]) {
              sql = sql.replaceAll(`analytics.${name}`, `pg_temp.rising_${name}`);
            }
          }
          return client.query(sql, values);
        },
        release: () => {}, // This suite owns the dedicated connection until afterAll.
      }),
    } as unknown as Pool;
  });

  beforeEach(async () => {
    await client.query(`TRUNCATE rising_post_metric_samples, rising_tracked_posts,
      rising_posts, rising_tracked_accounts, rising_actors`);
  });

  afterAll(async () => {
    client?.release(); // Closing the connection drops only our temp tables.
    await database?.end();
  });

  async function fixture(id: string, samples: Sample[], options: FixtureOptions = {}) {
    const author = `did:plc:rising${id}`;
    const owner = options.mismatchedOwner ? `${author}owner` : author;
    const uri = `at://${author}/app.bsky.feed.post/${id}`;
    await client.query("INSERT INTO rising_actors (did, handle) VALUES ($1, $2)",
      [author, options.handle === undefined ? `${id}.test` : options.handle]);
    if (owner !== author) await client.query("INSERT INTO rising_actors (did) VALUES ($1)", [owner]);
    if (!options.standalone) {
      await client.query("INSERT INTO rising_tracked_accounts (did, enabled) VALUES ($1, $2)",
        [owner, options.enabledAccount ?? true]);
    }
    await client.query("INSERT INTO rising_posts (uri, author_did, created_at, text, is_reply) VALUES ($1,$2,$3,$4,$5)",
      [uri, author, ago(options.age ?? 240), options.text === undefined ? id : options.text,
        options.isReply === undefined ? false : options.isReply]);
    await client.query(`INSERT INTO rising_tracked_posts (uri, account_did, reason, enabled, metrics_sampled_at)
      VALUES ($1,$2,$3,$4,$5)`,
    [uri, options.standalone ? null : owner, options.reason ?? "account", options.enabledPost ?? true,
      ago(options.metadataAge ?? 1)]);
    for (const sample of samples) {
      await client.query(`INSERT INTO rising_post_metric_samples (uri, sampled_at, likes, replies, quotes, reposts, source)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uri, ago(sample.ago), sample.likes, sample.replies ?? 0, sample.quotes ?? 0, sample.reposts ?? 0,
        sample.source ?? "appview"]);
    }
    return uri;
  }

  it("returns database time and an empty snapshot when no candidates exist", async () => {
    expect(await readRisingPosts(readerPool)).toMatchObject({
      sampledAt: now.toISOString(), totalEligible: 0, rows: [],
    });
  });

  it("measures actual intervals, saved sample counts, gaps and comparable prior rate", async () => {
    const uri = await fixture("measured", [
      { ago: 115, likes: 100 }, { ago: 60, likes: 160 },
      { ago: 30, likes: 220 }, { ago: 5, likes: 270 },
    ], { handle: null, text: null });
    const snapshot = await readRisingPosts(readerPool);
    expect(snapshot).toMatchObject({ sampledAt: now.toISOString(), totalEligible: 1 });
    expect(snapshot.rows[0]).toMatchObject({
      uri, handle: null, text: null, observedMinutes: 55, sampleCount: 3,
      interactions: 270, gainedInteractions: 110, interactionsPerHour: 120, maxGapMinutes: 30,
    });
    expect(snapshot.rows[0]?.previousInteractionsPerHour).toBeCloseTo(60 / 55 * 60, 10);
    expect(inReadSettings).toEqual({ transaction_read_only: "on", statement_timeout: "5s" });
    expect((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("off");
    expect((await client.query("SHOW statement_timeout")).rows[0].statement_timeout).toBe("0");
  });

  it("excludes synthetic origins and non-AppView data but accepts real later zero observations", async () => {
    await fixture("origin", [{ ago: 30, likes: 0 }, { ago: 5, likes: 100 }], { age: 30 });
    await fixture("otherSource", [{ ago: 20, likes: 0, source: "legacy" }, { ago: 5, likes: 100 }]);
    const valid = await fixture("observedZero", [{ ago: 20, likes: 0 }, { ago: 5, likes: 10 }], { age: 30 });
    const snapshot = await readRisingPosts(readerPool);
    expect(snapshot.totalEligible).toBe(1);
    expect(snapshot.rows[0]).toMatchObject({ uri: valid, gainedInteractions: 10, interactionsPerHour: 40 });
  });

  it("excludes replies, unknown reply status, disabled scopes and audience/explicit posts", async () => {
    const samples = [{ ago: 55, likes: 100 }, { ago: 5, likes: 200 }];
    const valid = await fixture("own", samples);
    for (const [id, options] of Object.entries<FixtureOptions>({
      reply: { isReply: true }, unknown: { isReply: null }, disabledAccount: { enabledAccount: false },
      disabledPost: { enabledPost: false }, audience: { mismatchedOwner: true },
      explicit: { reason: "explicit" }, standalone: { standalone: true, reason: "explicit" },
    })) await fixture(id, samples, options);
    expect((await readRisingPosts(readerPool)).rows.map((row) => row.uri)).toEqual([valid]);
  });

  it("uses inclusive age/freshness bounds and ignores future observations", async () => {
    const boundary = await fixture("boundary", [{ ago: 60, likes: 100 }, { ago: 15, likes: 200 }], { age: 48 * 60, metadataAge: 15 });
    await fixture("old", [{ ago: 60, likes: 100 }, { ago: 5, likes: 200 }], { age: 48 * 60 + 0.01 });
    await fixture("staleSample", [{ ago: 60, likes: 100 }, { ago: 15.01, likes: 200 }]);
    await fixture("staleMetadata", [{ ago: 60, likes: 100 }, { ago: 5, likes: 200 }], { metadataAge: 15.01 });
    await fixture("futurePost", [{ ago: -3, likes: 100 }, { ago: -1, likes: 200 }], { age: -5 });
    await fixture("futureMetadata", [{ ago: 60, likes: 100 }, { ago: 5, likes: 200 }], { metadataAge: -1 });
    const future = await fixture("futureSample", [
      { ago: 55, likes: 100 }, { ago: 5, likes: 200 }, { ago: -1, likes: 9_000_000 },
    ]);
    const snapshot = await readRisingPosts(readerPool);
    expect(snapshot.totalEligible).toBe(2);
    expect(snapshot.rows.map((row) => row.uri).sort()).toEqual([boundary, future].sort());
    expect(snapshot.rows.find((row) => row.uri === future)).toMatchObject({
      interactions: 200, gainedInteractions: 100, sampleCount: 2, latestSampleAt: ago(5).toISOString(),
    });
  });

  it("requires ten measured minutes, never stretches an old gap or creates missing samples", async () => {
    const atMinimum = await fixture("minimum", [{ ago: 15, likes: 0 }, { ago: 5, likes: 10 }]);
    await fixture("tooShort", [{ ago: 14.99, likes: 0 }, { ago: 5, likes: 1000 }]);
    await fixture("oneSample", [{ ago: 5, likes: 1000 }]);
    await fixture("oldGap", [{ ago: 70, likes: 0 }, { ago: 5, likes: 1000 }]);
    const sparse = await fixture("sparse", [{ ago: 60, likes: 100 }, { ago: 5, likes: 210 }]);
    const snapshot = await readRisingPosts(readerPool);
    expect(snapshot.totalEligible).toBe(2);
    expect(snapshot.rows.find((row) => row.uri === atMinimum)?.observedMinutes).toBe(10);
    expect(snapshot.rows.find((row) => row.uri === sparse)).toMatchObject({
      observedMinutes: 55, sampleCount: 2, maxGapMinutes: 55, previousInteractionsPerHour: null,
    });
  });

  it("does not rank a per-counter decrease, cross-counter offset, reset/rebound or negative raw count", async () => {
    await fixture("crossOffset", [{ ago: 55, likes: 100, replies: 10 }, { ago: 5, likes: 99, replies: 200 }]);
    await fixture("rebound", [{ ago: 55, likes: 100 }, { ago: 30, likes: 50 }, { ago: 5, likes: 200 }]);
    for (const counter of ["replies", "quotes", "reposts"] as const) {
      await fixture(counter, [{ ago: 55, likes: 100, [counter]: 10 }, { ago: 5, likes: 200, [counter]: 9 }]);
    }
    await fixture("negative", [{ ago: 55, likes: -1 }, { ago: 5, likes: 100 }]);
    await fixture("unchanged", [{ ago: 55, likes: 100 }, { ago: 5, likes: 100 }]);
    expect(await readRisingPosts(readerPool)).toMatchObject({ totalEligible: 0, rows: [] });
  });

  it("keeps current growth when prior history is insufficient or corrected, with null comparison", async () => {
    await fixture("priorShort", [{ ago: 70, likes: 0 }, { ago: 60, likes: 100 }, { ago: 5, likes: 200 }]);
    await fixture("priorDrop", [
      { ago: 115, likes: 110 }, { ago: 80, likes: 80 }, { ago: 60, likes: 100 }, { ago: 5, likes: 200 },
    ]);
    const snapshot = await readRisingPosts(readerPool);
    expect(snapshot.totalEligible).toBe(2);
    expect(snapshot.rows.every((row) => row.previousInteractionsPerHour === null)).toBe(true);
  });

  it("compares only an adjacent 80–100% span, normalizes its actual duration, and preserves real zero", async () => {
    const exact = await fixture("prior80", [{ ago: 95, likes: 60 }, { ago: 55, likes: 100 }, { ago: 5, likes: 200 }]);
    const short = await fixture("priorBelow80", [{ ago: 94.99, likes: 60 }, { ago: 55, likes: 100 }, { ago: 5, likes: 200 }]);
    const zero = await fixture("priorZero", [{ ago: 105, likes: 100 }, { ago: 55, likes: 100 }, { ago: 5, likes: 200 }]);
    const rows = (await readRisingPosts(readerPool)).rows;
    expect(rows.find((row) => row.uri === exact)?.previousInteractionsPerHour).toBe(60);
    expect(rows.find((row) => row.uri === short)?.previousInteractionsPerHour).toBeNull();
    expect(rows.find((row) => row.uri === zero)?.previousInteractionsPerHour).toBe(0);
  });

  it("ranks recent rate rather than cumulative popularity with deterministic top30 and full eligible count", async () => {
    const expected: string[] = [];
    for (let i = 34; i >= 0; i--) {
      expected.push(await fixture(`tie${String(i).padStart(2, "0")}`, [{ ago: 55, likes: 100 }, { ago: 5, likes: 200 }]));
    }
    await fixture("popularButSlow", [{ ago: 55, likes: 1_000_000 }, { ago: 5, likes: 1_000_001 }]);
    const first = await readRisingPosts(readerPool);
    const second = await readRisingPosts(readerPool);
    expect(first.totalEligible).toBe(36);
    expect(first.rows).toHaveLength(30);
    expect(first.rows.map((row) => row.uri)).toEqual(expected.sort().slice(0, 30));
    expect(second.rows).toEqual(first.rows);
  });

  it("breaks rate ties by gain, then endpoint freshness, then URI", async () => {
    const ordinary = await fixture("zordinary", [{ ago: 55, likes: 100 }, { ago: 5, likes: 200 }]);
    const fresher = await fixture("afresher", [{ ago: 51, likes: 100 }, { ago: 1, likes: 200 }]);
    const moreGain = await fixture("moreGain", [{ ago: 65, likes: 100 }, { ago: 5, likes: 220 }]);
    expect((await readRisingPosts(readerPool)).rows.map((row) => row.uri)).toEqual([moreGain, fresher, ordinary]);
  });

  it("rejects unsafe bigint totals without SQL bigint overflow or returning rounded JSON", async () => {
    await fixture("huge", [
      { ago: 55, likes: "9223372036854775700", replies: 200 },
      { ago: 5, likes: "9223372036854775807", replies: 200 },
    ]);
    await expect(readRisingPosts(readerPool)).rejects.toThrow("unsafe number");
    expect((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("off");
  });
});
