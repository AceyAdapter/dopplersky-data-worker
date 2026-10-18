import {
  consumeJetstream, eventCursor, filteredStreamUrl, logStream, retryDelay,
  streamOptionsUpdate, streamSleep, StreamSessionError, type StreamLimits,
} from "./jetstream-session.js";
import {
  asAtUriString,
  asStringFormat,
  currentDatetimeString,
  isDidString,
  type AtUriString,
  type CidString,
  type DatetimeString,
  type DidString,
} from "@atproto/lex";
import type { EngagementKind, ProtocolActivity } from "../domain/types.js";
import { app } from "../lexicons/index.js";
import type { AnalyticsStore } from "../storage/store.js";
import { parseJetstreamEvent, type JetstreamEvent } from "./jetstream-consumer.js";

const LIKE = app.bsky.feed.like.$type;
const REPOST = app.bsky.feed.repost.$type;
const POST = app.bsky.feed.post.$type;
const FOLLOW = app.bsky.graph.follow.$type;

/** Public activity collections, narrowed to the opted-in cohort server-side. */
export const AUDIENCE_COLLECTIONS = [LIKE, REPOST, POST, FOLLOW] as const;

export type AudienceConsumerOptions = StreamLimits & {
  /** Top engagers watched per subscriber; the recency-ranked cohort slice. */
  perTarget: number;
  /** Global ceiling on the watched cohort; unchanged by ingestion buffering. */
  globalCap: number;
  /** ms between cohort refreshes; changed nonempty sets re-filter in place. */
  cohortRefreshMs?: number;
  reconnectBaseMs?: number;
  maxReconnectMs?: number;
};

/** Short URL; requireHello pauses all delivery until the DID filter is applied. */
export function subscribeAudienceUrl(endpoint: string, cursor?: number): string {
  return filteredStreamUrl(endpoint, AUDIENCE_COLLECTIONS, cursor);
}

/** Empty means ALL DIDs upstream, so it is rejected rather than sent on opt-out. */
export function audienceOptionsUpdate(dids: string[]): string {
  return streamOptionsUpdate(AUDIENCE_COLLECTIONS, dids);
}

function recordUri(did: string, collection: string, rkey: string): AtUriString {
  return asAtUriString(`at://${did}/${collection}/${rkey}`);
}

/** Brand an untrusted CID string, dropping it rather than throwing on garbage. */
function safeCid(cid: string | undefined): CidString | undefined {
  if (!cid) return undefined;
  try {
    return asStringFormat(cid, "cid");
  } catch {
    return undefined;
  }
}

function quoteSubject(record: app.bsky.feed.post.Main): AtUriString | undefined {
  if (!record.embed) return undefined;
  if (app.bsky.embed.record.$isTypeOf(record.embed)) return record.embed.record.uri;
  if (app.bsky.embed.recordWithMedia.$isTypeOf(record.embed)) return record.embed.record.record.uri;
  return undefined;
}

/**
 * Forward-only audience activity capture. Subscribes to Jetstream filtered to a
 * bounded, rotating cohort of an account's recent engagers (`wantedDids`) and
 * writes their public like/repost/post/follow activity into `protocol_activity`
 * / `engagement_edges` as it happens — the basis of the activity-time heatmap and
 * the "your audience is active now, post now" signal.
 *
 * Deliberately NOT Tap: there is no repository backfill, so admitting a DID costs
 * nothing to take back — the cohort rotates freely by changing the filter and
 * reconnecting, and there is no uncancellable resync to blow up (design note).
 * The only bound is cohort size (`globalCap`). Untrusted wire data: anything
 * off-shape is ignored, never thrown on. At-least-once and reconnecting, like the
 * launch tracker, so every write must be idempotent (the store's are).
 */
export class AudienceActivityConsumer {
  #cursor?: number;

  constructor(
    private readonly endpoint: string,
    private readonly store: AnalyticsStore,
    private readonly options: AudienceConsumerOptions,
  ) {}

