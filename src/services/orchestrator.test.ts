import { setTimeout as delay } from "node:timers/promises";
import { asAtUriString, asDatetimeString, asStringFormat, type DidString, type HandleString } from "@atproto/lex";

vi.mock("node:timers/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:timers/promises")>();
  return { ...original, setTimeout: vi.fn(original.setTimeout) };
});
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountProfile, Job, PostMetrics } from "../domain/types.js";
import type { ProtocolReader } from "../protocol/appview-client.js";
import type { AnalyticsStore } from "../storage/store.js";
import type { ApiSyncClient } from "../sync/api-sync.js";
import type { NotificationsClient } from "../sync/notifications-client.js";
import {
  ACCOUNT_POST_METRICS_PRIORITY,
  BASELINE_POSTS_PRIORITY,
  POST_REPLAY_WINDOW_MS,
} from "../scheduling/cadence.js";
import { stubProtocol, stubStore } from "../../tests/_util.js";
import { AccountCollector } from "./account-collector.js";
import { AudienceCollector } from "./audience-collector.js";
import { Orchestrator } from "./orchestrator.js";
import { PostCollector } from "./post-collector.js";

const alice = "did:plc:alice" as DidString;
const profile: AccountProfile = {
  did: alice,
  handle: "alice.test" as HandleString,
  followers: 100,
  following: 50,
  posts: 20,
};

const noopSync = { flush: async () => 0 } as unknown as ApiSyncClient;
const noopNotifications = { dispatch: async () => null } as unknown as NotificationsClient;

type Overrides = {
  audienceEnabled?: boolean;
  concurrency?: number;
  syncEnabled?: boolean;
  notificationsEnabled?: boolean;
  maxJobAttempts?: number;
  postLaunchTrackingEnabled?: boolean;
};

function orchestrator(store: AnalyticsStore, protocol: ProtocolReader, overrides: Overrides = {}): Orchestrator {
  const accounts = new AccountCollector(protocol, store);
  const posts = new PostCollector(protocol, store);
  const audience = new AudienceCollector(protocol, store, 10, 100);
  return new Orchestrator(store, accounts, posts, audience, noopSync, noopNotifications, {
    workerId: "test",
    concurrency: overrides.concurrency ?? 4,
    leaseSeconds: 120,
    maxJobAttempts: overrides.maxJobAttempts ?? 12,
    maintenanceBatch: 25,
    maintenanceDrainMs: 60_000,
    profilePiggybackMinutes: 5,
    followerRefreshHours: 24,
    audienceEnabled: overrides.audienceEnabled ?? false,
    audienceScanTopPosts: 10,
    audienceScanRecentPosts: 15,
    audienceScanPagesPerPost: 3,
    postLaunchTrackingEnabled: overrides.postLaunchTrackingEnabled ?? true,
    syncEnabled: overrides.syncEnabled ?? false,
    notificationsEnabled: overrides.notificationsEnabled ?? false,
  });
}

function claim(job: Partial<Job> & Pick<Job, "kind" | "payload">): AnalyticsStore["claimJobs"] {
  return async () => [{ id: "1", subject: "s", attempts: 0, ...job }];
}

