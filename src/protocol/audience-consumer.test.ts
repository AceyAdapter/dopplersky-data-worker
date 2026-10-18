import { asAtUriString, asDatetimeString, asStringFormat, type DidString } from "@atproto/lex";
import { describe, expect, it, vi } from "vitest";
import type { Engagement, ProtocolActivity } from "../domain/types.js";
import { app } from "../lexicons/index.js";
import { stubStore } from "../../tests/_util.js";
import type { JetstreamEvent } from "./jetstream-consumer.js";
import {
  AUDIENCE_COLLECTIONS,
  AudienceActivityConsumer,
  audienceOptionsUpdate,
  subscribeAudienceUrl,
} from "./audience-consumer.js";

const actorDid = "did:plc:audience" as DidString;
const targetDid = "did:plc:target" as DidString;
const cidString = "bafyreihphrndnt2cvnv3nk442f6kohdnpagk4xip74f2jn36uoal25vhta";
const cid = asStringFormat(cidString, "cid");
const createdAt = asDatetimeString("2026-08-28T09:00:00Z");
const targetUri = asAtUriString(`at://${targetDid}/app.bsky.feed.post/3target`);
const watched = new Set<string>([actorDid]);

function consumer(store = stubStore()): AudienceActivityConsumer {
  return new AudienceActivityConsumer("wss://x/subscribe", store, { perTarget: 10, globalCap: 100 });
}

function commit(
  did: string,
  collection: string,
  record: unknown,
  operation = "create",
  rkey = "3rec",
): JetstreamEvent {
  return { did, time_us: 1, kind: "commit", commit: { operation, collection, rkey, cid: cidString, record } };
}

describe(subscribeAudienceUrl, () => {
  it("carries the four collections and cursor but NOT the cohort DIDs (URL-length safe)", () => {
    const url = new URL(subscribeAudienceUrl("wss://jetstream/subscribe", 42));
    expect(url.searchParams.getAll("wantedCollections")).toEqual([...AUDIENCE_COLLECTIONS]);
    expect(url.searchParams.getAll("wantedDids")).toEqual([]); // DIDs go via options_update
    expect(url.searchParams.get("cursor")).toBe("42");
  });
});

describe(audienceOptionsUpdate, () => {
  it("builds a Jetstream options_update that applies the cohort server-side", () => {
    const message = JSON.parse(audienceOptionsUpdate([actorDid, targetDid]));
    expect(message.type).toBe("options_update");
    expect(message.payload.wantedCollections).toEqual([...AUDIENCE_COLLECTIONS]);
    expect(message.payload.wantedDids).toEqual([actorDid, targetDid]);
  });
});

describe("AudienceActivityConsumer.handleEvent", () => {
  it("records a watched member's like as activity plus an engagement edge", async () => {
    const activity: ProtocolActivity[] = [];
    const edges: Engagement[] = [];
    const c = consumer(stubStore({
      async recordActivity(v) { activity.push(v); },
      async recordEngagements(v) { edges.push(...v); },
    }));

    const record = app.bsky.feed.like.$build({ subject: { uri: targetUri, cid }, createdAt });
    const acted = await c.handleEvent(commit(actorDid, app.bsky.feed.like.$type, record), watched);

    expect(acted).toBe(true);
    expect(activity[0]).toMatchObject({ kind: "like", subjectUri: targetUri, actorDid, live: true });
    expect(edges[0]).toMatchObject({ kind: "like", postUri: targetUri, actorDid });
  });

  it("records a reply post as a reply engagement against the parent", async () => {
    const activity: ProtocolActivity[] = [];
    const edges: Engagement[] = [];
    const c = consumer(stubStore({
      async recordActivity(v) { activity.push(v); },
      async recordEngagements(v) { edges.push(...v); },
    }));

    const record = app.bsky.feed.post.$build({
      text: "nice",
      createdAt,
      reply: { root: { uri: targetUri, cid }, parent: { uri: targetUri, cid } },
    });
    const acted = await c.handleEvent(commit(actorDid, app.bsky.feed.post.$type, record), watched);

    expect(acted).toBe(true);
    expect(activity[0]).toMatchObject({ kind: "reply", subjectUri: targetUri });
    expect(edges[0]).toMatchObject({ kind: "reply", postUri: targetUri, actorDid });
  });

  it("records a follow with its subject, without an engagement edge", async () => {
    const activity: ProtocolActivity[] = [];
    const edges: Engagement[] = [];
    const c = consumer(stubStore({
      async recordActivity(v) { activity.push(v); },
      async recordEngagements(v) { edges.push(...v); },
    }));

    const record = app.bsky.graph.follow.$build({ subject: targetDid, createdAt });
    const acted = await c.handleEvent(commit(actorDid, app.bsky.graph.follow.$type, record), watched);

    expect(acted).toBe(true);
    expect(activity[0]).toMatchObject({ kind: "follow", subjectDid: targetDid });
    expect(edges).toHaveLength(0);
  });

  it("deactivates activity on a delete (honoring deletion)", async () => {
    const deactivated: string[] = [];
    const c = consumer(stubStore({ async deactivateActivity(uri) { deactivated.push(uri); } }));

    const acted = await c.handleEvent(
      commit(actorDid, app.bsky.feed.like.$type, undefined, "delete", "3del"),
      watched,
    );

    expect(acted).toBe(true);
    expect(deactivated).toEqual([`at://${actorDid}/app.bsky.feed.like/3del`]);
  });

  it("ignores authors outside the cohort, off-shape records, and unwatched collections", async () => {
    const recordActivity = vi.fn(async () => {});
    const recordEngagements = vi.fn(async () => {});
    const c = consumer(stubStore({ recordActivity, recordEngagements }));
    const like = app.bsky.feed.like.$build({ subject: { uri: targetUri, cid }, createdAt });

    // author not in the watched cohort
    expect(await c.handleEvent(commit("did:plc:stranger", app.bsky.feed.like.$type, like), watched)).toBe(false);
    // a like record missing its subject fails validation
    expect(await c.handleEvent(
      commit(actorDid, app.bsky.feed.like.$type, { $type: "app.bsky.feed.like", createdAt }),
      watched,
    )).toBe(false);
    // a collection we do not watch
    expect(await c.handleEvent(commit(actorDid, "app.bsky.actor.profile", like), watched)).toBe(false);
    // not a commit
    expect(await c.handleEvent({ did: actorDid, kind: "identity" }, watched)).toBe(false);

    expect(recordActivity).not.toHaveBeenCalled();
    expect(recordEngagements).not.toHaveBeenCalled();
  });
});
