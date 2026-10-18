import {
  asAtUriString,
  asDatetimeString,
  currentDatetimeString,
  type DatetimeString,
  type DidString,
} from "@atproto/lex";
import type { ProtocolReader } from "../protocol/appview-client.js";
import { nextMetricRefreshAt } from "../scheduling/cadence.js";
import type { AnalyticsStore } from "../storage/store.js";

export type PostPageResult = {
  cursor?: string;
  discovered: number;
  /** A post on this page was not previously tracked — used to stop recent scans. */
  sawNew: boolean;
};

/**
 * The result of an hourly profile observation. `found: false` means the AppView
 * returned no profile for the DID (deleted / deactivated / suspended) — a
 * distinct, expected outcome the caller accounts against a miss threshold, not a
 * thrown error to retry blindly forever.
 */
export type ProfileObservation =
  | { found: true; sampledAt: DatetimeString }
  | { found: false };

export type MaintenanceResult = {
  claimed: number;
  /** The batch filled to `limit`, so more may be due — drain sooner. */
  batchFull: boolean;
};

/**
 * Account-level collection: the profile observation, the resumable post
 * baseline, and bounded batched maintenance of existing posts.
 *
 * What it deliberately does NOT do any more is fan out. Discovering a post used
 * to enqueue a `post.metrics` job and a `post.engagers` job for it; registering
 * the largest account created 1,635 jobs and tens of thousands of Tap repos
 * from one signup (design note). The author-feed page already carries current
 * metrics, so the baseline is built straight from the pages and no per-post job
 * is created.
 */
export class AccountCollector {
  constructor(
    private readonly protocol: ProtocolReader,
    private readonly store: AnalyticsStore,
    /** Consecutive nonempty-response misses before a cold post is disabled. */
    private readonly missThreshold = 3,
  ) {}

  async refreshProfile(did: DidString, signal?: AbortSignal): Promise<ProfileObservation> {
    const profile = (await this.protocol.profiles([did], signal))[0];
    if (!profile) return { found: false };
    const sampledAt = currentDatetimeString();
    await this.store.trackAccount(profile);
    await this.store.recordAccountSample(profile, sampledAt);
    return { found: true, sampledAt };
  }

  /**
   * Fetch one author-feed page and record every post's current metrics into the
   * current-state table and the changed-only time series. `runId` associates the
   * observation with a baseline generation; recent-discovery passes none.
   */
  async collectPostPage(
    did: DidString,
    cursor: string | undefined,
    signal?: AbortSignal,
    runId?: number,
  ): Promise<PostPageResult> {
    const page = await this.protocol.authorPosts(did, cursor, signal);
    const observedAt = currentDatetimeString();
    const now = new Date();
    let sawNew = false;
    for (const post of page.items) {
      const newlyTracked = await this.store.upsertPost(post, "account", did);
      await this.store.recordPostSample(post, observedAt);
      await this.store.upsertPostCurrentMetrics(
        post,
        observedAt,
        nextMetricRefreshAt(new Date(post.createdAt), now),
        runId,
      );
      if (newlyTracked) sawNew = true;
    }
    return {
      discovered: page.items.length,
      sawNew,
      ...(page.cursor ? { cursor: page.cursor } : {}),
    };
  }

  /** Publish the completed baseline: account total = sum of observed posts. */
  async finalizeBaseline(did: DidString, runId: number, profileSampledAt: DatetimeString): Promise<void> {
    await this.store.refreshAccountEngagementTotals(did, asDatetimeString(profileSampledAt));
    await this.store.finalizeBaselineRun(runId);
    await this.store.markAccountPostsBackfilled(did);
  }

  /** After a recent-discovery scan, re-total onto the newest account sample. */
  async finalizeRecent(did: DidString): Promise<void> {
    await this.store.refreshLatestAccountEngagementTotals(did);
  }

  /**
   * Refresh up to `limit` due posts in a single `getPosts` batch (AppView takes
   * 25 URIs). This is the whole per-account maintenance cost for one wake: one
   * request, not one durable job per post.
   *
   * Absence from the response is treated as deletion — but carefully. A wholly
   * empty response is a transient AppView blip (25 posts do not vanish at once),
   * never a batch of deletions: it samples nothing, disables nothing, and idles
   * instead of tight-draining (which would only hammer a struggling AppView).
   * A post missing from a *nonempty* response is a soft miss; it takes
   * `missThreshold` consecutive such misses to disable, so a truncated or partial
   * body cannot drop a live post. Jetstream still honors real deletions instantly
   * on the delete event; this loop is the cold backstop (design note).
   */
  async refreshDuePosts(did: DidString, limit: number, signal?: AbortSignal): Promise<MaintenanceResult> {
    const due = await this.store.dueMaintenancePosts(did, limit);
    if (due.length === 0) return { claimed: 0, batchFull: false };

    const posts = await this.protocol.posts(due.map((post) => asAtUriString(post.uri)), signal);
    // Total-failure guard: an empty response is a transient blip, not deletions.
    // Leave these posts due and idle (batchFull:false) rather than re-draining
    // the same URIs every couple of seconds into a struggling AppView.
    if (posts.length === 0) return { claimed: 0, batchFull: false };

    const observedAt = currentDatetimeString();
    const now = new Date();
    const seen = new Set(posts.map((post) => post.uri as string));
    for (const post of posts) {
      await this.store.recordPostSample(post, observedAt);
      await this.store.upsertPostCurrentMetrics(
        post,
        observedAt,
        nextMetricRefreshAt(new Date(post.createdAt), now),
      );
    }
    const missed = due
      .filter((post) => !seen.has(post.uri))
      .map((post) => ({ uri: post.uri, nextPollAt: nextMetricRefreshAt(new Date(post.createdAt), now) }));
    if (missed.length > 0) await this.store.registerPostMisses(missed, this.missThreshold);
    // Re-totalling is the caller's decision: it must not run mid-baseline, or a
    // partial sum would be written onto the account sample as if complete.
    return { claimed: due.length, batchFull: due.length === limit };
  }
}
