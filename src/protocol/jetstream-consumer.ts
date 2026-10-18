import {
  consumeJetstream, eventCursor, filteredStreamUrl, logStream, retryDelay,
  streamOptionsUpdate, streamSleep, StreamSessionError, type StreamLimits,
} from "./jetstream-session.js";
import {
  asAtUriString,
  asStringFormat,
  currentDatetimeString,
  isDidString,
  type CidString,
} from "@atproto/lex";
import type { PostMetrics } from "../domain/types.js";
import { app } from "../lexicons/index.js";
import { stripNul } from "./appview-client.js";
import { ACCOUNT_POST_METRICS_PRIORITY } from "../scheduling/cadence.js";
import type { AnalyticsStore } from "../storage/store.js";

const POST_COLLECTION = "app.bsky.feed.post";
/** The name this subscription's resume cursor is persisted under (migration 020). */
const LAUNCH_STREAM = "launch";

/** Untrusted Jetstream v1 envelope: validate shape before routing. */
export type JetstreamCommit = {
  operation?: string;
  collection?: string;
  rkey?: string;
  rev?: string;
  cid?: string;
  record?: unknown;
};

export type JetstreamEvent = {
  did?: string;
  time_us?: number;
  kind?: string;
  commit?: JetstreamCommit;
};

export type JetstreamConsumerOptions = StreamLimits & {
  /** ms between tracked-DID refreshes; a changed set triggers a reconnect. */
  didRefreshMs?: number;
  /** initial reconnect backoff, doubled with jitter up to `maxReconnectMs`. */
  reconnectBaseMs?: number;
  maxReconnectMs?: number;
  /** ms between persisting the completed resume cursor; flushed on shutdown. */
  cursorFlushMs?: number;
};

export function parseJetstreamEvent(raw: string): JetstreamEvent | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value as JetstreamEvent;
  } catch {
    return null;
  }
}

export function postUri(did: string, rkey: string): string {
  return `at://${did}/${POST_COLLECTION}/${rkey}`;
}

/** Legacy URL/chunk helpers retained for callers; run() now uses one required
 * options_update instead, avoiding URL limits and cross-shard cursor races. */
export function subscribeUrl(endpoint: string, dids: string[], cursor?: number): string {
  const url = new URL(endpoint);
  url.searchParams.set("wantedCollections", POST_COLLECTION);
  for (const did of dids) url.searchParams.append("wantedDids", did);
  if (cursor !== undefined) url.searchParams.set("cursor", String(cursor));
  return url.toString();
}
export const MAX_DIDS_PER_SOCKET = 200;
export function chunkDids(dids: string[], size = MAX_DIDS_PER_SOCKET): string[][] {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error("DID chunk size must be positive");
  const chunks: string[][] = [];
  for (let i = 0; i < dids.length; i += size) chunks.push(dids.slice(i, i + size));
  return chunks;
}

/** Launch capture uses one ordered, filtered stream with bounded ingestion.
 * It seeds the zero-engagement origin and schedules dense post.metrics replay.
 * Checkpoints advance only after successful writes; failures close and replay. */
export class JetstreamConsumer {
  #cursor?: number;

  constructor(
    private readonly endpoint: string,
    private readonly store: AnalyticsStore,
    private readonly options: JetstreamConsumerOptions = {},
  ) {}

  async handleEvent(event: JetstreamEvent, tracked: ReadonlySet<string>): Promise<boolean> {
    if (event.kind !== "commit" || !event.commit) return false;
    const did = event.did;
    const { operation, collection, rkey } = event.commit;
    if (typeof did !== "string" || !isDidString(did) || collection !== POST_COLLECTION
      || typeof rkey !== "string" || !rkey || !tracked.has(did)) return false;
    let uri: ReturnType<typeof asAtUriString>;
    try { uri = asAtUriString(postUri(did, rkey)); } catch { return false; }
    if (operation === "delete") {
      await this.store.disablePost(uri);
      return true;
    }
    if (operation === "create" || operation === "update") {
      // Bad wire records skip the anchor. A failed store write propagates so the
      // event is replayed, rather than acknowledging and losing the t=0 sample.
      if (operation === "create") await this.#seedLaunch(did, rkey, event.commit);
      await this.store.enqueue("post.metrics", uri, new Date(), {
        uri,
        accountDid: did,
        explicit: false,
        unchangedRuns: 0,
        notFoundRuns: 0,
      }, ACCOUNT_POST_METRICS_PRIORITY);
      return true;
    }
    return false;
  }

