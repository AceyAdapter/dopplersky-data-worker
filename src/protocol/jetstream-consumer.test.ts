import { describe, expect, it, vi } from "vitest";
import { stubStore } from "../../tests/_util.js";
import {
  chunkDids,
  JetstreamConsumer,
  MAX_DIDS_PER_SOCKET,
  parseJetstreamEvent,
  postUri,
  subscribeUrl,
  type JetstreamEvent,
} from "./jetstream-consumer.js";

const alice = "did:plc:alice";
const bob = "did:plc:bob";

function commit(did: string, operation: string, rkey = "abc123", collection = "app.bsky.feed.post"): JetstreamEvent {
  return { did, time_us: 1, kind: "commit", commit: { operation, collection, rkey } };
}

/** A commit carrying a real post record + CID, as a live create/update does. */
function commitWithRecord(did: string, operation: string, rkey = "abc123"): JetstreamEvent {
  return {
    did,
    time_us: 2,
    kind: "commit",
    commit: {
      operation,
      collection: "app.bsky.feed.post",
      rkey,
      cid: "bafyreihphrndnt2cvnv3nk442f6kohdnpagk4xip74f2jn36uoal25vhta",
      record: { $type: "app.bsky.feed.post", text: "hello world", createdAt: "2026-08-31T12:00:00.000Z" },
    },
  };
}

describe(parseJetstreamEvent, () => {
  it("parses a commit envelope and rejects non-JSON / non-objects", () => {
    expect(parseJetstreamEvent(JSON.stringify(commit(alice, "create")))?.did).toBe(alice);
    expect(parseJetstreamEvent("not json")).toBeNull();
    expect(parseJetstreamEvent("42")).toBeNull();
    expect(parseJetstreamEvent("null")).toBeNull();
  });
});

describe(subscribeUrl, () => {
  it("filters server-side to the tracked authors' posts", () => {
    const url = new URL(subscribeUrl("wss://jetstream2.us-east.bsky.network/subscribe", [alice, bob], 99));
    expect(url.searchParams.getAll("wantedCollections")).toEqual(["app.bsky.feed.post"]);
    expect(url.searchParams.getAll("wantedDids")).toEqual([alice, bob]);
    expect(url.searchParams.get("cursor")).toBe("99");
  });
});

describe(chunkDids, () => {
  it("splits the tracked set into per-socket groups, preserving every DID", () => {
    const dids = Array.from({ length: 2 * MAX_DIDS_PER_SOCKET + 1 }, (_, i) => `did:plc:${i}`);
    const chunks = chunkDids(dids);
    expect(chunks).toHaveLength(3);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(MAX_DIDS_PER_SOCKET);
    expect(chunks.flat()).toEqual(dids); // no DID dropped or duplicated
  });

  it("keeps a full chunk's subscribe URL under the edge's ~16KB handshake limit", () => {
    // Real did:plc are 32 chars; a full chunk must still yield a small URL, or
    // the *.bsky.network edge rejects the handshake (the regression this fixes).
    const dids = Array.from({ length: MAX_DIDS_PER_SOCKET }, (_, i) => `did:plc:${String(i).padStart(24, "z")}`);
    const url = subscribeUrl("wss://jetstream2.us-east.bsky.network/subscribe", chunkDids(dids)[0]!);
    expect(url.length).toBeLessThan(16_000);
  });
});

