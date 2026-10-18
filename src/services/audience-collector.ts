import { type AtUriString, type DidString } from "@atproto/lex";
import type { AudienceMember, Engagement } from "../domain/types.js";
import { describeError } from "../observability/error-detail.js";
import type { ProtocolReader } from "../protocol/appview-client.js";
import type { AnalyticsStore } from "../storage/store.js";
import { BottomKSampler } from "./sampling.js";

/**
 * Discovers audience members from the public AppView. Two entry points, both
 * bounded and both Tap-free (v2): they only *write* `audience_members` /
 * `engagement_edges`; watching those members' forward activity is the audience
 * Jetstream consumer's job, and nothing here registers a repository anywhere.
 */
export class AudienceCollector {
  constructor(
    private readonly protocol: ProtocolReader,
    private readonly store: AnalyticsStore,
    private readonly sampleSize: number,
    private readonly fullScanLimit: number,
    private readonly engagerScanPageLimit = 100,
    private readonly hydrateLimit = 200,
  ) {}

  async refreshFollowers(targetDid: DidString, signal?: AbortSignal): Promise<void> {
    const seed = `${targetDid}:${new Date().toISOString().slice(0, 7)}`;
    const sampler = new BottomKSampler<AudienceMember>(this.sampleSize, seed);
    let cursor: string | undefined;
    let scanComplete = false;
    do {
      const page = await this.protocol.followers(targetDid, cursor, signal);
      for (const follower of page.items) {
        sampler.add(follower.did, {
          ...follower,
          targetDid,
          isFollower: true,
          isEngager: false,
          inclusionProbability: 1,
        });
      }
      cursor = page.cursor;
      scanComplete = !cursor;
    } while (cursor && sampler.seen < this.fullScanLimit);

    const probability = sampler.inclusionProbability();
    const members = sampler.values().map((member) => ({ ...member, inclusionProbability: probability }));
    const cohortId = await this.store.createAudienceCohort({
      targetDid,
      method: scanComplete ? "deterministic-bottom-k" : "bounded-deterministic-bottom-k",
      populationSize: sampler.seen,
      sampleSize: members.length,
      scanComplete,
      seed,
    });
    await this.store.upsertAudienceMembers(members, cohortId);
  }

  /**
   * Bounded per-account engager discovery. Scans engagers of the account's
   * top-interaction posts (at most `posts.length` × `pagesPerPost` pages per
   * kind), accumulates one deduped engager set across all of them, resolves
   * follower state once, and upserts members once. This is O(top posts), never
   * one job per post — the shape that replaces the W28 fanout. Returns the number
   * of distinct engagers discovered.
   */
  async scanAudience(
    targetDid: DidString,
    posts: readonly AtUriString[],
    pagesPerPost: number,
    signal?: AbortSignal,
  ): Promise<number> {
    const engagements: Engagement[] = [];
    let skipped = 0;
    for (const uri of posts) {
      try {
        engagements.push(...(await this.enumerateEngagements(uri, pagesPerPost, signal)));
      } catch (error) {
        // One post must not sink the whole account's scan. A post deleted
        // upstream fails deterministically — getRepostedBy 500s, getPostThread
        // 400s NotFound (an AppView bug on the deleted-post path) — and used to
        // throw straight out of this loop, so commitEngagers never ran and zero
        // members were persisted for the account (workspace: @bsky.app, four
        // posts deleted in a 90-second burst aborted every scan). Skip the post,
        // keep the engagers gathered from the rest. A real cancellation (the job
        // was aborted) still propagates rather than being swallowed as a skip.
        if (signal?.aborted) throw error;
        skipped += 1;
        console.warn(JSON.stringify({
          level: "warn",
          component: "jobs",
          kind: "account.audience",
          subject: targetDid,
          post: uri,
          note: "skipped a post whose engagers could not be read",
          // Carries the XRPC code + status (e.g. NotFound/400, InternalServerError/
          // 500) so a deleted post reads as exactly that, not a bare message.
          ...describeError(error),
        }));
      }
    }
    // Tolerate a few dead posts, but do not treat a wholesale failure (e.g. the
    // AppView is down) as an empty-but-complete scan: rethrow so the job backs
    // off and retries instead of persisting "0 engagers" as if it were the truth.
    if (posts.length > 0 && skipped === posts.length) {
      throw new Error(
        `audience scan for ${targetDid}: all ${posts.length} posts failed to read`,
      );
    }
    return this.commitEngagers(targetDid, engagements, signal);
  }