  /**
   * Route one event for a watched cohort member. Creates append activity (and an
   * engagement edge when the record targets a post); deletes deactivate the
   * matching activity/edge (honoring deletion). Returns whether it was actionable.
   */
  async handleEvent(event: JetstreamEvent, watched: ReadonlySet<string>): Promise<boolean> {
    if (event.kind !== "commit" || !event.commit) return false;
    const did = event.did;
    const { operation, collection, rkey } = event.commit;
    if (typeof did !== "string" || !isDidString(did) || typeof rkey !== "string" || !rkey) return false;
    if (collection !== LIKE && collection !== REPOST && collection !== POST && collection !== FOLLOW) return false;
    if (!watched.has(did)) return false;

    let uri: AtUriString;
    try { uri = recordUri(did, collection, rkey); } catch { return false; }
    if (operation === "delete") {
      await this.store.deactivateActivity(uri);
      return true;
    }
    if (operation !== "create" && operation !== "update") return false;

    const cid = safeCid(event.commit.cid);
    if (collection === LIKE || collection === REPOST) {
      return this.#subjectEngagement(did, uri, cid, collection === LIKE ? "like" : "repost", event.commit.record);
    }
    if (collection === POST) {
      return this.#post(did, collection, uri, cid, event.commit.record);
    }
    return this.#follow(did, uri, cid, event.commit.record);
  }

