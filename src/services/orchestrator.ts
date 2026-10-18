import { setTimeout as delay } from "node:timers/promises";
import {
  asAtUriString,
  asDatetimeString,
  isDidString,
  type DatetimeString,
  type DidString,
} from "@atproto/lex";
import type { Job } from "../domain/types.js";
import { isTransientDatabaseError } from "../db.js";
import { describeError } from "../observability/error-detail.js";
import type { JobOutcome, WorkerMetrics } from "../observability/metrics.js";
import {
  BASELINE_POSTS_PRIORITY,
  POST_REPLAY_WINDOW_MS,
  RECENT_POSTS_PRIORITY,
  jitteredRetryDelayMs,
  nextEngagerScanDelayMs,
} from "../scheduling/cadence.js";
import type { AnalyticsStore, EnsureJobInput } from "../storage/store.js";
import type { ApiSyncClient } from "../sync/api-sync.js";
import type { NotificationsClient } from "../sync/notifications-client.js";
import type { AccountCollector } from "./account-collector.js";
import type { AudienceCollector } from "./audience-collector.js";
import type { PostCollector } from "./post-collector.js";

type RuntimeOptions = {
  workerId: string;
  concurrency: number;
  leaseSeconds: number;
  maxJobAttempts: number;
  maintenanceBatch: number;
  maintenanceDrainMs: number;
  profilePiggybackMinutes: number;
  followerRefreshHours: number;
  audienceEnabled: boolean;
  audienceScanTopPosts: number;
  audienceScanRecentPosts: number;
  audienceScanPagesPerPost: number;
  postLaunchTrackingEnabled: boolean;
  syncEnabled: boolean;
  /** False leaves the `notifications.dispatch` job a no-op. */
  notificationsEnabled: boolean;
};

type JobResult = { complete: true } | { complete: false; dueAt: Date; payload?: Record<string, unknown> };

const HOUR_MS = 60 * 60_000;
/**
 * How often the lifecycle email pass runs. Hourly, because its copy talks in
 * whole days and nothing about a trial ending changes faster than that. The pass
 * is idempotent on the API side, so a redundant run costs one indexed query and
 * sends nothing.
 */
const NOTIFICATIONS_DISPATCH_MS = HOUR_MS;
const MINUTE_MS = 60_000;
/**
 * How often the profile job re-observes an account's follower/following/post
 * counters. Hourly, not daily, so the dashboard shows movement within today
 * instead of a single sample a day behind. This is cheap: one `getProfiles`
 * call per account per hour, well under the ten-minute loop's old ~288k/day at
 * 1,000 accounts (W28).
 */
const PROFILE_REFRESH_MS = HOUR_MS;
/**
 * Consecutive hourly `account.profile` misses (the AppView returns no profile)
 * before the account is retired as unresolvable. ~3h of a durably-absent DID —
 * long enough to ride out a transient 404 during a PDS migration, short enough
 * to stop re-checking a deleted/deactivated/suspended account forever. Mirrors
 * the `posts.maintenance` miss threshold for cold posts.
 */
const PROFILE_MISS_THRESHOLD = 3;
/**
 * Idle interval for the maintenance heartbeat when no post was due this wake. It
 * must be no coarser than the finest `nextMetricRefreshAt` rung (~15m) or a young
 * post's fast-refresh target would be missed until the next wake. A due-less wake
 * costs a single indexed SELECT and no AppView call, so a short interval is safe.
 */
const MAINTENANCE_IDLE_MS = 15 * MINUTE_MS;
/** A recent-discovery scan never reads more than this many newest pages. */
const RECENT_PAGE_BUDGET = 3;
/**
 * Minimum spacing between recent-discovery scans. A page view can re-pull the
 * profile job, and the profile job now runs hourly, so this guard is what keeps
 * new-post discovery bounded. Set to a few hours (not ~daily) so a post the
 * author makes today is discovered and starts refreshing the same day.
 */