describe("Orchestrator bootstrap", () => {
  it("ensures standing jobs without using the pull-forward enqueue path", async () => {
    const ensured: string[] = [];
    const enqueue = vi.fn(async () => {});
    const store = stubStore({
      async trackedAccountDids() { return [alice]; },
      async audienceEnabledAccountDids() { return [alice]; },
      async ensureReplayJobs() { return { cohort: 3, affected: 1 }; },
      async ensureJobs(entries) { for (const entry of entries) ensured.push(entry.kind); },
      enqueue,
    });

    await orchestrator(store, stubProtocol({}), {
      audienceEnabled: true,
      syncEnabled: true,
    }).bootstrap();

    expect(enqueue).not.toHaveBeenCalled();
    expect(ensured).toEqual(expect.arrayContaining([
      "account.profile",
      "posts.maintenance",
      "account.audience",
      "sync.flush",
    ]));
  });

  it("enqueues no audience or engager work when audience collection is disabled", async () => {
    const kinds: string[] = [];
    const store = stubStore({
      async trackedAccountDids() { return [alice]; },
      async ensureJobs(entries) { for (const entry of entries) kinds.push(entry.kind); },
    });

    await orchestrator(store, stubProtocol({})).bootstrap();

    expect(kinds).toContain("account.profile");
    expect(kinds).toContain("posts.maintenance");
    expect(kinds).not.toContain("account.audience");
    expect(kinds).not.toContain("audience.followers");
    expect(kinds).not.toContain("post.engagers");
    // Same-database mode: no outbox transport, so no flush loop either.
    expect(kinds).not.toContain("sync.flush");
  });

  it("enqueues bounded engager discovery only for audience-opted-in accounts", async () => {
    const kinds: string[] = [];
    const store = stubStore({
      async trackedAccountDids() { return [alice]; },
      async audienceEnabledAccountDids() { return [alice]; },
      async ensureJobs(entries) { for (const entry of entries) kinds.push(entry.kind); },
    });

    await orchestrator(store, stubProtocol({}), { audienceEnabled: true }).bootstrap();

    // v2 discovery path — not the old per-post/per-follower fanout.
    expect(kinds).toContain("account.audience");
    expect(kinds).not.toContain("post.engagers");
  });

  it("scopes audience discovery to opted-in accounts, not every tracked account (W41)", async () => {
    const audience: string[] = [];
    const bob = "did:plc:bob" as DidString;
    const store = stubStore({
      // alice and bob are both tracked (get profile/posts), but only bob is
      // opted into audience collection — the premium-gated subset.
      async trackedAccountDids() { return [alice, bob]; },
      async audienceEnabledAccountDids() { return [bob]; },
      async ensureJobs(entries) { for (const entry of entries) if (entry.kind === "account.audience") audience.push(entry.subject); },
    });

    await orchestrator(store, stubProtocol({}), { audienceEnabled: true }).bootstrap();

    // Only the opted-in account gets a scan; alice (tracked, not opted in) does not.
    expect(audience).toEqual([bob]);
  });

  it("reconciles the replay cohort in one statement with the fixed cutoff", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
    try {
      const ensureReplayJobs = vi.fn(async () => ({ cohort: 2, affected: 1 }));
      const store = stubStore({
        async trackedAccountDids() { return []; },
        ensureReplayJobs,
      });

      await orchestrator(store, stubProtocol({})).bootstrap();

      // The cohort is chosen in SQL with one statement. The cutoff is the only
      // argument, and it must be the 30-day window boundary, not "now".
      expect(ensureReplayJobs).toHaveBeenCalledTimes(1);
      expect(ensureReplayJobs).toHaveBeenCalledWith(
        new Date(now - POST_REPLAY_WINDOW_MS).toISOString(),
      );
    } finally { vi.useRealTimers(); }
  });

  it("asks for explicit-only reconciliation when post launch tracking is disabled", async () => {
    const ensureReplayJobs = vi.fn(async () => ({ cohort: 0, affected: 0 }));
    await orchestrator(
      stubStore({ async trackedAccountDids() { return []; }, ensureReplayJobs }),
      stubProtocol({}),
      { postLaunchTrackingEnabled: false },
    ).bootstrap();
    // A null cutoff means "explicit posts of any age", which is the whole cohort
    // when launch tracking is off.
    expect(ensureReplayJobs).toHaveBeenCalledWith(null);
  });

  it("propagates a reconciliation failure instead of starting on a partial cohort", async () => {
    const ensureReplayJobs = vi.fn(async () => { throw new Error("store refused the reconciliation"); });
    await expect(orchestrator(
      stubStore({ async trackedAccountDids() { return []; }, ensureReplayJobs }),
      stubProtocol({}),
    ).bootstrap()).rejects.toThrow("store refused the reconciliation");
  });
});

