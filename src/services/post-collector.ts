import { currentDatetimeString, type AtUriString, type DidString } from "@atproto/lex";
import type { ProtocolReader } from "../protocol/appview-client.js";
import {
  LAUNCH_INDEX_RETRY_MS,
  MAX_LAUNCH_INDEX_MISSES,
  POST_REPLAY_WINDOW_MS,
  nextPostPollDelayMs,
  postReplayComplete,
} from "../scheduling/cadence.js";
import type { AnalyticsStore } from "../storage/store.js";

export type PostRefresh =
  | { done: true }
  // `sampled` distinguishes a real metrics observation from an index-lag retry
  // (the post was not in the AppView yet): the caller piggybacks a profile
  // refresh only on a real sample, and the counters round-trip in the job payload.
  | { done: false; nextAt: Date; unchangedRuns: number; notFoundRuns: number; sampled: boolean };

export class PostCollector {
  constructor(
    private readonly protocol: ProtocolReader,
    private readonly store: AnalyticsStore,
  ) {}

  /**
   * One dense replay sample of a post's metrics. Records the changed-only time
   * series row and refreshes the post's current metrics, then either reschedules
   * on the dense ladder or, for a launch-tracked account post past the replay
   * window, hands off to batched maintenance.
   */
  async refreshMetrics(
    uri: AtUriString,
    explicit: boolean,
    unchangedRuns: number,
    notFoundRuns: number,
    signal?: AbortSignal,
    accountDid?: DidString,
  ): Promise<PostRefresh> {
    const post = (await this.protocol.posts([uri], signal))[0];
    if (!post) {
      // Not "deleted" — almost always "the AppView has not indexed this launch
      // yet". Retry on the short launch cadence instead of disabling on the first
      // empty read (design note: absence from a response is not deletion). Only
      // give up after a long grace, by which point a still-absent post is
      // genuinely gone — and a real deletion already disabled it via Jetstream.
      const misses = notFoundRuns + 1;
      if (misses >= MAX_LAUNCH_INDEX_MISSES) {
        await this.store.disablePost(uri);
        return { done: true };
      }
      return {
        done: false,
        nextAt: new Date(Date.now() + LAUNCH_INDEX_RETRY_MS),
        unchangedRuns,
        notFoundRuns: misses,
        sampled: false,
      };
    }
    await this.store.upsertPost(post, explicit ? "explicit" : "account", accountDid);
    const observedAt = currentDatetimeString();
    const changed = await this.store.recordPostSample(post, observedAt);
    const now = new Date();
    const createdAt = new Date(post.createdAt);
    // Park the batched maintenance job past the replay window (for an explicit
    // post, always ahead of the next dense poll) so it never double-samples a
    // post this replay job owns. When an account post's replay completes,
    // next_poll_at is already ~due, so maintenance resumes the cold rotation
    // without any extra write. This also keeps post_current_metrics — the source
    // of account engagement totals and rankings — fresh during the launch.
    const parkAt = explicit
      ? new Date(now.getTime() + POST_REPLAY_WINDOW_MS)
      : new Date(createdAt.getTime() + POST_REPLAY_WINDOW_MS);
    await this.store.upsertPostCurrentMetrics(post, observedAt, parkAt);

    if (postReplayComplete(createdAt, now, explicit)) return { done: true };

    const nextUnchangedRuns = changed ? 0 : unchangedRuns + 1;
    return {
      done: false,
      nextAt: new Date(now.getTime() + nextPostPollDelayMs({
        createdAt,
        now,
        unchangedRuns: nextUnchangedRuns,
        explicit,
      })),
      unchangedRuns: nextUnchangedRuns,
      notFoundRuns: 0, // a successful read clears the index-lag miss run
      sampled: true,
    };
  }
}