const RECENT_SCAN_MIN_HOURS = 3;
/**
 * How often a subscriber's bounded engager scan re-runs. Refreshes `audience_
 * members.last_seen_at`, which is what rotates the live Jetstream cohort toward
 * whoever is currently engaging. Every few hours keeps the cohort fresh without
 * re-reading the AppView constantly; the live socket itself refreshes far faster.
 */
const AUDIENCE_SCAN_MS = 6 * HOUR_MS;
/**
 * Lease priority for `account.audience`. Below account-owned post.metrics (75)
 * and the hourly account.profile (80), but above posts.maintenance (55).
 * `rescheduleJob` preserves it across the scan's own repeats.
 */
const AUDIENCE_JOB_PRIORITY = 70;

export class Orchestrator {
  constructor(
    private readonly store: AnalyticsStore,
    private readonly accounts: AccountCollector,
    private readonly posts: PostCollector,
    private readonly audience: AudienceCollector,
    private readonly sync: ApiSyncClient,
    private readonly notifications: NotificationsClient,
    private readonly options: RuntimeOptions,
    private readonly metrics?: WorkerMetrics,
  ) {}

  async bootstrap(): Promise<void> {
    const startedAt = performance.now();
    const now = new Date();
    // Batch every standing account job into one write rather than two round
    // trips per account (and one more per audience account). This runs before
    // the dashboard starts, so its cost is startup latency.
    const standingAccountJobs: EnsureJobInput[] = [];
    for (const did of await this.store.trackedAccountDids()) {
      standingAccountJobs.push(
        { kind: "account.profile", subject: did, dueAt: now, payload: { did }, priority: 80 },
        { kind: "posts.maintenance", subject: did, dueAt: now, payload: { did }, priority: 55 },
      );
    }
    if (this.options.audienceEnabled) {
      // Engager discovery is the v2 audience path (bounded, Tap-free). It runs
      // only for accounts explicitly opted into audience collection (W41), not
      // every tracked account — the premium-gated subset. The follower
      // statistical sample (`audience.followers`) stays available but is no
      // longer auto-enqueued: v1 centres on engagers, not lurkers.
      // Priority 70 keeps the bounded 6-hourly scan below freshness-sensitive
      // account post replay (75) and profile refresh (80), but above cold batched
      // maintenance (55). `rescheduleJob` preserves this across repeats.
      for (const did of await this.store.audienceEnabledAccountDids()) {
        standingAccountJobs.push({
          kind: "account.audience",
          subject: did,
          dueAt: now,
          payload: { did },
          priority: AUDIENCE_JOB_PRIORITY,
        });
      }
    }
    await this.store.ensureJobs(standingAccountJobs);
    // Resume standing replay jobs across restarts. Explicit (operator-tracked)
    // posts always resume. Launch-tracked account posts resume only while still
    // inside the replay window — this is bounded to recent posts, not the W28
    // per-post baseline fanout: older account posts are owned by the batched
    // maintenance job above, and Jetstream schedules brand-new posts live.
    //
    // One set-based statement, not a page walk. The walk re-ran its merge join
    // per page and re-scanned the tracked-post set in URI order to emit the next
    // 500 rows, so a page cost O(cursor depth) — measured on production under
    // load at 250 ms for page 1 rising to 2.8 s by page 155, several hundred
    // pages for 167,708 in-window posts, which was the whole cold start. The
    // statement reports the change (`affected`) rather than the scan, and on a
    // healthy restart that number is 0.
    const replaySince = this.options.postLaunchTrackingEnabled
      ? asDatetimeString(new Date(now.getTime() - POST_REPLAY_WINDOW_MS).toISOString())
      : null;
    const replay = await this.store.ensureReplayJobs(replaySince);
    if (this.options.syncEnabled) {
      await this.store.ensureJobs([
        { kind: "sync.flush", subject: "singleton", dueAt: now, payload: {}, priority: 20 },
      ]);
    }
    if (this.options.notificationsEnabled) {
      // Priority 10: below everything that collects data. A courtesy email is
      // never more urgent than the pipeline, and the job re-arms itself hourly.
      await this.store.ensureJob("notifications.dispatch", "singleton", now, {}, 10);
    }
    // Startup cost is otherwise invisible: the worker makes no other write until
    // it is listening, so this line is what tells an operator whether a slow
    // deploy was bootstrap or something else.
    console.log(JSON.stringify({
      level: "info",
      component: "bootstrap",
      message: "standing jobs ensured",
      accounts: standingAccountJobs.length,
      replayPosts: replay.cohort,
      replayEnsured: replay.affected,
      elapsedMs: Math.round(performance.now() - startedAt),
    }));
  }