describe("Orchestrator dispatch", () => {
  it("account.profile refreshes counters, starts the baseline, and reschedules hourly", async () => {
    const enqueued: { kind: string; payload: Record<string, unknown>; priority?: number }[] = [];
    let rescheduledDueAt: Date | undefined;
    const store = stubStore({
      claimJobs: claim({ kind: "account.profile", payload: { did: alice } }),
      async accountEnabled() { return true; },
      async accountPostsBackfilled() { return false; },
      async hasPendingAccountPostsJob() { return false; },
      async getOrCreateBaselineRun() { return { id: 7 }; },
      async enqueue(kind, _subject, _dueAt, payload, priority) { enqueued.push({ kind, payload: payload ?? {}, priority }); },
      async rescheduleJob(_id, dueAt) { rescheduledDueAt = dueAt; },
    });
    const protocol = stubProtocol({ async profiles() { return [profile]; } });

    await orchestrator(store, protocol).runOnce();

    const baseline = enqueued.find((entry) => entry.kind === "account.posts");
    expect(baseline?.payload.mode).toBe("baseline");
    expect(baseline?.payload.runId).toBe(7);
    // A baseline must never outrank a replay: backfilling history late costs
    // nothing, while a late replay sample is a permanently degraded launch
    // curve. Onboarding 100 accounts at priority 78 did exactly that on
    // 2026-09-15, starving post.metrics (75) across the whole box.
    expect(baseline?.priority).toBe(BASELINE_POSTS_PRIORITY);
    expect(BASELINE_POSTS_PRIORITY).toBeLessThan(ACCOUNT_POST_METRICS_PRIORITY);
    // The maintenance heartbeat is ensured here so API-registered accounts (which
    // only get account.profile enqueued) still get ongoing post refresh.
    expect(enqueued.some((entry) => entry.kind === "posts.maintenance")).toBe(true);
    expect(enqueued.some((entry) => entry.kind === "post.metrics" || entry.kind === "post.engagers")).toBe(false);
    // Reschedules ~1h out (hourly), not a day behind.
    expect(rescheduledDueAt!.getTime()).toBeGreaterThan(Date.now() + 55 * 60_000);
    expect(rescheduledDueAt!.getTime()).toBeLessThan(Date.now() + 65 * 60_000);
  });

  it("account.profile drops without touching AppView when the account is disabled", async () => {
    const profiles = vi.fn(async () => [profile]);
    let completed = false;
    const store = stubStore({
      claimJobs: claim({ kind: "account.profile", payload: { did: alice } }),
      async accountEnabled() { return false; },
      async completeJob() { completed = true; },
    });

    await orchestrator(store, stubProtocol({ profiles })).runOnce();

    expect(profiles).not.toHaveBeenCalled();
    expect(completed).toBe(true);
  });

  it("account.profile re-checks a not-yet-confirmed missing profile next cycle without retiring it", async () => {
    let rescheduledDueAt: Date | undefined;
    let completed = false;
    const enqueued: string[] = [];
    let missArgs: [DidString, number] | undefined;
    const store = stubStore({
      claimJobs: claim({ kind: "account.profile", payload: { did: alice } }),
      async accountEnabled() { return true; },
      async registerProfileMiss(did, threshold) { missArgs = [did, threshold]; return false; },
      async enqueue(kind) { enqueued.push(kind); },
      async rescheduleJob(_id, dueAt) { rescheduledDueAt = dueAt; },
      async completeJob() { completed = true; },
    });
    // Empty getProfiles → the profile is (currently) unresolvable.
    const protocol = stubProtocol({ async profiles() { return []; } });

    await orchestrator(store, protocol).runOnce();

    expect(missArgs).toEqual([alice, 3]);
    // Still under threshold: try again ~1h out, and do NO downstream profile work.
    expect(completed).toBe(false);
    expect(rescheduledDueAt!.getTime()).toBeGreaterThan(Date.now() + 55 * 60_000);
    expect(enqueued).toEqual([]);
  });

  it("account.profile retires an account once its missing-profile streak crosses the threshold", async () => {
    let completed = false;
    let rescheduled = false;
    const store = stubStore({
      claimJobs: claim({ kind: "account.profile", payload: { did: alice } }),
      async accountEnabled() { return true; },
      // registerProfileMiss reports the account was disabled (streak reached).
      async registerProfileMiss() { return true; },
      async rescheduleJob() { rescheduled = true; },
      async completeJob() { completed = true; },
    });
    const protocol = stubProtocol({ async profiles() { return []; } });

    await orchestrator(store, protocol).runOnce();

    // The retired account's job completes and is not rescheduled — the hourly
    // re-check of a dead DID stops here.
    expect(completed).toBe(true);
    expect(rescheduled).toBe(false);
  });

  it("piggybacks a profile refresh while an account post is actively replaying", async () => {
    const recentPost: PostMetrics = {
      uri: asAtUriString(`at://${alice}/app.bsky.feed.post/live`),
      cid: asStringFormat("bafyreihphrndnt2cvnv3nk442f6kohdnpagk4xip74f2jn36uoal25vhta", "cid"),
      authorDid: alice,
      createdAt: asDatetimeString(new Date(Date.now() - 30_000).toISOString()),
      indexedAt: asDatetimeString(new Date(Date.now() - 30_000).toISOString()),
      text: "going viral", isReply: false, hasEmbed: false,
      likes: 5, replies: 1, quotes: 0, reposts: 2,
    };
    const profiles = vi.fn(async () => [profile]);
    const steps: string[] = [];
    const store = stubStore({
      claimJobs: claim({ kind: "post.metrics", payload: { uri: recentPost.uri, explicit: false, accountDid: alice } }),
      async beginProfileRefreshIfDue() { return true; },
      async recordAccountSample() { steps.push("account-sample"); },
      async refreshLatestAccountEngagementTotals() { steps.push("re-total"); },
    });

    await orchestrator(store, stubProtocol({ profiles, async posts() { return [recentPost]; } })).runOnce();

    expect(profiles).toHaveBeenCalledWith([alice], undefined);
    expect(steps).toEqual(["account-sample", "re-total"]);
  });

  it("skips the piggyback profile refresh when the throttle is not yet due", async () => {
    const recentPost: PostMetrics = {
      uri: asAtUriString(`at://${alice}/app.bsky.feed.post/live`),
      cid: asStringFormat("bafyreihphrndnt2cvnv3nk442f6kohdnpagk4xip74f2jn36uoal25vhta", "cid"),
      authorDid: alice,
      createdAt: asDatetimeString(new Date(Date.now() - 30_000).toISOString()),
      indexedAt: asDatetimeString(new Date(Date.now() - 30_000).toISOString()),
      text: "going viral", isReply: false, hasEmbed: false,
      likes: 5, replies: 1, quotes: 0, reposts: 2,
    };
    const profiles = vi.fn(async () => [profile]);
    const store = stubStore({
      claimJobs: claim({ kind: "post.metrics", payload: { uri: recentPost.uri, explicit: false, accountDid: alice } }),
      async beginProfileRefreshIfDue() { return false; },
    });

    await orchestrator(store, stubProtocol({ profiles, async posts() { return [recentPost]; } })).runOnce();

    expect(profiles).not.toHaveBeenCalled();
  });

  it("account.posts finalizes the baseline when the feed is exhausted", async () => {
    const steps: string[] = [];
    const store = stubStore({
      claimJobs: claim({
        kind: "account.posts",
        payload: { did: alice, mode: "baseline", runId: 7, profileSampledAt: "2026-08-25T12:00:00Z" },
      }),
      async accountEnabled() { return true; },
      async advanceBaselineRun() { steps.push("advance"); },
      async refreshAccountEngagementTotals() { steps.push("totals"); },
      async finalizeBaselineRun() { steps.push("finalize"); },
      async markAccountPostsBackfilled() { steps.push("backfilled"); },
      async enqueue() { steps.push("enqueue"); },
    });
    const protocol = stubProtocol({ async authorPosts() { return { items: [] }; } });

    await orchestrator(store, protocol).runOnce();

    expect(steps).toContain("totals");
    expect(steps).toContain("finalize");
    expect(steps).toContain("backfilled");
    expect(steps).not.toContain("enqueue"); // no next slice, no fanout
  });

  it("drops a stale audience job instead of running it when audience is disabled", async () => {
    let completed = false;
    const store = stubStore({
      claimJobs: claim({ kind: "audience.followers", payload: { did: alice } }),
      async completeJob() { completed = true; },
    });
    // If the disabled guard failed, this would throw, the job would fail rather
    // than complete, and `completed` would stay false.
    const protocol = stubProtocol({ async followers() { throw new Error("must not enumerate followers"); } });

    await orchestrator(store, protocol).runOnce();

    expect(completed).toBe(true);
  });

  it("runs a bounded engager scan over the account's top posts for an account.audience job", async () => {
    const topUri = asAtUriString(`at://${alice}/app.bsky.feed.post/3top`);
    const discovered: string[] = [];
    let rescheduled = false;
    const store = stubStore({
      claimJobs: claim({ kind: "account.audience", payload: { did: alice } }),
      async postsForAudienceScan() {
        return [{ uri: topUri, createdAt: asDatetimeString("2026-08-27T00:00:00Z") }];
      },
      async upsertAudienceMembers(members) { discovered.push(...members.map((member) => member.did)); },
      async rescheduleJob() { rescheduled = true; },
    });
    const fan = "did:plc:fan" as DidString;
    const protocol = stubProtocol({
      async likes() { return { items: [{ postUri: topUri, actorDid: fan, kind: "like" }] }; },
      async followerRelationships() { return new Map([[fan, false]]); },
    });

    await orchestrator(store, protocol, { audienceEnabled: true }).runOnce();

    expect(discovered).toContain(fan);
    expect(rescheduled).toBe(true); // self-terminating scan reschedules, no fanout
  });

  it("degrades and drops a job that exhausts the retry budget", async () => {
    let degraded: string | undefined;
    let completed = false;
    let failed = false;
    const store = stubStore({
      // attempts 11 -> becomes 12 on this failure, hitting the ceiling.
      claimJobs: async () => [{ id: "1", subject: "s", kind: "account.profile", payload: { did: alice }, attempts: 11 }],
      async accountEnabled() { return true; },
      async degradeAccount(did) { degraded = did; },
      async completeJob() { completed = true; },
      async failJob() { failed = true; },
    });
    const protocol = stubProtocol({ async profiles() { throw new Error("appview down"); } });

    await orchestrator(store, protocol, { maxJobAttempts: 12 }).runOnce();

    expect(degraded).toBe(alice);
    expect(completed).toBe(true);
    expect(failed).toBe(false);
  });
});