  /** Create only: updates must never reset existing engagement to zero. */
  async #seedLaunch(did: string, rkey: string, commit: JetstreamCommit): Promise<void> {
    if (!isDidString(did)) return;
    const cid = safeCid(commit.cid);
    if (!cid) return;
    const parsed = app.bsky.feed.post.$safeParse(commit.record);
    if (!parsed.success) return;
    const record = parsed.value;
    const post: PostMetrics = {
      uri: asAtUriString(postUri(did, rkey)),
      cid,
      authorDid: did,
      createdAt: record.createdAt,
      indexedAt: currentDatetimeString(),
      text: stripNul(record.text),
      isReply: record.reply !== undefined,
      hasEmbed: record.embed !== undefined,
      likes: 0,
      replies: 0,
      quotes: 0,
      reposts: 0,
    };
    await this.store.seedLaunchPost(post, did);
  }

  async run(signal: AbortSignal): Promise<void> {
    const didRefreshMs = this.options.didRefreshMs ?? 60_000;
    const maxReconnectMs = this.options.maxReconnectMs ?? 30_000;
    const baseReconnectMs = this.options.reconnectBaseMs ?? 1_000;
    let failures = 0;
    while (!signal.aborted) {
      const started = Date.now();
      try {
        // Retry a failed load instead of starting live and overwriting the
        // durable checkpoint. A first-start floor covers a failed first event.
        this.#cursor ??= eventCursor(await this.store.loadStreamCursor(LAUNCH_STREAM)) ?? Date.now() * 1_000;
        const dids = await this.store.trackedAccountDids();
        if (signal.aborted) break;
        if (dids.length === 0) {
          await streamSleep(didRefreshMs, signal);
          continue;
        }
        const tracked = new Set(dids);
        // One stream avoids an unsafe shared cursor across independent shards.
        // The official options_update cap is 10k DIDs. Reject, never truncate.
        const hello = streamOptionsUpdate([POST_COLLECTION], dids);
        let sessionError: unknown;
        try {
          await consumeJetstream({
            ...this.options,
            // Exact completed cursor avoids replaying the same >buffer-sized
            // two-second prefix forever during high-volume catchup.
            url: filteredStreamUrl(this.endpoint, [POST_COLLECTION], this.#cursor),
            signal, component: "jetstream", didCount: dids.length,
            onOpen: ({ send }) => send(hello),
            onMessage: async (raw) => {
              const event = parseJetstreamEvent(raw);
              if (!event) return;
              await this.handleEvent(event, tracked);
              const cursor = eventCursor(event.time_us);
              if (cursor !== undefined) this.#cursor = Math.max(this.#cursor ?? 0, cursor);
            },
            maintenance: [
              { intervalMs: didRefreshMs, run: async ({ signal: sessionSignal, stop }) => {
                const current = await this.store.trackedAccountDids();
                if (sessionSignal.aborted) return;
                if (current.length !== tracked.size || current.some((did) => !tracked.has(did))) {
                  logStream("jetstream", "tracked filter changed; reconnecting", { didCount: current.length });
                  stop();
                }
              } },
              { intervalMs: this.options.cursorFlushMs ?? 5_000, run: async () => this.#flushCursor() },
            ],
          });
        } catch (error) { sessionError = error; }
        // Even quick overflow cycles must make durable progress. No overlap with
        // periodic flushes: the session has settled all its maintenance first.
        try { await this.#flushCursor(); } catch (error) { sessionError ??= error; }
        if (sessionError !== undefined) throw sessionError;
        failures = 0; // only planned filter changes resolve normally
      } catch (error) {
        if (signal.aborted) break;
        if (Date.now() - started >= 60_000) failures = 0;
        const retryMs = retryDelay(baseReconnectMs, maxReconnectMs, failures++);
        logStream("jetstream", "jetstream reconnect scheduled", {
          level: "error", messageDetail: error instanceof Error ? error.message : String(error),
          ...(error instanceof StreamSessionError ? error.details : {}), retryMs,
        });
        await streamSleep(retryMs, signal);
      }
    }
    // The session drains its active write and flush before returning.
    try { await this.#flushCursor(); } catch (error) {
      logStream("jetstream", "cursor flush failed", { level: "error", messageDetail: error instanceof Error ? error.message : String(error) });
    }
  }

  async #flushCursor(): Promise<void> {
    if (this.#cursor !== undefined) await this.store.saveStreamCursor(LAUNCH_STREAM, this.#cursor);
  }
}

function safeCid(cid: string | undefined): CidString | undefined {
  if (!cid) return undefined;
  try { return asStringFormat(cid, "cid"); } catch { return undefined; }
}
