import {
  asAtUriString,
  asDatetimeString,
  asStringFormat,
  type DidString,
  type HandleString,
} from "@atproto/lex";
import { assert, describe, expect, it, vi } from "vitest";
import type { AccountProfile, AudienceMember, Engagement, PostMetrics } from "../domain/types.js";
import { AccountCollector } from "./account-collector.js";
import { AudienceCollector } from "./audience-collector.js";
import { PostCollector } from "./post-collector.js";
import { stubProtocol, stubStore } from "../../tests/_util.js";

const alice = "did:plc:alice" as DidString;
const bob = "did:plc:bob" as DidString;
const carol = "did:plc:carol" as DidString;
const dave = "did:plc:dave" as DidString;
const postUri = asAtUriString(`at://${alice}/app.bsky.feed.post/3abc`);
const cid = asStringFormat("bafyreihphrndnt2cvnv3nk442f6kohdnpagk4xip74f2jn36uoal25vhta", "cid");
const createdAt = asDatetimeString("2026-08-25T11:00:00Z");

const profile: AccountProfile = {
  did: alice,
  handle: "alice.test" as HandleString,
  followers: 100,
  following: 50,
  posts: 20,
};

const post: PostMetrics = {
  uri: postUri,
  cid,
  authorDid: alice,
  createdAt,
  indexedAt: createdAt,
  text: "A real post",
  isReply: false,
  hasEmbed: false,
  likes: 12,
  replies: 3,
  quotes: 2,
  reposts: 4,
};