describe("Orchestrator concurrency", () => {
  it("refills a free slot while another job is still running", async () => {
    const bob = "did:plc:bob" as DidString;
    const carol = "did:plc:carol" as DidString;
    const releaseSlow = deferred();
    const slowStarted = deferred();
    const fastFinished = deferred();
    const controller = new AbortController();
    let claimCalls = 0;

    const jobs: Job[] = [
      { id: "slow", subject: alice, kind: "account.profile", payload: { did: alice }, attempts: 0 },
      { id: "fast", subject: bob, kind: "account.profile", payload: { did: bob }, attempts: 0 },
      { id: "refill", subject: carol, kind: "account.profile", payload: { did: carol }, attempts: 0 },
    ];
    const store = stubStore({
      async claimJobs(_workerId, limit) {
        claimCalls += 1;
        if (claimCalls === 1) return jobs.slice(0, limit);
        if (claimCalls === 2) return [jobs[2]!];
        return [];
      },
      async accountPostsBackfilled() { return true; },
      async rescheduleJob(id) {
        if (id === "fast") fastFinished.resolve();
      },
    });
    const protocol = stubProtocol({
      async profiles(dids) {
        const did = dids[0]!;
        if (did === alice) {
          slowStarted.resolve();
          await releaseSlow.promise;
        }
        return [{
          ...profile,
          did,
          handle: `${did.slice("did:plc:".length)}.test` as HandleString,
        }];
      },
    });
    const running = orchestrator(store, protocol, { concurrency: 2 }).run(controller.signal);

    let callsBeforeSlowFinished = 0;
    try {
      await slowStarted.promise;
      await fastFinished.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      callsBeforeSlowFinished = claimCalls;
    } finally {
      controller.abort();
      releaseSlow.resolve();
      await running;
    }

    expect(callsBeforeSlowFinished).toBeGreaterThanOrEqual(2);
  });
});

