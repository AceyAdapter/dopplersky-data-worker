import {
  asAtUriString,
  asStringFormat,
  currentDatetimeString,
  type AtUriString,
} from "@atproto/lex";
import { LexIndexer, Tap, type TapChannel } from "@atproto/tap";
import type { ActivityKind, EngagementKind, ProtocolActivity } from "../domain/types.js";
import { app } from "../lexicons/index.js";
import type { AnalyticsStore } from "../storage/store.js";

export interface RepoTracker {
  addRepos(dids: string[]): Promise<void>;
}

export class TapConsumer implements RepoTracker, AsyncDisposable {
  readonly tap: Tap;
  readonly store: AnalyticsStore;
  #channel?: TapChannel;

  constructor(url: string, store: AnalyticsStore, adminPassword?: string) {
    this.tap = new Tap(url, adminPassword ? { adminPassword } : {});
    this.store = store;
  }

  async addRepos(dids: string[]): Promise<void> {
    for (let start = 0; start < dids.length; start += 1_000) {
      await this.tap.addRepos(dids.slice(start, start + 1_000));
    }
  }

  start(): Promise<void> {
    if (this.#channel) throw new Error("Tap consumer already started");
    const indexer = createTapIndexer(this.store);

    this.#channel = this.tap.channel(indexer);
    return this.#channel.start();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.#channel?.destroy();
  }
}

export function createTapIndexer(store: AnalyticsStore): LexIndexer {
    const indexer = new LexIndexer();

    indexer.put(app.bsky.feed.post.main, async (event) => {
      const uri = recordUri(event.did, event.collection, event.rkey);
      const quote = quoteSubject(event.record);
      const kind: ActivityKind = event.record.reply ? "reply" : quote ? "quote" : "post";
      const subjectUri = event.record.reply?.parent.uri ?? quote;
      await store.recordActivity(activity(event, uri, kind, subjectUri));
      if (subjectUri && (kind === "reply" || kind === "quote")) {
        await store.recordEngagements([{
          postUri: subjectUri,
          actorDid: event.did,
          kind,
          recordUri: uri,
          occurredAt: event.record.createdAt,
        }]);
      }
    });
    indexer.delete(app.bsky.feed.post.main, async (event) => {
      await store.deactivateActivity(recordUri(event.did, event.collection, event.rkey));
    });

    indexer.put(app.bsky.feed.like.main, async (event) => {
      await recordSubjectActivity(store, event, "like");
    });
    indexer.delete(app.bsky.feed.like.main, async (event) => {
      await store.deactivateActivity(recordUri(event.did, event.collection, event.rkey));
    });
    indexer.put(app.bsky.feed.repost.main, async (event) => {
      await recordSubjectActivity(store, event, "repost");
    });
    indexer.delete(app.bsky.feed.repost.main, async (event) => {
      await store.deactivateActivity(recordUri(event.did, event.collection, event.rkey));
    });

    indexer.put(app.bsky.graph.follow.main, async (event) => {
      const uri = recordUri(event.did, event.collection, event.rkey);
      await store.recordActivity(activity(event, uri, "follow", undefined, event.record.subject));
    });
    indexer.delete(app.bsky.graph.follow.main, async (event) => {
      await store.deactivateActivity(recordUri(event.did, event.collection, event.rkey));
    });

    indexer.identity(async (event) => {
      await store.upsertActor({ did: event.did, handle: event.handle });
    });
    indexer.error((error) => {
      console.error(JSON.stringify({ level: "error", component: "tap", message: error.message }));
    });

    return indexer;
}

async function recordSubjectActivity(
    store: AnalyticsStore,
    event: {
      did: ProtocolActivity["actorDid"];
      collection: string;
      rkey: string;
      cid: string;
      live: boolean;
      record: app.bsky.feed.like.Main | app.bsky.feed.repost.Main;
    },
    kind: EngagementKind,
): Promise<void> {
    const uri = recordUri(event.did, event.collection, event.rkey);
    await store.recordActivity(activity(event, uri, kind, event.record.subject.uri));
    await store.recordEngagements([{
      postUri: event.record.subject.uri,
      actorDid: event.did,
      kind,
      recordUri: uri,
      occurredAt: event.record.createdAt,
    }]);
}

function recordUri(did: string, collection: string, rkey: string): AtUriString {
  return asAtUriString(`at://${did}/${collection}/${rkey}`);
}

function quoteSubject(record: app.bsky.feed.post.Main): AtUriString | undefined {
  if (!record.embed) return undefined;
  if (app.bsky.embed.record.$isTypeOf(record.embed)) return record.embed.record.uri;
  if (app.bsky.embed.recordWithMedia.$isTypeOf(record.embed)) return record.embed.record.record.uri;
  return undefined;
}

function activity(
  event: {
    did: ProtocolActivity["actorDid"];
    collection: string;
    cid: string;
    live: boolean;
    record: { createdAt: ProtocolActivity["occurredAt"] };
  },
  uri: AtUriString,
  kind: ActivityKind,
  subjectUri?: AtUriString,
  subjectDid?: ProtocolActivity["subjectDid"],
): ProtocolActivity {
  return {
    recordUri: uri,
    actorDid: event.did,
    collection: event.collection,
    kind,
    cid: asStringFormat(event.cid, "cid"),
    occurredAt: event.record.createdAt ?? currentDatetimeString(),
    active: true,
    live: event.live,
    ...(subjectUri ? { subjectUri } : {}),
    ...(subjectDid ? { subjectDid } : {}),
  };
}