describe("pillar collectors", () => {
  it("builds the post baseline from feed pages without per-post job fanout", async () => {
    const calls: string[] = [];
    const store = stubStore({
      async trackAccount() { calls.push("track-account"); },
      async recordAccountSample() { calls.push("account-sample"); },
      async upsertPost() { calls.push("upsert-post"); return true; },
      async recordPostSample() { calls.push("post-sample"); return true; },
      async upsertPostCurrentMetrics() { calls.push("current-metrics"); },
      async refreshAccountEngagementTotals() { calls.push("engagement-totals"); },
      async finalizeBaselineRun() { calls.push("finalize-run"); },
      async markAccountPostsBackfilled() { calls.push("backfilled"); },
      async enqueue(kind) { calls.push(`job:${kind}`); },
    });
    const protocol = stubProtocol({
      async profiles() { return [profile]; },
      async authorPosts() { return { items: [post] }; },
    });
    const collector = new AccountCollector(protocol, store);

    const observed = await collector.refreshProfile(alice);
    assert(observed.found);
    await collector.collectPostPage(alice, undefined, undefined, 1);
    await collector.finalizeBaseline(alice, 1, observed.sampledAt);

    expect(calls).toContain("account-sample");
    expect(calls).toContain("post-sample");
    expect(calls).toContain("current-metrics");
    expect(calls).toContain("engagement-totals");
    expect(calls).toContain("backfilled");
    // The whole point of W28: discovery creates no post.metrics / post.engagers.
    expect(calls.some((call) => call.startsWith("job:"))).toBe(false);
  });

  it("reports a not-found profile instead of throwing, and records no sample", async () => {
    const calls: string[] = [];
    const store = stubStore({
      async trackAccount() { calls.push("track-account"); },
      async recordAccountSample() { calls.push("account-sample"); },
    });
    // The AppView omits a deleted/deactivated/suspended DID from getProfiles, so
    // the profile array comes back empty. That must be a first-class result the
    // caller can account against a threshold — not an exception to retry forever.
    const protocol = stubProtocol({ async profiles() { return []; } });
    const collector = new AccountCollector(protocol, store);

    const observed = await collector.refreshProfile(alice);

    expect(observed.found).toBe(false);
    expect(calls).toEqual([]);
  });

  it("records changed-only replay points and returns a tiered next poll", async () => {
    const sample = vi.fn(async () => true);
    const collector = new PostCollector(
      stubProtocol({ async posts() { return [post]; } }),
      stubStore({ recordPostSample: sample }),
    );
    const result = await collector.refreshMetrics(postUri, true, 7, 0);
    assert(!result.done);
    expect(sample).toHaveBeenCalledOnce();
    expect(result.unchangedRuns).toBe(0);
    expect(result.notFoundRuns).toBe(0);
    expect(result.sampled).toBe(true);
    expect(result.nextAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("retries a not-yet-indexed launch instead of disabling it (AppView lags the firehose)", async () => {
    // getPosts returns empty because the AppView has not indexed the brand-new
    // post yet — that is index lag, not deletion. The launch path must not repeat
    // the W40 mistake of treating absence as deletion.
    const disabled: string[] = [];
    const collector = new PostCollector(
      stubProtocol({ async posts() { return []; } }),
      stubStore({ async disablePost(uri) { disabled.push(uri); } }),
    );

    const result = await collector.refreshMetrics(postUri, false, 0, 0);

    assert(!result.done);
    expect(result.sampled).toBe(false);
    expect(result.notFoundRuns).toBe(1);
    expect(result.nextAt.getTime()).toBeGreaterThan(Date.now());
    expect(disabled).toEqual([]); // never disabled on an empty read
  });

  it("disables a launch only after the index-lag grace is exhausted", async () => {
    const disabled: string[] = [];
    const collector = new PostCollector(
      stubProtocol({ async posts() { return []; } }),
      stubStore({ async disablePost(uri) { disabled.push(uri); } }),
    );

    // One below the cap: still retrying. At the cap: disabled as never-indexed.
    const stillRetrying = await collector.refreshMetrics(postUri, false, 0, 43);
    assert(!stillRetrying.done);
    expect(disabled).toEqual([]);

    const givenUp = await collector.refreshMetrics(postUri, false, 0, 44);
    expect(givenUp.done).toBe(true);
    expect(disabled).toEqual([postUri]);
  });

  it("enqueues no per-post jobs even when discovery sees a brand-new post", async () => {
    const enqueue = vi.fn(async () => undefined);
    const collector = new AccountCollector(
      stubProtocol({ async authorPosts() { return { items: [post] }; } }),
      stubStore({ async upsertPost() { return true; }, enqueue }),
    );

    const result = await collector.collectPostPage(alice, undefined);

    expect(result.discovered).toBe(1);
    expect(result.sawNew).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refreshes due posts in one getPosts batch and counts a nonempty-response miss without disabling", async () => {
    const missed: { uri: string; threshold: number }[] = [];
    const disabled: string[] = [];
    const secondUri = asAtUriString(`at://${alice}/app.bsky.feed.post/3def`);
    const posts = vi.fn(async () => [post]); // only the first URI still resolves
    const store = stubStore({
      async dueMaintenancePosts() {
        return [{ uri: postUri, createdAt }, { uri: secondUri, createdAt }];
      },
      async registerPostMisses(misses, threshold) {
        missed.push(...misses.map((m) => ({ uri: m.uri, threshold })));
        return []; // below threshold — nothing disabled yet
      },
      async disablePost(uri) { disabled.push(uri); },
    });
    const collector = new AccountCollector(stubProtocol({ posts }), store);

    const result = await collector.refreshDuePosts(alice, 25);

    expect(posts).toHaveBeenCalledOnce();
    expect(result.claimed).toBe(2);
    expect(result.batchFull).toBe(false);
    // A single miss from a nonempty response is recorded, not an outright disable.
    expect(missed).toEqual([{ uri: secondUri, threshold: 3 }]);
    expect(disabled).toEqual([]);
  });

  it("never disables — or even records a miss — when the whole getPosts batch comes back empty", async () => {
    const missed: string[] = [];
    const disabled: string[] = [];
    const secondUri = asAtUriString(`at://${alice}/app.bsky.feed.post/3def`);
    const posts = vi.fn(async () => []); // transient AppView blip: empty 200
    const store = stubStore({
      async dueMaintenancePosts() {
        return [{ uri: postUri, createdAt }, { uri: secondUri, createdAt }];
      },
      async registerPostMisses(misses) { missed.push(...misses.map((m) => m.uri)); return []; },
      async disablePost(uri) { disabled.push(uri); },
    });
    const collector = new AccountCollector(stubProtocol({ posts }), store);

    const result = await collector.refreshDuePosts(alice, 25);

    expect(posts).toHaveBeenCalledOnce();
    // Nothing sampled, nothing missed, nothing disabled; idle rather than drain.
    expect(result.claimed).toBe(0);
    expect(result.batchFull).toBe(false);
    expect(missed).toEqual([]);
    expect(disabled).toEqual([]);
  });

  it("threads the configured miss threshold into the store", async () => {
    let seenThreshold = -1;
    const secondUri = asAtUriString(`at://${alice}/app.bsky.feed.post/3def`);
    const store = stubStore({
      async dueMaintenancePosts() {
        return [{ uri: postUri, createdAt }, { uri: secondUri, createdAt }];
      },
      async registerPostMisses(_misses, threshold) { seenThreshold = threshold; return [secondUri]; },
    });
    const collector = new AccountCollector(stubProtocol({ async posts() { return [post]; } }), store, 2);

    await collector.refreshDuePosts(alice, 25);

    expect(seenThreshold).toBe(2);
  });

  it("samples followers and records post engagers with follower state, touching no Tap/repo tracker", async () => {
    const members: AudienceMember[] = [];
    const edges: Engagement[] = [];
    let followerPage = 0;
    const protocol = stubProtocol({
      async followers() {
        followerPage += 1;
        return followerPage === 1
          ? { items: [{ did: bob }], cursor: "next" }
          : { items: [{ did: carol }] };
      },
      async followerRelationships() {
        return new Map([[bob, true], [carol, false]]);
      },
      async likes() { return { items: [{ postUri, actorDid: carol, kind: "like", occurredAt: createdAt }] }; },
      async reposts() { return { items: [] }; },
      async quotes() { return { items: [] }; },
      async replies() { return [{ postUri, actorDid: bob, kind: "reply", occurredAt: createdAt }]; },
    });
    const store = stubStore({
      async upsertAudienceMembers(input) { members.push(...input); },
      async recordEngagements(input) { edges.push(...input); },
    });
    // No RepoTracker argument exists any more: v2 collectors only write members.
    const collector = new AudienceCollector(protocol, store, 10, 100);

    await collector.refreshFollowers(alice);
    await collector.refreshEngagers(alice, postUri);

    expect(members.some((member) => member.did === carol && member.isEngager)).toBe(true);
    expect(members.some((member) => member.did === carol && member.isFollower === false)).toBe(true);
    expect(members.some((member) => member.did === bob && member.isFollower === true)).toBe(true);
    expect(edges.map((edge) => edge.kind).sort()).toEqual(["like", "reply"]);
  });

  it("scanAudience accumulates engagers across posts, resolves followers once, hydrates sizes once", async () => {
    const members: AudienceMember[] = [];
    const hydrated: string[] = [];
    const secondPost = asAtUriString(`at://${alice}/app.bsky.feed.post/3def`);
    const relationshipCalls: string[][] = [];
    let likeCall = 0;
    let profileCalls = 0;
    const protocol = stubProtocol({
      async likes(uri) {
        likeCall += 1;
        // carol engages both posts (deduped); dave only the second.
        return uri === postUri
          ? { items: [{ postUri: uri, actorDid: carol, kind: "like", occurredAt: createdAt }] }
          : { items: [{ postUri: uri, actorDid: dave, kind: "like", occurredAt: createdAt }] };
      },
      async reposts() { return { items: [] }; },
      async quotes() { return { items: [] }; },
      async replies() { return []; },
      async followerRelationships(_target, dids) {
        relationshipCalls.push([...dids]);
        return new Map([[carol, false], [dave, true]]);
      },
      async profiles(dids) {
        profileCalls += 1;
        return dids.map((did) => ({
          did,
          handle: "fan.test" as HandleString,
          followers: 1_000,
          following: 10,
          posts: 42,
        }));
      },
    });
    const store = stubStore({
      async upsertAudienceMembers(input) { members.push(...input); },
      async upsertActorProfiles(input) { hydrated.push(...input.map((profile) => profile.did)); },
    });
    const collector = new AudienceCollector(protocol, store, 10, 100, 100);

    const count = await collector.scanAudience(alice, [postUri, secondPost], 3);

    expect(count).toBe(2); // carol + dave, deduped across the two posts
    expect(likeCall).toBe(2); // one like scan per post
    expect(relationshipCalls).toHaveLength(1); // follower state resolved once, not per post
    expect(new Set(relationshipCalls[0])).toEqual(new Set([carol, dave]));
    expect(members.some((member) => member.did === dave && member.isFollower === true)).toBe(true);
    expect(profileCalls).toBe(1); // one bounded hydration pass
    expect(new Set(hydrated)).toEqual(new Set([carol, dave]));
  });

  it("scanAudience skips a post whose engagers fail to read and still commits the rest", async () => {
    const members: AudienceMember[] = [];
    const deadPost = asAtUriString(`at://${alice}/app.bsky.feed.post/3dead`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A post deleted upstream: getRepostedBy 500s deterministically. It must not
    // abort the whole scan — the live post's engagers still have to be persisted.
    const protocol = stubProtocol({
      async likes(uri) {
        return uri === postUri
          ? { items: [{ postUri: uri, actorDid: carol, kind: "like", occurredAt: createdAt }] }
          : { items: [] };
      },
      async reposts(uri) {
        if (uri === deadPost) throw new Error("Internal Server Error");
        return { items: [] };
      },
      async quotes() { return { items: [] }; },
      async replies() { return []; },
      async followerRelationships(_target, dids) { return new Map(dids.map((did) => [did, false])); },
      async profiles(dids) {
        return dids.map((did) => ({
          did, handle: "fan.test" as HandleString, followers: 10, following: 1, posts: 1,
        }));
      },
    });
    const store = stubStore({
      async upsertAudienceMembers(input) { members.push(...input); },
    });
    const collector = new AudienceCollector(protocol, store, 10, 100, 100);

    const count = await collector.scanAudience(alice, [postUri, deadPost], 3);

    expect(count).toBe(1); // carol from the live post; the dead post is skipped, not fatal
    expect(members.some((member) => member.did === carol)).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("scanAudience rethrows when every post fails, so the job retries instead of banking an empty scan", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const committed = vi.fn();
    const protocol = stubProtocol({
      async likes() { throw new Error("Internal Server Error"); },
      async reposts() { throw new Error("Internal Server Error"); },
      async quotes() { throw new Error("Internal Server Error"); },
      async replies() { throw new Error("Internal Server Error"); },
    });
    const store = stubStore({ async upsertAudienceMembers() { committed(); } });
    const collector = new AudienceCollector(protocol, store, 10, 100, 100);

    await expect(collector.scanAudience(alice, [postUri], 3)).rejects.toThrow(/all 1 posts failed/);
    expect(committed).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
