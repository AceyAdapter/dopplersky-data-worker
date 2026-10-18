import { asDatetimeString, type DidString } from "@atproto/lex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACCOUNT_POST_METRICS_PRIORITY, EXPLICIT_POST_METRICS_PRIORITY } from "../scheduling/cadence.js";
import { PostgresAnalyticsStore } from "./postgres-store.js";

// Never fall back to DATABASE_URL: this suite writes fixture data. CI provisions
// this dedicated database; local runs opt in using TEST_DATABASE_URL.
const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl && new URL(databaseUrl).pathname !== "/dopplersky_worker_test") {
  throw new Error("TEST_DATABASE_URL must name the disposable dopplersky_worker_test database");
}

describe.skipIf(!databaseUrl)("profile retirement against real PostgreSQL migrations", () => {
  let store: PostgresAnalyticsStore;
  const did = "did:plc:profilemisstest" as DidString;

  beforeAll(async () => {
    store = new PostgresAnalyticsStore(databaseUrl!);
    await store.migrate();
    await store.migrate(); // Migration runner must remain idempotent.
    await store.upsertActor({ did, handle: "profile-miss.test" });
    await store.pool.query("INSERT INTO analytics.tracked_accounts (did) VALUES ($1)", [did]);
  }, 30_000);

  afterAll(async () => {
    if (!store) return;
    try {
      await store.pool.query("DELETE FROM analytics.jobs WHERE payload->>'did' = $1", [did]);
      await store.pool.query("DELETE FROM analytics.actors WHERE did = $1", [did]);
    } finally {
      await store.close();
    }
  });

  it("commits the third miss, cancels collection/jobs, and preserves the reason", async () => {
    const run = await store.getOrCreateBaselineRun(did, asDatetimeString(new Date().toISOString()));
    await store.enqueue("account.profile", did, new Date(), { did }, 80);
    await store.enqueue("posts.maintenance", did, new Date(), { did }, 55);
    expect(await store.registerProfileMiss(did, 3)).toBe(false);
    expect(await store.registerProfileMiss(did, 3)).toBe(false);
    expect(await store.accountEnabled(did)).toBe(true);
    // This used to violate tracked_accounts_baseline_state_check, rolling back
    // the increment to leave profile_miss_count permanently stuck at two.
    expect(await store.registerProfileMiss(did, 3)).toBe(true);
    const row = (await store.pool.query(
      "SELECT enabled, baseline_state, profile_miss_count, last_safe_error FROM analytics.tracked_accounts WHERE did = $1", [did],
    )).rows[0];
    expect(row).toMatchObject({ enabled: false, baseline_state: "cancelled", profile_miss_count: 3 });
    expect(row.last_safe_error).toContain("Profile unresolvable after 3 consecutive checks");
    expect((await store.pool.query("SELECT state FROM analytics.collection_runs WHERE id = $1", [run.id])).rows[0].state).toBe("cancelled");
    expect((await store.pool.query("SELECT id FROM analytics.jobs WHERE payload->>'did' = $1", [did])).rowCount).toBe(0);
    expect(await store.registerProfileMiss(did, 3)).toBe(false);
    expect((await store.pool.query("SELECT profile_miss_count FROM analytics.tracked_accounts WHERE did = $1", [did])).rows[0].profile_miss_count).toBe(3);
  });

  it("reactivation grants a fresh streak, restores standing jobs, and success resets misses", async () => {
    expect(await store.reactivateAccount(did)).toBe(true);
    const row = (await store.pool.query(
      "SELECT enabled, baseline_state, profile_miss_count, last_safe_error FROM analytics.tracked_accounts WHERE did = $1", [did],
    )).rows[0];
    expect(row).toEqual({ enabled: true, baseline_state: "queued", profile_miss_count: 0, last_safe_error: null });
    expect((await store.pool.query("SELECT kind FROM analytics.jobs WHERE payload->>'did' = $1 ORDER BY kind", [did])).rows)
      .toEqual([{ kind: "account.profile" }, { kind: "posts.maintenance" }]);
    expect(await store.registerProfileMiss(did, 3)).toBe(false);
    await store.resetProfileMisses(did);
    expect((await store.pool.query("SELECT profile_miss_count FROM analytics.tracked_accounts WHERE did = $1", [did])).rows[0].profile_miss_count).toBe(0);
  });

  it("replays exactly the eligible cohort in one statement, preserving age and explicit boundaries", async () => {
    const replayDid = "did:plc:replaypagetest" as DidString;
    const prefix = `at://${replayDid}/app.bsky.feed.post/`;
    const cutoff = asDatetimeString("2026-09-01T00:00:00.000Z");
    const fixtures = [
      { key: "a-old", at: "2026-08-31T23:59:59.999Z", reason: "account", enabled: true },
      { key: "b-young", at: "2026-09-01T00:00:00.001Z", reason: "account", enabled: true },
      { key: "c-boundary", at: cutoff, reason: "account", enabled: true },
      { key: "d-explicit", at: "2020-01-01T00:00:00.000Z", reason: "explicit", enabled: true },
      { key: "e-disabled", at: "2026-09-02T00:00:00.000Z", reason: "account", enabled: false },
      { key: "f-young", at: "2026-09-02T00:00:00.000Z", reason: "account", enabled: true },
      { key: "g-disabled-explicit", at: "2020-01-01T00:00:00.000Z", reason: "explicit", enabled: false },
    ];
    const jobRows = async () =>
      (
        await store.pool.query<{ subject: string; priority: number; due_at: Date; payload: Record<string, unknown> }>(
          "SELECT subject, priority, due_at, payload FROM analytics.jobs WHERE dedupe_key LIKE $1 ORDER BY subject",
          [`post.metrics:${prefix}%`],
        )
      ).rows;
    await store.upsertActor({ did: replayDid, handle: "replay-page.test" });
    try {
      // A disabled tracked_account must not change the post-level gate: the old
      // keyset query never read that table, and neither does this one.
      await store.pool.query("INSERT INTO analytics.tracked_accounts (did, enabled) VALUES ($1, false)", [replayDid]);
      for (const fixture of fixtures) {
        const uri = `${prefix}${fixture.key}`;
        await store.pool.query(
          "INSERT INTO analytics.posts (uri, cid, author_did, created_at) VALUES ($1, 'test-cid', $2, $3)",
          [uri, replayDid, fixture.at],
        );
        await store.pool.query(
          "INSERT INTO analytics.tracked_posts (uri, account_did, reason, enabled) VALUES ($1, $2, $3, $4)",
          [uri, fixture.reason === "account" ? replayDid : null, fixture.reason, fixture.enabled],
        );
      }

      const result = await store.ensureReplayJobs(cutoff);
      // Two account posts strictly inside the window, plus the one explicit post.
      // `a-old` and `c-boundary` are not inside it; both disabled posts are out.
      expect(result).toEqual({ cohort: 3, affected: 3 });
      const rows = await jobRows();
      expect(rows.map((row) => row.subject)).toEqual([
        `${prefix}b-young`,
        `${prefix}d-explicit`,
        `${prefix}f-young`,
      ]);
      expect(rows[0]!.priority).toBe(ACCOUNT_POST_METRICS_PRIORITY);
      expect(rows[1]!.priority).toBe(EXPLICIT_POST_METRICS_PRIORITY);
      expect(rows[1]!.payload).toMatchObject({ uri: `${prefix}d-explicit`, explicit: true, unchangedRuns: 0 });
      expect(rows[1]!.payload.accountDid).toBeUndefined();
      expect(rows[2]!.payload).toMatchObject({ uri: `${prefix}f-young`, explicit: false, accountDid: replayDid });

      // Re-ensuring is a no-op that reports no change, and it must not pull an
      // existing schedule forward: a restart is not a reason to sample early.
      const scheduled = new Date(Date.now() + 6 * 60 * 60_000);
      await store.pool.query("UPDATE analytics.jobs SET due_at = $1 WHERE dedupe_key LIKE $2", [scheduled, `post.metrics:${prefix}%`]);
      expect(await store.ensureReplayJobs(cutoff)).toEqual({ cohort: 3, affected: 0 });
      expect((await jobRows()).every((row) => row.due_at.getTime() === scheduled.getTime())).toBe(true);

      // Launch tracking off: a null cutoff selects explicit posts only, at any age.
      await store.pool.query("DELETE FROM analytics.jobs WHERE dedupe_key LIKE $1", [`post.metrics:${prefix}%`]);
      expect(await store.ensureReplayJobs(null)).toEqual({ cohort: 1, affected: 1 });
      expect((await jobRows()).map((row) => row.subject)).toEqual([`${prefix}d-explicit`]);
    } finally {
      await store.pool.query("DELETE FROM analytics.jobs WHERE dedupe_key LIKE $1", [`post.metrics:${prefix}%`]);
      await store.pool.query("DELETE FROM analytics.posts WHERE author_did = $1", [replayDid]);
      await store.pool.query("DELETE FROM analytics.tracked_accounts WHERE did = $1", [replayDid]);
      await store.pool.query("DELETE FROM analytics.actors WHERE did = $1", [replayDid]);
    }
  });

  it("excludes retained audience members when their target opts out or disables collection", async () => {
    const engager = "did:plc:audiencewatchtest" as DidString;
    await store.upsertActor({ did: engager, handle: "audience-watch.test" });
    try {
      await store.pool.query(
        "INSERT INTO analytics.audience_members (target_did, actor_did, is_engager) VALUES ($1, $2, true)", [did, engager],
      );
      expect(await store.audienceWatchDids(10, 100)).not.toContain(engager);
      await store.setAudienceEnabled(did, true);
      expect(await store.audienceWatchDids(10, 100)).toContain(engager);
      await store.setAudienceEnabled(did, false);
      expect(await store.audienceWatchDids(10, 100)).not.toContain(engager);
      // Opt-out stops live capture without deleting retained analytics.
      expect((await store.pool.query("SELECT actor_did FROM analytics.audience_members WHERE target_did = $1", [did])).rowCount).toBe(1);
      await store.setAudienceEnabled(did, true);
      await store.cancelAccount(did);
      expect(await store.audienceWatchDids(10, 100)).not.toContain(engager);
    } finally {
      await store.pool.query("DELETE FROM analytics.actors WHERE did = $1", [engager]);
    }
  });
});