  async refreshEngagers(
    targetDid: DidString,
    uri: AtUriString,
    signal?: AbortSignal,
  ): Promise<void> {
    const engagements = await this.enumerateEngagements(uri, this.engagerScanPageLimit, signal);
    await this.commitEngagers(targetDid, engagements, signal);
  }

  /** Enumerate one post's engagers (likes/reposts/quotes paged, replies via thread). */
  private async enumerateEngagements(
    uri: AtUriString,
    pageLimit: number,
    signal?: AbortSignal,
  ): Promise<Engagement[]> {
    const engagements: Engagement[] = [];
    const readers = [
      { kind: "like" as const, read: this.protocol.likes.bind(this.protocol) },
      { kind: "repost" as const, read: this.protocol.reposts.bind(this.protocol) },
      { kind: "quote" as const, read: this.protocol.quotes.bind(this.protocol) },
    ];
    for (const { kind, read } of readers) {
      let cursor: string | undefined;
      let pages = 0;
      let enumerated = 0;
      do {
        const page = await read(uri, cursor, signal);
        engagements.push(...page.items);
        enumerated += page.items.length;
        cursor = page.cursor;
        pages += 1;
      } while (cursor && pages < pageLimit);
      // A page cap that stopped short of the cursor is a bounded sample, not a
      // complete enumeration — record which so the UI can badge it honestly.
      await this.store.recordEngagementScan(uri, kind, enumerated, !cursor, cursor);
    }
    const replies = await this.protocol.replies(uri, signal);
    engagements.push(...replies);
    // getPostThread has no continuation cursor, so completeness cannot be proven.
    await this.store.recordEngagementScan(uri, "reply", replies.length, false);
    return engagements;
  }

  /** Dedupe engagers, resolve follower state once, and persist members + edges. */
  private async commitEngagers(
    targetDid: DidString,
    engagements: Engagement[],
    signal?: AbortSignal,
  ): Promise<number> {
    // The owner is not their own audience: drop self-engagement (the account
    // liking/replying to its own posts) so it never becomes an audience member,
    // an engagement edge, or a watched cohort DID.
    const external = engagements.filter((edge) => edge.actorDid !== targetDid);
    const byActor = new Map<string, AudienceMember>();
    for (const edge of external) {
      byActor.set(edge.actorDid, {
        did: edge.actorDid,
        targetDid,
        isEngager: true,
        inclusionProbability: 1,
      });
    }
    const members = [...byActor.values()];
    if (members.length > 0) {
      const followerState = await this.protocol.followerRelationships(
        targetDid,
        members.map((member) => member.did),
        signal,
      );
      for (const member of members) {
        const isFollower = followerState.get(member.did);
        if (isFollower !== undefined) member.isFollower = isFollower;
      }
    }
    await this.store.recordEngagements(external);
    await this.store.upsertAudienceMembers(members);

    // Hydrate follower/post counts for the most-engaged members so the audience
    // can be ranked by size. getProfiles is the only source of counts; bound the
    // pass to `hydrateLimit`, most-engaged first, rather than every drive-by liker.
    if (members.length > 0 && this.hydrateLimit > 0) {
      const frequency = new Map<string, number>();
      for (const edge of external) {
        frequency.set(edge.actorDid, (frequency.get(edge.actorDid) ?? 0) + 1);
      }
      const topDids = members
        .map((member) => member.did)
        .sort((a, b) => (frequency.get(b) ?? 0) - (frequency.get(a) ?? 0))
        .slice(0, this.hydrateLimit);
      const profiles = await this.protocol.profiles(topDids, signal);
      await this.store.upsertActorProfiles(profiles);
    }
    return members.length;
  }
}