  async runOnce(signal?: AbortSignal): Promise<number> {
    const jobs = await this.store.claimJobs(
      this.options.workerId,
      this.options.concurrency,
      this.options.leaseSeconds,
    );
    for (const job of jobs) this.metrics?.recordClaim(job.kind);
    await Promise.all(jobs.map((job) => this.process(job, signal)));
    return jobs.length;
  }

  async run(signal: AbortSignal): Promise<void> {
    const active = new Set<Promise<void>>();
    const stop = new AbortController();
    const jobSignal = AbortSignal.any([signal, stop.signal]);
    let fatalError: unknown;
    let failed = false;
    let failures = 0;
    let retryNotBefore = 0;
    let failureVersion = 0;

    const backoff = (error: unknown, phase: "claim" | "job", job?: Job): void => {
      // Retry availability failures, but never hot-loop or grow an unbounded
      // exponent. Jitter is upward-only: minimum 1s, maximum 30s.
      failures = Math.min(failures + 1, 6);
      failureVersion += 1;
      const retryMs = Math.min(30_000, 1_000 * 2 ** (failures - 1) * (1 + Math.random() * 0.2));
      retryNotBefore = Math.max(retryNotBefore, performance.now() + retryMs);
      console.error(JSON.stringify({
        level: "error", component: "scheduler", phase, retryMs,
        ...(job ? { jobId: job.id, kind: job.kind, recovery: "lease expiry" } : {}),
        ...describeError(error),
      }));
    };

    const start = (job: Job): void => {
      this.metrics?.recordClaim(job.kind);
      let task!: Promise<void>;
      task = this.process(job, jobSignal)
        .catch((error: unknown) => {
          if (jobSignal.aborted) return;
          if (isTransientDatabaseError(error)) {
            backoff(error, "job", job);
          } else {
            if (!failed) fatalError = error;
            failed = true;
          }
        })
        .finally(() => active.delete(task));
      active.add(task);
    };

    try {
      while (!signal.aborted) {
        if (failed) throw fatalError;
        const remaining = retryNotBefore - performance.now();
        if (remaining > 0) {
          await delay(remaining, undefined, { signal });
          continue;
        }

        const capacity = this.options.concurrency - active.size;
        if (capacity > 0) {
          let jobs: Job[];
          const version = failureVersion;
          try {
            jobs = await this.store.claimJobs(
              this.options.workerId,
              capacity,
              this.options.leaseSeconds,
            );
          } catch (error) {
            if (signal.aborted) break;
            if (!isTransientDatabaseError(error)) throw error;
            backoff(error, "claim");
            continue;
          }
          if (signal.aborted) break; // Claimed but not started: recover by lease expiry.
          if (version === failureVersion) failures = 0;
          for (const job of jobs) start(job);
          // Fill any capacity left when SKIP LOCKED returned fewer rows than the
          // requested limit, then wait below if the queue really is empty.
          if (jobs.length > 0) continue;
        }

        // A long job is not a batch barrier. Cancel the losing timer when a slot
        // frees up, and let shutdown interrupt even a fully occupied scheduler.
        const wake = new AbortController();
        try {
          await Promise.race([
            ...active,
            delay(1_000, undefined, { signal: AbortSignal.any([signal, wake.signal]) }),
          ]);
        } finally {
          wake.abort();
        }
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      stop.abort();
      await Promise.allSettled(active);
    }
  }

  private async process(job: Job, signal?: AbortSignal): Promise<void> {
    const started = performance.now();
    let outcome: JobOutcome = "failed";
    let observedError: unknown;
    try {
      const result = await this.dispatch(job, signal);
      if (signal?.aborted) return; // Leave the lease alone during shutdown.
      if (result.complete) {
        await this.store.completeJob(job.id);
        outcome = "completed";
      } else {
        await this.store.rescheduleJob(job.id, result.dueAt, result.payload);
        outcome = "rescheduled";
      }
    } catch (error) {
      observedError = error;
      if (signal?.aborted) return;
      // A connection failure can hide a committed write. Do not retry completion,
      // rescheduling or failure accounting by id: the lease may already belong to
      // another worker when the DB recovers. Let unacknowledged leases expire;
      // infrastructure outages must not spend the account's job-attempt budget.
      if (isTransientDatabaseError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const attempts = job.attempts + 1;
      try {
        if (attempts >= this.options.maxJobAttempts) {
          // Bounded application failure: the hourly profile can re-attempt a
          // degraded baseline from its committed cursor.
          const did = jobDid(job);
          if (did) await this.store.degradeAccount(did, message);
          if (signal?.aborted) return;
          await this.store.completeJob(job.id);
          outcome = "degraded";
        } else {
          const retryAt = new Date(Date.now() + jitteredRetryDelayMs(job.attempts));
          await this.store.failJob(job.id, error, retryAt);
          outcome = "failed";
        }
      } catch (cleanupError) {
        // The scheduler observes this rejection immediately, backs off transient
        // failures, and never retries uncertain cleanup writes on the old lease.
        console.error(JSON.stringify({
          level: "error", component: "jobs", jobId: job.id, kind: job.kind,
          phase: "failure-accounting", originalError: message,
          ...describeError(cleanupError),
        }));
        throw cleanupError;
      }
      console.error(JSON.stringify({
        level: "error",
        component: "jobs",
        jobId: job.id,
        kind: job.kind,
        subject: job.subject,
        attempts,
        degraded: attempts >= this.options.maxJobAttempts,
        // describeError carries the XRPC code + HTTP status (e.g. NotFound/400,
        // InternalServerError/500) alongside the human message, so a failing job
        // line localizes the upstream failure instead of showing only "Internal
        // Server Error" with no code, status, or endpoint.
        ...describeError(error),
      }));
    } finally {
      this.metrics?.recordJob(job.kind, outcome, performance.now() - started, observedError);
    }
  }

  private async dispatch(job: Job, signal?: AbortSignal): Promise<JobResult> {
    switch (job.kind) {
      case "account.profile":
        return this.runProfile(job, signal);
      case "account.posts":
        return this.runPostPage(job, signal);
      case "posts.maintenance":
        return this.runMaintenance(job, signal);
      case "audience.followers": {
        if (!this.options.audienceEnabled) return { complete: true };
        const did = payloadDid(job);
        if (!(await this.store.accountEnabled(did))) return { complete: true };
        await this.audience.refreshFollowers(did, signal);
        return repeatIn(this.options.followerRefreshHours * HOUR_MS, { did });
      }
      case "account.audience": {
        // Bounded engager discovery for one subscriber: scan engagers of its
        // top-interaction posts AND its most-recent engaged posts (deduped),
        // capped by posts × pages. No per-post job fanout and no Tap — the
        // discovered members feed the rotating live cohort. The recent half keeps
        // the audience current for accounts whose biggest posts are old.
        if (!this.options.audienceEnabled) return { complete: true };
        const did = payloadDid(job);
        // Self-terminate if this account is disabled OR opted out of audience
        // (W41): clearing `audience_enabled` stops the standing scan on its next
        // run without a separate cancellation path.
        if (!(await this.store.audienceEnabledForAccount(did))) return { complete: true };
        const posts = await this.store.postsForAudienceScan(
          did,
          this.options.audienceScanTopPosts,
          this.options.audienceScanRecentPosts,
        );
        if (posts.length > 0) {
          await this.audience.scanAudience(
            did,
            posts.map((post) => asAtUriString(post.uri)),
            this.options.audienceScanPagesPerPost,
            signal,
          );
        }
        return repeatIn(AUDIENCE_SCAN_MS, { did });
      }
      case "post.metrics": {
        const uri = asAtUriString(requiredString(job, "uri"));
        const explicit = job.payload.explicit === true;
        const unchangedRuns = optionalNumber(job, "unchangedRuns") ?? 0;
        const notFoundRuns = optionalNumber(job, "notFoundRuns") ?? 0;
        const rawAccountDid = optionalString(job, "accountDid");
        const accountDid = rawAccountDid && isDidString(rawAccountDid) ? rawAccountDid : undefined;
        const refreshed = await this.posts.refreshMetrics(uri, explicit, unchangedRuns, notFoundRuns, signal, accountDid);
        // While one of a tracked account's own posts is actively replaying, keep
        // the account's follower counts fresh alongside it so new followers show
        // up as the post gains traction — instead of lagging up to an hour behind
        // the next account.profile sample. Only on a real sample, not an index-lag
        // retry (no point re-reading a profile while we wait for the AppView to
        // index the post). Throttled and best-effort (below).
        if (accountDid && !refreshed.done && refreshed.sampled) await this.piggybackProfile(accountDid, signal);
        if (refreshed.done) return { complete: true };
        return {
          complete: false,
          dueAt: refreshed.nextAt,
          payload: {
            uri,
            explicit,
            unchangedRuns: refreshed.unchangedRuns,
            notFoundRuns: refreshed.notFoundRuns,
            ...(accountDid ? { accountDid } : {}),
          },
        };
      }
      case "post.engagers": {
        if (!this.options.audienceEnabled) return { complete: true };
        const uri = asAtUriString(requiredString(job, "uri"));
        const targetDid = payloadDid(job, "targetDid");
        if (!(await this.store.accountEnabled(targetDid))) return { complete: true };
        const createdAt = new Date(requiredString(job, "createdAt"));
        if (!Number.isFinite(createdAt.getTime())) throw new Error("post.engagers requires a valid createdAt");
        await this.audience.refreshEngagers(targetDid, uri, signal);
        return repeatIn(nextEngagerScanDelayMs(createdAt, new Date()), {
          uri,
          targetDid,
          createdAt: createdAt.toISOString(),
        });
      }
      case "sync.flush": {
        if (!this.options.syncEnabled) return { complete: true };
        const delivered = await this.sync.flush(signal);
        return repeatIn(delivered > 0 ? 1_000 : 30_000, {});
      }
      case "notifications.dispatch": {
        if (!this.options.notificationsEnabled) return { complete: true };
        const summary = await this.notifications.dispatch(signal);
        // A pass that failed some sends is reported, not thrown: the API already
        // released those claims, so the next hourly run retries them. Throwing
        // would retry within seconds and hammer a provider that is already unwell.
        if (summary && summary.failed > 0) {
          console.log(JSON.stringify({
            level: "warn",
            component: "notifications",
            message: "dispatch completed with failures",
            sent: summary.sent,
            failed: summary.failed,
          }));
        }
        return repeatIn(NOTIFICATIONS_DISPATCH_MS, {});
      }
    }
  }

  /**
   * Hourly profile observation. Exact follower/following/post counters, plus
   * ensuring the baseline run is progressing (or, once complete, a guarded
   * newest-page scan). Reschedules hourly so today's growth shows within the day
   * — still far under the old ten-minute loop that alone was ~288k AppView
   * requests/day at 1,000 accounts (W28).
   */
  private async runProfile(job: Job, signal?: AbortSignal): Promise<JobResult> {
    const did = payloadDid(job);
    if (!(await this.store.accountEnabled(did))) return { complete: true };

    const observed = await this.accounts.refreshProfile(did, signal);
    if (!observed.found) {
      // Deleted / deactivated / suspended: no profile to sample, and no amount of
      // retrying resurrects a dead DID. Count the miss; retire the account once a
      // sustained streak confirms it, otherwise try again next hour. Either way we
      // stop here rather than throwing an "account.profile" error every hour.
      const retired = await this.store.registerProfileMiss(did, PROFILE_MISS_THRESHOLD);
      console.error(JSON.stringify({
        level: retired ? "warn" : "info",
        component: "jobs",
        kind: "account.profile",
        subject: did,
        message: retired
          ? `disabled unresolvable account after ${PROFILE_MISS_THRESHOLD} consecutive profile misses`
          : "profile not found; will re-check next cycle",
      }));
      return retired ? { complete: true } : repeatIn(PROFILE_REFRESH_MS, { did });
    }
    const sampledAt = observed.sampledAt;
    // A live profile clears any accumulated miss streak (e.g. a reactivated
    // account, or a transient AppView 404 that has since recovered).
    await this.store.resetProfileMisses(did);

    // Ensure the maintenance heartbeat exists. Bootstrap and the CLI enqueue it,
    // but API registration only enqueues account.profile — without this an
    // API-registered account would get no ongoing post-metric refresh until a
    // worker restart. Deduped with LEAST(due_at), so this only ever pulls the
    // heartbeat sooner: an API-registered account starts refreshing its posts on
    // the fast rungs promptly instead of waiting hours for a first wake.
    await this.store.enqueue("posts.maintenance", did, new Date(Date.now() + MAINTENANCE_IDLE_MS), { did }, 55);

    if (!(await this.store.accountPostsBackfilled(did))) {
      await this.ensureBaselineRun(did, sampledAt);
    } else if (await this.store.beginRecentScanIfDue(did, RECENT_SCAN_MIN_HOURS)) {
      await this.enqueuePostPage(did, "recent", undefined, sampledAt, undefined, RECENT_PAGE_BUDGET);
    }
    return repeatIn(PROFILE_REFRESH_MS, { did });
  }

  /**
   * Opportunistic profile re-observation piggybacked on an active post replay.
   * Bounded and best-effort: `beginProfileRefreshIfDue` claims the throttle
   * atomically (so a burst of simultaneously-replaying posts triggers at most one
   * `getProfiles` per account per window, and a disabled account is never
   * re-observed), and any failure is swallowed — the post replay that triggered
   * this must not fail, and the hourly `account.profile` job stays the reliable
   * path. The re-total is cheap: `post_current_metrics` is already fresh from the
   * replay, so follower gains and rising engagement land on the same new sample.
   */
  private async piggybackProfile(did: DidString, signal?: AbortSignal): Promise<void> {
    if (!(await this.store.beginProfileRefreshIfDue(did, this.options.profilePiggybackMinutes))) return;
    try {
      // Opportunistic and best-effort: a not-found here is left to the hourly
      // account.profile job, which owns miss accounting — the piggyback must not
      // double-count misses, and finalizeRecent has nothing to re-total.
      const observed = await this.accounts.refreshProfile(did, signal);
      if (!observed.found) return;
      await this.accounts.finalizeRecent(did);
    } catch (error) {
      console.error(JSON.stringify({
        level: "warn",
        component: "jobs",
        kind: "post.metrics",
        subject: did,
        message: `piggyback profile refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      }));
    }
  }

  /** One author-feed page for a baseline or recent-discovery run. */
  private async runPostPage(job: Job, signal?: AbortSignal): Promise<JobResult> {
    const did = payloadDid(job);
    if (!(await this.store.accountEnabled(did))) return { complete: true };
    const mode = requiredString(job, "mode");
    const cursor = optionalString(job, "cursor");
    const profileSampledAt = asDatetimeString(requiredString(job, "profileSampledAt"));

    if (mode === "baseline") {
      const runId = requiredNumber(job, "runId");
      const page = await this.accounts.collectPostPage(did, cursor, signal, runId);
      await this.store.advanceBaselineRun(runId, page.cursor, page.discovered);
      if (page.cursor) {
        await this.enqueuePostPage(did, "baseline", page.cursor, profileSampledAt, runId);
      } else {
        await this.accounts.finalizeBaseline(did, runId, profileSampledAt);
      }
      return { complete: true };
    }

    // recent discovery: page newest-first until a known post or the page budget.
    const pagesLeft = (optionalNumber(job, "pagesLeft") ?? RECENT_PAGE_BUDGET) - 1;
    const page = await this.accounts.collectPostPage(did, cursor, signal);
    if (page.cursor && page.sawNew && pagesLeft > 0) {
      await this.enqueuePostPage(did, "recent", page.cursor, profileSampledAt, undefined, pagesLeft);
    } else {
      await this.accounts.finalizeRecent(did);
    }
    return { complete: true };
  }

  /** Batched cold-post maintenance: one `getPosts` call per wake, ≤ batch URIs. */
  private async runMaintenance(job: Job, signal?: AbortSignal): Promise<JobResult> {
    const did = payloadDid(job);
    if (!(await this.store.accountEnabled(did))) return { complete: true };
    const result = await this.accounts.refreshDuePosts(did, this.options.maintenanceBatch, signal);
    // Only republish account totals once the baseline generation is complete, so
    // an in-progress baseline never shows a partial sum as the account total.
    if (result.claimed > 0 && (await this.store.accountPostsBackfilled(did))) {
      await this.accounts.finalizeRecent(did);
    }
    // A full batch means more may be due — drain soon; otherwise idle briefly so
    // a young post still hits its ~15m/1h/3h fast-refresh rungs promptly. An idle
    // wake with nothing due makes no AppView call, so this stays cheap.
    return repeatIn(result.batchFull ? this.options.maintenanceDrainMs : MAINTENANCE_IDLE_MS, { did });
  }

  private async ensureBaselineRun(did: DidString, sampledAt: DatetimeString): Promise<void> {
    // Idempotent under a page-view storm: a run already paginating is left alone.
    if (await this.store.hasPendingAccountPostsJob(did)) return;
    const run = await this.store.getOrCreateBaselineRun(did, sampledAt);
    const profileSampledAt = run.profileSampledAt ?? sampledAt;
    await this.enqueuePostPage(did, "baseline", run.cursor, profileSampledAt, run.id);
  }

  private async enqueuePostPage(
    did: DidString,
    mode: "baseline" | "recent",
    cursor: string | undefined,
    profileSampledAt: DatetimeString,
    runId?: number,
    pagesLeft?: number,
  ): Promise<void> {
    const payload: Record<string, unknown> = { did, mode, profileSampledAt };
    if (cursor !== undefined) payload.cursor = cursor;
    if (runId !== undefined) payload.runId = runId;
    if (pagesLeft !== undefined) payload.pagesLeft = pagesLeft;
    await this.store.enqueue(
      "account.posts",
      `${did}:${mode}:${cursor ?? "start"}`,
      new Date(),
      payload,
      mode === "baseline" ? BASELINE_POSTS_PRIORITY : RECENT_POSTS_PRIORITY,
    );
  }
}

function repeatIn(ms: number, payload: Record<string, unknown>): JobResult {
  return { complete: false, dueAt: new Date(Date.now() + ms), payload };
}

/** The DID a job's degraded/cancel state attaches to, if any. */
function jobDid(job: Job): DidString | undefined {
  const value = job.payload.did ?? job.payload.targetDid;
  return typeof value === "string" && isDidString(value) ? value : undefined;
}

function payloadDid(job: Job, key = "did"): DidString {
  const value = requiredString(job, key);
  if (!isDidString(value)) throw new Error(`${key} is not a valid DID`);
  return value;
}

function requiredString(job: Job, key: string): string {
  const value = job.payload[key];
  if (typeof value !== "string" || !value) throw new Error(`${job.kind} requires payload.${key}`);
  return value;
}

function optionalString(job: Job, key: string): string | undefined {
  const value = job.payload[key];
  return typeof value === "string" && value ? value : undefined;
}

function optionalNumber(job: Job, key: string): number | undefined {
  const value = job.payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requiredNumber(job: Job, key: string): number {
  const value = optionalNumber(job, key);
  if (value === undefined) throw new Error(`${job.kind} requires numeric payload.${key}`);
  return value;
}