describe("JetstreamConsumer.handleEvent", () => {
  const tracked = new Set([alice]);

  it("schedules a dense replay job when a tracked account posts", async () => {
    const enqueued: { kind: string; subject: string; payload: Record<string, unknown>; priority?: number }[] = [];
    const consumer = new JetstreamConsumer("wss://x/subscribe", stubStore({
      async enqueue(kind, subject, _dueAt, payload, priority) {
        enqueued.push({ kind, subject, payload: payload ?? {}, priority });
      },
    }));

    const acted = await consumer.handleEvent(commit(alice, "create"), tracked);

    expect(acted).toBe(true);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.kind).toBe("post.metrics");
    expect(enqueued[0]?.subject).toBe(postUri(alice, "abc123"));
    expect(enqueued[0]?.payload).toMatchObject({ accountDid: alice, explicit: false });
    expect(enqueued[0]?.priority).toBe(75);
  });

  it("seeds a zero-engagement origin sample from the create record", async () => {
    const seeded: { uri: string; likes: number; createdAt: string; accountDid: string }[] = [];
    const consumer = new JetstreamConsumer("wss://x/subscribe", stubStore({
      async seedLaunchPost(post, accountDid) {
        seeded.push({ uri: post.uri, likes: post.likes, createdAt: post.createdAt, accountDid });
      },
    }));

    const acted = await consumer.handleEvent(commitWithRecord(alice, "create"), tracked);

    expect(acted).toBe(true);
    expect(seeded).toHaveLength(1);
    // The anchor is at the post's own created_at with all counts zero — the true
    // starting point, not a fabricated number.
    expect(seeded[0]).toMatchObject({
      uri: postUri(alice, "abc123"),
      likes: 0,
      createdAt: "2026-08-31T12:00:00.000Z",
      accountDid: alice,
    });
  });

  it("strips a NUL byte from the seeded launch text so the origin insert cannot fail on 0x00", async () => {
    // A live post can carry a literal NUL (U+0000). Postgres text rejects it, so
    // the origin seed would throw and lose the t=0 anchor. The Jetstream path must
    // strip it like the AppView-mapped paths do. Built from fromCharCode(0) to keep
    // this source file NUL-free.
    const nul = String.fromCharCode(0);
    let seededText = "";
    const consumer = new JetstreamConsumer("wss://x/subscribe", stubStore({
      async seedLaunchPost(post) { seededText = post.text; },
    }));
    const event = commitWithRecord(alice, "create");
    // biome-ignore lint: injecting a NUL into the record text for the test
    (event.commit!.record as { text: string }).text = `before${nul}after`;

    await consumer.handleEvent(event, tracked);

    expect(seededText).toBe("beforeafter");
    expect(seededText.includes(nul)).toBe(false);
  });

  it("does not seed on an update — an edit must not reset engagement to zero", async () => {
    const seedLaunchPost = vi.fn(async () => undefined);
    const enqueue = vi.fn(async () => undefined);
    const consumer = new JetstreamConsumer("wss://x/subscribe", stubStore({ seedLaunchPost, enqueue }));

    const acted = await consumer.handleEvent(commitWithRecord(alice, "update"), tracked);

    expect(acted).toBe(true);
    expect(seedLaunchPost).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledOnce(); // an edit still refreshes via the replay job
  });

  it("disables a tracked post on delete (honoring deletion)", async () => {
    const disabled: string[] = [];
    const consumer = new JetstreamConsumer("wss://x/subscribe", stubStore({
      async disablePost(uri) { disabled.push(uri); },
    }));

    const acted = await consumer.handleEvent(commit(alice, "delete"), tracked);

    expect(acted).toBe(true);
    expect(disabled).toEqual([postUri(alice, "abc123")]);
  });

  it("ignores untracked authors, non-post collections, and non-commit events", async () => {
    const enqueue = vi.fn(async () => undefined);
    const disablePost = vi.fn(async () => undefined);
    const consumer = new JetstreamConsumer("wss://x/subscribe", stubStore({ enqueue, disablePost }));

    expect(await consumer.handleEvent(commit(bob, "create"), tracked)).toBe(false);
    expect(await consumer.handleEvent(commit(alice, "create", "r", "app.bsky.feed.like"), tracked)).toBe(false);
    expect(await consumer.handleEvent({ did: alice, kind: "identity" }, tracked)).toBe(false);

    expect(enqueue).not.toHaveBeenCalled();
    expect(disablePost).not.toHaveBeenCalled();
  });
});
