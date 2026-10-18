import type { DatetimeString, DidString } from "@atproto/lex";
import type {
  AccountProfile,
  AudienceMember,
  BaselineRun,
  Engagement,
  Job,
  JobKind,
  OutboxEvent,
  PostMetrics,
  ProtocolActivity,
} from "../domain/types.js";

export type CohortInput = {
  targetDid: DidString;
  method: string;
  populationSize: number;
  sampleSize: number;
  scanComplete: boolean;
  seed: string;
};

/**
 * Outcome of one replay-cohort reconciliation: how many posts were in the
 * cohort, and how many rows the statement actually inserted or raised. On a
 * healthy restart `affected` is 0 — the whole cohort already has the right
 * priority — which is exactly why the work must be one statement, not a page
 * walk whose cost is proportional to the cohort rather than to the change.
 */
export type ReplayEnsureResult = {
  cohort: number;
  affected: number;
};

export type DuePost = {
  uri: string;
  createdAt: DatetimeString;
};

/** One standing job for `ensureJobs`: the same fields `ensureJob` takes, unnamed. */
export type EnsureJobInput = {
  kind: JobKind;
  subject: string;
  dueAt: Date;
  payload?: Record<string, unknown>;
  priority?: number;
};

/** A tracked post absent from a nonempty maintenance response, and when to recheck it. */
export type PostMiss = {
  uri: string;
  nextPollAt: Date;
};