describe("Orchestrator database resilience", () => {
  let controller: AbortController;
  let running: Promise<void> | undefined;
  const timeout = new Error("timeout exceeded when trying to connect");
  const job: Job = { id: "db-job", kind: "sync.flush", subject: "singleton", payload: {}, attempts: 0 };

  beforeEach(() => {
    controller = new AbortController();
    vi.useFakeTimers();
    // Vitest does not virtualize node:timers/promises. Bridge it to the fake
    // clock while retaining its cancellation contract (no orphaned timers).
    vi.mocked(delay).mockImplementation((ms, value, options) => new Promise((resolve, reject) => {
      const signal = options?.signal;
      if (signal?.aborted) { reject(signal.reason); return; }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve(value);
      }, ms);
      const abort = () => { clearTimeout(timer); reject(signal?.reason); };
      signal?.addEventListener("abort", abort, { once: true });
    }));
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    controller.abort();
    await running?.catch(() => {});
    running = undefined;
    expect(vi.getTimerCount()).toBe(0);
    vi.mocked(delay).mockReset();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries claim timeouts with exponential, capped backoff and aborts the wait", async () => {
    const claimJobs = vi.fn(async () => { throw timeout; });
    running = orchestrator(stubStore({ claimJobs }), stubProtocol({})).run(controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(claimJobs).toHaveBeenCalledTimes(1);
    for (const [index, wait] of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000].entries()) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(claimJobs).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(claimJobs).toHaveBeenCalledTimes(index + 2);
    }
    controller.abort();
    await expect(running).resolves.toBeUndefined();
  });

  it("resumes processing after recovery and resets the next claim's backoff", async () => {
    const claimJobs = vi.fn<AnalyticsStore["claimJobs"]>()
      .mockRejectedValueOnce(timeout)
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce([job])
      .mockRejectedValue(timeout);
    const completeJob = vi.fn(async () => {});
    running = orchestrator(stubStore({ claimJobs, completeJob }), stubProtocol({}), { concurrency: 1 }).run(controller.signal);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(completeJob).toHaveBeenCalledExactlyOnceWith(job.id);
    expect(claimJobs).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(999);
    expect(claimJobs).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(claimJobs).toHaveBeenCalledTimes(5);
  });

  it.each(["dispatch", "complete", "reschedule", "fail", "degrade", "complete-degraded"] as const)(
    "backs off after a %s DB timeout and leaves uncertain lease writes alone", async (phase) => {
      const profileJob: Job = { ...job, kind: "account.profile", payload: { did: alice }, attempts: 11 };
      const claimed = phase === "dispatch" || phase === "degrade" || phase === "complete-degraded"
        ? profileJob : job;
      const claimJobs = vi.fn<AnalyticsStore["claimJobs"]>()
        .mockResolvedValueOnce([claimed]).mockResolvedValue([]);
      const completeJob = vi.fn(async () => {
        if (phase === "complete" || phase === "complete-degraded") throw timeout;
      });
      const rescheduleJob = vi.fn(async () => { throw timeout; });
      const failJob = vi.fn(async () => { throw timeout; });
      const degradeAccount = vi.fn(async () => { if (phase === "degrade") throw timeout; });
      const store = stubStore({
        claimJobs, completeJob, rescheduleJob, failJob, degradeAccount,
        async accountEnabled() {
          if (phase === "dispatch") throw timeout;
          throw new Error("application failure");
        },
      });
      // Trigger failure accounting for a job below its normal retry budget.
      if (phase === "fail") claimJobs.mockReset().mockResolvedValueOnce([
        { ...profileJob, attempts: 0 },
      ]).mockResolvedValue([]);
      running = orchestrator(store, stubProtocol({}), {
        concurrency: 1, syncEnabled: phase === "reschedule",
      }).run(controller.signal);
      await vi.advanceTimersByTimeAsync(0);
      expect(claimJobs).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(claimJobs).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(claimJobs).toHaveBeenCalledTimes(2);
      expect(failJob).toHaveBeenCalledTimes(phase === "fail" ? 1 : 0);
      expect(degradeAccount).toHaveBeenCalledTimes(phase === "degrade" || phase === "complete-degraded" ? 1 : 0);
      expect(completeJob).toHaveBeenCalledTimes(phase === "complete" || phase === "complete-degraded" ? 1 : 0);
      expect(rescheduleJob).toHaveBeenCalledTimes(phase === "reschedule" ? 1 : 0);
    },
  );

  it("does not retry a permanent claim error", async () => {
    const fatal = Object.assign(new Error("missing jobs relation"), { code: "42P01" });
    const claimJobs = vi.fn(async () => { throw fatal; });
    running = orchestrator(stubStore({ claimJobs }), stubProtocol({})).run(controller.signal);
    await expect(running).rejects.toBe(fatal);
    expect(claimJobs).toHaveBeenCalledTimes(1);
  });

  it("aborts and drains active jobs on a fatal claim without failure-accounting writes", async () => {
    const fatal = new Error("scheduler SQL bug");
    const started = deferred();
    let stopped = false;
    const claimJobs = vi.fn<AnalyticsStore["claimJobs"]>()
      .mockResolvedValueOnce([{ ...job, kind: "account.profile", payload: { did: alice } }])
      .mockImplementation(async () => { await started.promise; throw fatal; });
    const failJob = vi.fn(async () => {});
    const completeJob = vi.fn(async () => {});
    const protocol = stubProtocol({
      async profiles(_dids, signal) {
        started.resolve();
        await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => {
          stopped = true;
          reject(signal!.reason);
        }, { once: true }));
        return [profile];
      },
    });
    running = orchestrator(stubStore({ claimJobs, failJob, completeJob }), protocol, { concurrency: 2 }).run(controller.signal);
    await expect(running).rejects.toBe(fatal);
    expect(stopped).toBe(true);
    expect(failJob).not.toHaveBeenCalled();
    expect(completeJob).not.toHaveBeenCalled();
  });

  it("does not start jobs returned by an in-flight claim after shutdown", async () => {
    const completeJob = vi.fn(async () => {});
    const failJob = vi.fn(async () => {});
    running = orchestrator(stubStore({
      async claimJobs() { controller.abort(); return [job]; }, completeJob, failJob,
    }), stubProtocol({})).run(controller.signal);
    await running;
    expect(completeJob).not.toHaveBeenCalled();
    expect(failJob).not.toHaveBeenCalled();
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/**
 * The lifecycle-email dispatch job. The worker only holds the clock: it calls the
 * API, which owns the recipients and the SMTP settings. These pin the two things
 * that can silently rot — that an unconfigured deployment never calls out, and
 * that a pass re-arms an hour out rather than spinning.
 */
describe("notifications dispatch", () => {
  function withNotifications(
    store: AnalyticsStore,
    protocol: ProtocolReader,
    notifications: NotificationsClient,
    notificationsEnabled: boolean,
  ): Orchestrator {
    return new Orchestrator(
      store,
      new AccountCollector(protocol, store),
      new PostCollector(protocol, store),
      new AudienceCollector(protocol, store, 10, 100),
      noopSync,
      notifications,
      {
        workerId: "test",
        concurrency: 1,
        leaseSeconds: 120,
        maxJobAttempts: 12,
        maintenanceBatch: 25,
        maintenanceDrainMs: 60_000,
        profilePiggybackMinutes: 5,
        followerRefreshHours: 24,
        audienceEnabled: false,
        audienceScanTopPosts: 10,
        audienceScanRecentPosts: 15,
        audienceScanPagesPerPost: 3,
        postLaunchTrackingEnabled: true,
        syncEnabled: false,
        notificationsEnabled,
      },
    );
  }

  const spy = (counter: { calls: number }): NotificationsClient =>
    ({
      async dispatch() {
        counter.calls += 1;
        return { dryRun: false, scanned: 1, sent: 1, skipped: 0, failed: 0 };
      },
    }) as unknown as NotificationsClient;

  it("ensures the dispatch job only when notifications are configured", async () => {
    const kinds: string[] = [];
    const store = stubStore({
      async ensureJob(kind) {
        kinds.push(kind);
      },
    });
    const protocol = stubProtocol({});
    const counter = { calls: 0 };

    await withNotifications(store, protocol, spy(counter), false).bootstrap();
    expect(kinds).not.toContain("notifications.dispatch");

    kinds.length = 0;
    await withNotifications(store, protocol, spy(counter), true).bootstrap();
    expect(kinds).toContain("notifications.dispatch");
  });

  it("re-arms an hour out after a pass", async () => {
    let dueAt: Date | undefined;
    const store = stubStore({
      claimJobs: claim({ kind: "notifications.dispatch", payload: {} }),
      async rescheduleJob(_id, next) {
        dueAt = next;
      },
    });
    const counter = { calls: 0 };

    await withNotifications(store, stubProtocol({}), spy(counter), true).runOnce();

    expect(counter.calls).toBe(1);
    expect(dueAt!.getTime()).toBeGreaterThan(Date.now() + 55 * 60_000);
  });

  it("completes without calling out when notifications are off", async () => {
    let completed = false;
    const store = stubStore({
      claimJobs: claim({ kind: "notifications.dispatch", payload: {} }),
      async completeJob() {
        completed = true;
      },
    });
    const counter = { calls: 0 };

    await withNotifications(store, stubProtocol({}), spy(counter), false).runOnce();

    expect(counter.calls).toBe(0);
    expect(completed).toBe(true);
  });
});