  async #subjectEngagement(
    did: DidString,
    uri: AtUriString,
    cid: CidString | undefined,
    kind: "like" | "repost",
    raw: unknown,
  ): Promise<boolean> {
    const parsed = kind === "like"
      ? app.bsky.feed.like.$safeParse(raw)
      : app.bsky.feed.repost.$safeParse(raw);
    if (!parsed.success) return false;
    const subjectUri = parsed.value.subject.uri;
    const occurredAt = parsed.value.createdAt;
    await this.store.recordActivity(this.#activity(did, uri, kind, cid, occurredAt, { subjectUri }));
    await this.store.recordEngagements([
      { postUri: subjectUri, actorDid: did, kind, recordUri: uri, occurredAt },
    ]);
    return true;
  }

  async #post(
    did: DidString,
    collection: string,
    uri: AtUriString,
    cid: CidString | undefined,
    raw: unknown,
  ): Promise<boolean> {
    const parsed = app.bsky.feed.post.$safeParse(raw);
    if (!parsed.success) return false;
    const record = parsed.value;
    const quoted = quoteSubject(record);
    const kind: EngagementKind | "post" = record.reply ? "reply" : quoted ? "quote" : "post";
    const subjectUri = record.reply?.parent.uri ?? quoted;
    await this.store.recordActivity(
      this.#activity(did, uri, kind, cid, record.createdAt, subjectUri ? { subjectUri } : {}),
    );
    if (subjectUri && (kind === "reply" || kind === "quote")) {
      await this.store.recordEngagements([
        { postUri: subjectUri, actorDid: did, kind, recordUri: uri, occurredAt: record.createdAt },
      ]);
    }
    return true;
  }

  async #follow(did: DidString, uri: AtUriString, cid: CidString | undefined, raw: unknown): Promise<boolean> {
    const parsed = app.bsky.graph.follow.$safeParse(raw);
    if (!parsed.success) return false;
    await this.store.recordActivity(
      this.#activity(did, uri, "follow", cid, parsed.value.createdAt, { subjectDid: parsed.value.subject }),
    );
    return true;
  }

  #activity(
    did: DidString,
    uri: AtUriString,
    kind: ProtocolActivity["kind"],
    cid: CidString | undefined,
    occurredAt: DatetimeString | undefined,
    subject: { subjectUri?: AtUriString; subjectDid?: DidString },
  ): ProtocolActivity {
    return {
      recordUri: uri,
      actorDid: did,
      collection: kind === "follow" ? FOLLOW : kind === "like" ? LIKE : kind === "repost" ? REPOST : POST,
      kind,
      occurredAt: occurredAt ?? currentDatetimeString(),
      active: true,
      live: true,
      ...(cid ? { cid } : {}),
      ...(subject.subjectUri ? { subjectUri: subject.subjectUri } : {}),
      ...(subject.subjectDid ? { subjectDid: subject.subjectDid } : {}),
    };
  }

  // Admission times stay process-local like the audience cursor: newly watched
  // members must not acquire history merely because a slow stream is replaying.
  #admitted = new Map<string, number>();

  #setCohort(dids: string[]): Set<string> {
    const current = new Set(dids);
    for (const did of this.#admitted.keys()) if (!current.has(did)) this.#admitted.delete(did);
    for (const did of current) if (!this.#admitted.has(did)) this.#admitted.set(did, Date.now() * 1_000);
    return current;
  }

  async run(signal: AbortSignal): Promise<void> {
    const cohortRefreshMs = this.options.cohortRefreshMs ?? 60_000;
    const maxReconnectMs = this.options.maxReconnectMs ?? 30_000;
    const baseReconnectMs = this.options.reconnectBaseMs ?? 1_000;
    let failures = 0;
    while (!signal.aborted) {
      const started = Date.now();
      try {
        const dids = await this.#cohort();
        if (signal.aborted) break;
        let watched = this.#setCohort(dids);
        if (dids.length === 0) {
          this.#cursor = undefined; // no activity capture while everyone is opted out
          await streamSleep(cohortRefreshMs, signal);
          continue;
        }
        this.#cursor ??= Date.now() * 1_000;
        const hello = audienceOptionsUpdate(dids);
        await consumeJetstream({
          ...this.options,
          url: subscribeAudienceUrl(this.endpoint, this.#cursor),
          signal, component: "audience-jetstream", didCount: dids.length,
          onOpen: ({ send }) => send(hello),
          onMessage: async (raw) => {
            const event = parseAudienceEvent(raw);
            if (!event) return;
            const cursor = eventCursor(event.time_us);
            const admittedAt = typeof event.did === "string" ? this.#admitted.get(event.did) : undefined;
            // Require a timestamp for forward-only capture. No historic backfill
            // for a newly admitted member, even on a lagged/replayed connection.
            if (cursor !== undefined && admittedAt !== undefined && cursor >= admittedAt) {
              await this.handleEvent(event, watched);
            }
            if (cursor !== undefined) this.#cursor = Math.max(this.#cursor ?? 0, cursor);
          },
          maintenance: [{ intervalMs: cohortRefreshMs, run: async ({ signal: sessionSignal, send, stop }) => {
            const current = await this.#cohort();
            if (sessionSignal.aborted) return;
            if (current.length === watched.size && current.every((did) => watched.has(did))) return;
            watched = this.#setCohort(current);
            logStream("audience-jetstream", "audience filter changed", { didCount: current.length });
            // Empty wantedDids DISABLES the server filter. Close instead.
            if (current.length === 0) stop();
            else send(audienceOptionsUpdate(current));
          } }],
        });
        failures = 0;
      } catch (error) {
        if (signal.aborted) break;
        if (Date.now() - started >= 60_000) failures = 0;
        const retryMs = retryDelay(baseReconnectMs, maxReconnectMs, failures++);
        logStream("audience-jetstream", "jetstream reconnect scheduled", {
          level: "error", messageDetail: error instanceof Error ? error.message : String(error),
          ...(error instanceof StreamSessionError ? error.details : {}), retryMs,
        });
        await streamSleep(retryMs, signal);
      }
    }
  }

  #cohort(): Promise<DidString[]> {
    return this.store.audienceWatchDids(this.options.perTarget, this.options.globalCap);
  }
}

export const parseAudienceEvent = parseJetstreamEvent;