export interface AnalyticsStore {
  migrate(): Promise<void>;
  close(): Promise<void>;
  upsertActor(profile: Pick<AccountProfile, "did" | "handle"> & Partial<AccountProfile>): Promise<void>;
  trackAccount(profile: AccountProfile): Promise<void>;
  recordAccountSample(profile: AccountProfile, sampledAt: DatetimeString): Promise<void>;
  /**
   * Publish account engagement totals for the sample at `sampledAt` from the
   * current-metrics table (the completed baseline generation). This sums the
   * account's enabled tracked posts with no timestamp cutoff, so the total
   * equals the post baseline rather than the pages seen before the profile
   * sample (design note).
   */
  refreshAccountEngagementTotals(did: DidString, sampledAt: DatetimeString): Promise<void>;
  /** Recompute totals onto the newest account sample, after maintenance/recent. */
  refreshLatestAccountEngagementTotals(did: DidString): Promise<void>;
  accountPostsBackfilled(did: DidString): Promise<boolean>;
  markAccountPostsBackfilled(did: DidString): Promise<void>;
  /** Enrollment/cancellation gate checked before each account job does work. */
  accountEnabled(did: DidString): Promise<boolean>;
  /**
   * Per-account audience scope (W41). True only when the account is BOTH enabled
   * and `audience_enabled` — the premium-gated switch above core collection.
   * Checked before an `account.audience` scan runs so a cleared flag self-
   * terminates the standing job.
   */
  audienceEnabledForAccount(did: DidString): Promise<boolean>;
  /** DIDs to run the engager audience scan for: enabled AND audience_enabled. */
  audienceEnabledAccountDids(): Promise<DidString[]>;
  /**
   * Opt an account in/out of audience collection (e.g. on a premium change).
   * Returns false when no such tracked account exists.
   */
  setAudienceEnabled(did: DidString, enabled: boolean): Promise<boolean>;
  /**
   * Opt an account into audience collection and enqueue an immediate scan so it
   * starts without a restart (the scan self-drops while the global flag is off).
   * Returns false when no such tracked account exists.
   */
  enableAudience(did: DidString): Promise<boolean>;
  /**
   * Reverse a cancelAccount: re-enable the account and re-establish its standing
   * profile/maintenance jobs so collection resumes without a restart. Returns
   * false when no such tracked account exists.
   */
  reactivateAccount(did: DidString): Promise<boolean>;
  /**
   * Disable an account, cancel its runs, and delete its queued jobs. Returns
   * false when no such tracked account exists.
   */
  cancelAccount(did: DidString): Promise<boolean>;
  /**
   * Operator escape hatch for premium/trial state (`auth.app_user`, migration
   * 022). Clears the trial window and returns the user to `status = 'none'`, so
   * the account can activate a fresh 7-day trial — the thing first-activation-
   * wins otherwise makes impossible, on purpose. This is support/QA tooling: it
   * exists for the operator (reset an account whose trial window was consumed by
   * testing, or that a user legitimately needs re-trialled), is reachable only
   * from the CLI in production, and never runs on its own. Returns false when the
   * DID has no user row.
   */
  resetTrial(did: DidString): Promise<boolean>;
  /**
   * Operator grant of a permanent premium entitlement (`auth.app_user`,
   * migration 022). Sets `status = 'active'`, the one state every premium check
   * already reads as live *without* an expiry test (web
   * `server/utils/entitlement.ts` and the client's tier both short-circuit on
   * it), so a granted account is a "true" premium user with no expiration date.
   *
   * Migration 022 reserved 'active' for real payment; this is the comp path and
   * the only way to reach it while billing does not exist. It is deliberately
   * not reachable from the API or the app — CLI in production only, like
   * `resetTrial`, which is also the way back (it clears the trial window and
   * returns the row to 'none', dropping the entitlement). Returns false when the
   * DID has no user row.
   */
  grantPremium(did: DidString): Promise<boolean>;
  /** Retry budget exhausted: rest the account and its run in `degraded`. */
  degradeAccount(did: DidString, safeError: string): Promise<void>;
  /**
   * The AppView returned no profile for this account (deleted / deactivated /
   * suspended). Increment its consecutive-miss counter; once it reaches
   * `threshold`, disable the account, cancel its runs, and delete its queued
   * jobs — as an operator disable would — and return true. Returns false while
   * still under threshold, and false (no-op) for an already-disabled account. A
   * successful observation clears the streak via `resetProfileMisses`.
   */
  registerProfileMiss(did: DidString, threshold: number): Promise<boolean>;
  /** A successful profile observation clears any accumulated miss streak. */
  resetProfileMisses(did: DidString): Promise<void>;
  /** The single live baseline run for an account, resumed from its cursor. */
  getOrCreateBaselineRun(did: DidString, profileSampledAt: DatetimeString): Promise<BaselineRun>;
  advanceBaselineRun(runId: number, cursor: string | undefined, discovered: number): Promise<void>;
  finalizeBaselineRun(runId: number): Promise<void>;
  /** True while a baseline pagination job is already queued for the account. */
  hasPendingAccountPostsJob(did: DidString): Promise<boolean>;
  /** Atomically claim a daily newest-page scan if one is due, else return false. */
  beginRecentScanIfDue(did: DidString, minHours: number): Promise<boolean>;
  /**
   * Atomically claim a piggybacked profile re-observation if the account is
   * enabled and its last profile refresh is older than `minMinutes`, else return
   * false. Lets an active post replay refresh follower counts between the hourly
   * `account.profile` samples without a burst of replaying posts fanning out
   * `getProfiles` calls.
   */
  beginProfileRefreshIfDue(did: DidString, minMinutes: number): Promise<boolean>;
  upsertPost(post: PostMetrics, reason: "account" | "explicit", accountDid?: DidString): Promise<boolean>;
  /**
   * Seed a just-published post the instant its Jetstream `create` event arrives:
   * track it and write a definitional zero-engagement sample at `created_at`, so
   * the dense replay has a true origin point even before the AppView has indexed
   * the post (getPosts lags the firehose by seconds). A brand-new post has zero
   * likes/replies/quotes/reposts by definition — this is the real starting point,
   * not a fabricated number. Idempotent: a replayed create adds nothing, and it
   * never overwrites metrics the replay has since written (origin sample is
   * unique on `(uri, sampled_at)`; current metrics init only if absent). Parks
   * cold maintenance past the replay window so the `post.metrics` job owns
   * sampling during the launch.
   */
  seedLaunchPost(post: PostMetrics, accountDid: DidString): Promise<void>;
  /** Latest current metrics for one post plus its next maintenance due time. */
  upsertPostCurrentMetrics(
    post: PostMetrics,
    sampledAt: DatetimeString,
    nextPollAt: Date,
    runId?: number,
  ): Promise<void>;
  /** Enabled posts whose current metrics are due for a batched refresh. */
  dueMaintenancePosts(did: DidString, limit: number): Promise<DuePost[]>;
  disablePost(uri: string): Promise<void>;
  /**
   * Record that these posts were absent from a *nonempty* maintenance response.
   * Increments each post's consecutive-miss counter and reschedules it, then
   * disables only those that have now missed `threshold` consecutive cycles.
   * Returns the URIs disabled. A successful sample resets the counter to 0.
   */
  registerPostMisses(misses: PostMiss[], threshold: number): Promise<string[]>;
  recordPostSample(post: PostMetrics, sampledAt: DatetimeString): Promise<boolean>;
  createAudienceCohort(input: CohortInput): Promise<string>;
  upsertAudienceMembers(members: AudienceMember[], cohortId?: string): Promise<void>;
  /**
   * Store hydrated follower/following/post counts (from `getProfiles`) on actor
   * rows, so the audience can be ranked by size. Counts stay NULL until hydrated,
   * never a fabricated zero.
   */
  upsertActorProfiles(profiles: AccountProfile[]): Promise<void>;
  recordEngagements(engagements: Engagement[]): Promise<void>;
  recordEngagementScan(postUri: string, kind: Engagement["kind"], enumerated: number, complete: boolean, cursor?: string): Promise<void>;
  recordActivity(activity: ProtocolActivity): Promise<void>;
  deactivateActivity(recordUri: string): Promise<void>;
  trackedAccountDids(): Promise<DidString[]>;
  /**
   * Reconcile replay work for the restart cohort in one set-based statement:
   * every enabled explicit post at any age, plus every account post created
   * strictly after `replaySince` (null selects explicit posts only). A missing
   * `post.metrics` job is inserted at the cohort's priority; an existing row is
   * only raised, never rescheduled (the same conflict policy as `ensureJobs`).
   *
   * This replaced a URI-keyset page walk over the same cohort. That walk re-ran
   * a merge join per page and re-scanned the tracked-post set in URI order to
   * emit its next 500 rows, so a page cost O(cursor depth): measured against
   * production under load, 250 ms at page 1, ~1.5 s by page 100, 2.8 s by page
   * 155 — several hundred of them for 167,708 in-window posts. Driving from the
   * recent-posts side instead is one statement with one primary-key lookup per
   * cohort post, and it reports the change rather than the scan. Migration 027's
   * `(created_at, uri)` index is what makes the cohort scan cheap.
   */
  ensureReplayJobs(replaySince: DatetimeString | null): Promise<ReplayEnsureResult>;
  /**
   * The bounded, rotating live-audience cohort: each enabled subscriber's most
   * recently-seen engagers (top `perTarget`), unioned across subscribers and
   * globally capped at `globalCap`. This is the audience Jetstream socket's
   * `wantedDids` filter — the single global bound on forward audience capture.
   */
  audienceWatchDids(perTarget: number, globalCap: number): Promise<DidString[]>;
  /**
   * The post set for the bounded `account.audience` engager scan: the union of an
   * account's `topLimit` all-time top-interaction posts (evergreen audience) and
   * its `recentLimit` most-recent *engaged* posts (current audience), deduped. An
   * actively-posting account whose biggest posts are old still gets its present
   * audience sampled, without unbounding the scan (operator, 2026-08-29).
   */
  postsForAudienceScan(did: DidString, topLimit: number, recentLimit: number): Promise<DuePost[]>;
  enqueue(kind: JobKind, subject: string, dueAt: Date, payload?: Record<string, unknown>, priority?: number): Promise<void>;
  /** Insert missing standing work without pulling an existing schedule forward. */
  ensureJob(kind: JobKind, subject: string, dueAt: Date, payload?: Record<string, unknown>, priority?: number): Promise<void>;
  /**
   * The same guarantee for many jobs at once, in one statement per batch. Use
   * this wherever the caller is looping over a cohort: a per-job round trip is
   * ~2.6 ms of pure latency against production Postgres.
   */
  ensureJobs(entries: EnsureJobInput[]): Promise<void>;
  claimJobs(workerId: string, limit: number, leaseSeconds: number): Promise<Job[]>;
  completeJob(id: string): Promise<void>;
  rescheduleJob(id: string, dueAt: Date, payload?: Record<string, unknown>): Promise<void>;
  failJob(id: string, error: unknown, retryAt: Date): Promise<void>;
  outbox(limit: number): Promise<OutboxEvent[]>;
  markOutboxDelivered(ids: string[]): Promise<void>;
  /**
   * Last persisted Jetstream cursor (`time_us`) for a named stream, or undefined
   * if none has been stored yet. Loaded once at startup so a restart resumes the
   * subscription from where it left off instead of subscribing live.
   */
  loadStreamCursor(stream: string): Promise<number | undefined>;
  /**
   * Persist the latest Jetstream cursor for a named stream. Monotonic: never
   * moves the stored cursor backward, so an out-of-order or concurrent write
   * cannot rewind the resume point.
   */
  saveStreamCursor(stream: string, cursor: number): Promise<void>;
}
