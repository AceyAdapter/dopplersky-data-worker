import {
  asAtUriString,
  asDatetimeString,
  asStringFormat,
  type DidString,
} from "@atproto/lex";
import type { RecordEvent } from "@atproto/tap";
import { describe, expect, it, vi } from "vitest";
import type { Engagement, ProtocolActivity } from "../domain/types.js";
import { app } from "../lexicons/index.js";
import { stubStore } from "../../tests/_util.js";
import { createTapIndexer } from "./tap-consumer.js";

const actorDid = "did:plc:audience" as DidString;
const targetDid = "did:plc:target" as DidString;
const cidString = "bafyreihphrndnt2cvnv3nk442f6kohdnpagk4xip74f2jn36uoal25vhta";
const cid = asStringFormat(cidString, "cid");
const createdAt = asDatetimeString("2026-08-25T08:15:00Z");

describe(createTapIndexer, () => {
  it("records ordinary audience posts as activity, independent of target engagement", async () => {
    const activity: ProtocolActivity[] = [];
    const ack = vi.fn(async () => {});
    const indexer = createTapIndexer(stubStore({ async recordActivity(value) { activity.push(value); } }));
    const event: RecordEvent = {
      id: 1,
      type: "record",
      action: "create",
      did: actorDid,
      rev: "3abc",
      collection: app.bsky.feed.post.$type,
      rkey: "3abc",
      cid: cidString,
      live: true,
      record: app.bsky.feed.post.$build({ text: "hello", createdAt }),
    };

    await indexer.onEvent(event, { signal: new AbortController().signal, ack });

    expect(ack).toHaveBeenCalledOnce();
    expect(activity).toMatchObject([{ actorDid, kind: "post", occurredAt: createdAt, live: true }]);
  });

  it("validates and stores cross-PDS like activity plus its engagement edge", async () => {
    const activity: ProtocolActivity[] = [];
    const edges: Engagement[] = [];
    const targetUri = asAtUriString(`at://${targetDid}/app.bsky.feed.post/3target`);
    const indexer = createTapIndexer(stubStore({
      async recordActivity(value) { activity.push(value); },
      async recordEngagements(value) { edges.push(...value); },
    }));
    const event: RecordEvent = {
      id: 2,
      type: "record",
      action: "create",
      did: actorDid,
      rev: "3like",
      collection: app.bsky.feed.like.$type,
      rkey: "3like",
      cid: cidString,
      live: false,
      record: app.bsky.feed.like.$build({ subject: { uri: targetUri, cid }, createdAt }),
    };

    await indexer.onEvent(event, { signal: new AbortController().signal, ack: async () => {} });

    expect(activity[0]).toMatchObject({ kind: "like", subjectUri: targetUri, live: false });
    expect(edges[0]).toMatchObject({ kind: "like", postUri: targetUri, actorDid });
    expect(activity[0]?.cid).toBe(asStringFormat(cidString, "cid"));
  });

  it("retains the follow subject needed for surviving follower acquisition history", async () => {
    const activity: ProtocolActivity[] = [];
    const indexer = createTapIndexer(stubStore({
      async recordActivity(value) { activity.push(value); },
    }));
    const event: RecordEvent = {
      id: 3,
      type: "record",
      action: "create",
      did: actorDid,
      rev: "3follow",
      collection: app.bsky.graph.follow.$type,
      rkey: "3follow",
      cid: cidString,
      live: false,
      record: app.bsky.graph.follow.$build({ subject: targetDid, createdAt }),
    };

    await indexer.onEvent(event, { signal: new AbortController().signal, ack: async () => {} });

    expect(activity).toMatchObject([{
      actorDid,
      kind: "follow",
      subjectDid: targetDid,
      occurredAt: createdAt,
      live: false,
    }]);
  });
});
