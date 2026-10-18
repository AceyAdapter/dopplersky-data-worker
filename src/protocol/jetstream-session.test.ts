import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DidString } from "@atproto/lex";
import { stubStore } from "../../tests/_util.js";
import { AudienceActivityConsumer, audienceOptionsUpdate, subscribeAudienceUrl } from "./audience-consumer.js";
import { JetstreamConsumer } from "./jetstream-consumer.js";
import { consumeJetstream, eventCursor, filteredStreamUrl, retryDelay, streamOptionsUpdate } from "./jetstream-session.js";

const DID = "did:plc:alice" as DidString;
const OTHER = "did:plc:bob" as DidString;
const NOW = Date.UTC(2026, 8, 10);
const CURSOR = NOW * 1_000;
const endpoint = "wss://jetstream.example/subscribe";

class FakeSocket extends EventTarget {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  close = vi.fn(() => { this.readyState = 3; }); // deliberately no close event
  constructor(readonly url: string) { super(); FakeSocket.instances.push(this); }
  send(raw: string) { this.sent.push(raw); }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  message(raw: string) { this.dispatchEvent(new MessageEvent("message", { data: raw })); }
  remoteClose(code = 1006) {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code, wasClean: code === 1000, reason: "upstream restart" }));
  }
  error() { this.dispatchEvent(new Event("error")); }
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => vi.advanceTimersByTimeAsync(0);
function event(time: number, operation = "delete", collection = "app.bsky.feed.post", did = DID) {
  return JSON.stringify({ did, time_us: time, kind: "commit", commit: { operation, collection, rkey: "record" } });
}
const latest = () => FakeSocket.instances.at(-1)!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal("WebSocket", FakeSocket);
  FakeSocket.instances = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("bounded Jetstream session", () => {
  it("serializes messages, bounds active+pending count and waits for the active write on overflow", async () => {
    const gate = deferred();
    const handler = vi.fn(async () => gate.promise);
    const abort = new AbortController();
    const result = consumeJetstream({ url: endpoint, signal: abort.signal, component: "test", didCount: 1,
      maxPendingMessages: 2, onMessage: handler }).catch((error: Error) => error);
    latest().open();
    latest().message("first"); latest().message("second"); latest().message("overflow");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(latest().close).toHaveBeenCalledOnce();
    let settled = false;
    void result.then(() => { settled = true; });
    await tick(); expect(settled).toBe(false);
    gate.resolve();
    expect((await result as Error).message).toContain("buffer full");
    latest().message("stale callback");
    expect(handler).toHaveBeenCalledTimes(2); // accepted batch drains; overflow and stale callback never run
  });

  it("bounds UTF-8 bytes, not just message count", async () => {
    const handler = vi.fn(async () => {});
    const result = consumeJetstream({ url: endpoint, signal: new AbortController().signal,
      component: "test", didCount: 1, maxPendingBytes: 3, onMessage: handler }).catch((error: Error) => error);
    latest().message("💥"); // four UTF-8 bytes
    expect((await result as Error).message).toContain("buffer full");
    expect(handler).not.toHaveBeenCalled();
  });

  it("stops on a failed handler rather than starting queued DB requests", async () => {
    const gate = deferred();
    const handler = vi.fn(async () => gate.promise);
    const result = consumeJetstream({ url: endpoint, signal: new AbortController().signal,
      component: "test", didCount: 1, onMessage: handler }).catch((error: Error) => error);
    latest().message("first"); latest().message("second");
    gate.reject(new Error("timeout exceeded when trying to connect"));
    expect((await result as Error).message).toContain("timeout exceeded");
    expect(handler).toHaveBeenCalledOnce();
    expect(latest().close).toHaveBeenCalledOnce();
  });

  it("aborts without needing a close event but drains its sole active write", async () => {
    const gate = deferred();
    const abort = new AbortController();
    const handler = vi.fn(async () => gate.promise);
    const run = consumeJetstream({ url: endpoint, signal: abort.signal, component: "test", didCount: 1, onMessage: handler });
    latest().message("active"); latest().message("queued");
    abort.abort();
    let settled = false;
    void run.then(() => { settled = true; });
    await tick(); expect(settled).toBe(false);
    gate.resolve(); await run;
    expect(handler).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("opens no socket for an already-aborted signal", async () => {
    const abort = new AbortController(); abort.abort();
    await consumeJetstream({ url: endpoint, signal: abort.signal, component: "test", didCount: 1, onMessage: async () => {} });
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it("times out stalled handshakes and reports remote close metadata", async () => {
    const timeout = consumeJetstream({ url: endpoint, signal: new AbortController().signal,
      component: "test", didCount: 1, connectTimeoutMs: 20, onMessage: async () => {} }).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(20);
    expect((await timeout as Error).message).toContain("connect timeout");
    const close = consumeJetstream({ url: endpoint, signal: new AbortController().signal,
      component: "test", didCount: 1, onMessage: async () => {} }).catch((error: Error) => error);
    latest().open(); latest().remoteClose(1000);
    expect(await close).toMatchObject({ details: { closeCode: 1000, wasClean: true, opened: true } });
  });

  it("does not overlap slow maintenance ticks or leave them running on exit", async () => {
    const gate = deferred();
    const refresh = vi.fn(async () => gate.promise);
    const abort = new AbortController();
    const run = consumeJetstream({ url: endpoint, signal: abort.signal, component: "test", didCount: 1,
      onMessage: async () => {}, maintenance: [{ intervalMs: 10, run: refresh }] });
    latest().open();
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).toHaveBeenCalledOnce();
    abort.abort(); gate.resolve(); await run;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("stream wire contracts", () => {
  it("requires hello and clears stale URL filters without exposing a long DID URL", () => {
    const url = new URL(filteredStreamUrl(`${endpoint}?wantedDids=stale&cursor=1&wantedCollections=wrong`, ["app.bsky.feed.post"], 42));
    expect(url.searchParams.get("requireHello")).toBe("true");
    expect(url.searchParams.getAll("wantedDids")).toEqual([]);
    expect(url.searchParams.getAll("wantedCollections")).toEqual(["app.bsky.feed.post"]);
    expect(url.searchParams.get("cursor")).toBe("42");
    expect(new URL(subscribeAudienceUrl(endpoint)).searchParams.get("requireHello")).toBe("true");
    expect(() => audienceOptionsUpdate([])).toThrow();
    expect(() => streamOptionsUpdate([], Array(10001).fill(DID))).toThrow();
  });

  it("accepts only positive safe-integer cursors and caps/jitters retry delays", () => {
    for (const value of [NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, "123"]) expect(eventCursor(value)).toBeUndefined();
    expect(eventCursor(CURSOR)).toBe(CURSOR);
    expect(retryDelay(1000, 30000, 0)).toBe(750);
    expect(retryDelay(1000, 30000, 20)).toBe(22500);
  });
});

describe("launch stream lifecycle", () => {
  it("uses one filtered socket beyond 200 DIDs; checkpoints only completed events in order", async () => {
    const gate = deferred();
    const disabled = vi.fn(async () => gate.promise);
    const save = vi.fn(async () => {});
    const dids = [DID, ...Array.from({ length: 435 }, (_, i) => `did:plc:${i}` as DidString)];
    const abort = new AbortController();
    const run = new JetstreamConsumer(endpoint, stubStore({
      trackedAccountDids: async () => dids, loadStreamCursor: async () => CURSOR,
      disablePost: disabled, saveStreamCursor: save,
    }), { cursorFlushMs: 10 }).run(abort.signal);
    await tick(); expect(FakeSocket.instances).toHaveLength(1);
    latest().open();
    expect(JSON.parse(latest().sent[0]!).payload.wantedDids).toEqual(dids);
    latest().message(event(CURSOR + 10)); latest().message(event(CURSOR + 20));
    await vi.advanceTimersByTimeAsync(10);
    expect(save).toHaveBeenLastCalledWith("launch", CURSOR);
    expect(disabled).toHaveBeenCalledOnce();
    gate.resolve(); await tick();
    abort.abort(); await run;
    expect(disabled).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith("launch", CURSOR + 20);
  });

  it("does not acknowledge failed or discarded messages and reconnects from a replayable cursor", async () => {
    const disablePost = vi.fn(async (): Promise<void> => { throw new Error("db unavailable"); });
    const save = vi.fn(async () => {});
    const abort = new AbortController();
    const run = new JetstreamConsumer(endpoint, stubStore({ trackedAccountDids: async () => [DID],
      loadStreamCursor: async () => CURSOR, disablePost, saveStreamCursor: save,
    }), { reconnectBaseMs: 10 }).run(abort.signal);
    await tick(); latest().open();
    latest().message(event(CURSOR + 10)); latest().message(event(CURSOR + 20));
    await vi.advanceTimersByTimeAsync(10);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(Number(new URL(latest().url).searchParams.get("cursor"))).toBeLessThanOrEqual(CURSOR);
    expect(disablePost).toHaveBeenCalledOnce();
    disablePost.mockImplementation(async () => {});
    latest().open(); latest().message(event(CURSOR + 10)); latest().message(event(CURSOR + 20));
    await tick(); abort.abort(); await run;
    expect(save).toHaveBeenLastCalledWith("launch", CURSOR + 20);
  });

  it("retries checkpoint load failures instead of dialing live and overwriting stored progress", async () => {
    const load = vi.fn(async (): Promise<number> => { throw new Error("db unavailable"); });
    const abort = new AbortController();
    const run = new JetstreamConsumer(endpoint, stubStore({ loadStreamCursor: load,
      trackedAccountDids: async () => [DID],
    }), { reconnectBaseMs: 10 }).run(abort.signal);
    await tick(); expect(FakeSocket.instances).toHaveLength(0);
    load.mockResolvedValue(CURSOR);
    await vi.advanceTimersByTimeAsync(10);
    expect(FakeSocket.instances).toHaveLength(1);
    abort.abort(); await run;
  });

  it("backs off even on clean remote closes and removes old socket message listeners", async () => {
    const disablePost = vi.fn(async () => {});
    const abort = new AbortController();
    const run = new JetstreamConsumer(endpoint, stubStore({ loadStreamCursor: async () => CURSOR,
      trackedAccountDids: async () => [DID], disablePost,
    }), { reconnectBaseMs: 1000 }).run(abort.signal);
    await tick(); const old = latest(); old.open(); old.remoteClose(1000);
    await tick(); expect(FakeSocket.instances).toHaveLength(1);
    old.message(event(CURSOR + 10)); expect(disablePost).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(750); expect(FakeSocket.instances).toHaveLength(2);
    latest().remoteClose(); await vi.advanceTimersByTimeAsync(749); expect(FakeSocket.instances).toHaveLength(2);
    abort.abort(); await run;
  });
});

describe("replay progress and malformed input", () => {
  it("drains and checkpoints quick overflowing batches before retry, without overlap livelock", async () => {
    const disable = vi.fn(async () => {});
    const saved = vi.fn(async () => {});
    const abort = new AbortController();
    const run = new JetstreamConsumer(endpoint, stubStore({ trackedAccountDids: async () => [DID],
      loadStreamCursor: async () => CURSOR, disablePost: disable, saveStreamCursor: saved,
    }), { maxPendingMessages: 2, reconnectBaseMs: 10, cursorFlushMs: 5000 }).run(abort.signal);
    await tick(); latest().open();
    latest().message(event(CURSOR + 1)); latest().message(event(CURSOR + 2)); latest().message(event(CURSOR + 3));
    await tick();
    expect(disable).toHaveBeenCalledTimes(2);
    expect(saved).toHaveBeenLastCalledWith("launch", CURSOR + 2);
    await vi.advanceTimersByTimeAsync(10);
    expect(new URL(latest().url).searchParams.get("cursor")).toBe(String(CURSOR + 2));
    latest().open();
    // Inclusive resume may repeat the last completed event; it must not rewind
    // the entire <2-second prefix and overflow before making new progress.
    latest().message(event(CURSOR + 2)); latest().message(event(CURSOR + 3)); latest().message(event(CURSOR + 4));
    await tick();
    expect(saved).toHaveBeenLastCalledWith("launch", CURSOR + 3);
    abort.abort(); await run;
  });

  it("does not skip distinct records sharing a cursor when one fails", async () => {
    const disable = vi.fn(async (uri: string) => { if (uri.endsWith("/second")) throw new Error("db unavailable"); });
    const abort = new AbortController();
    const run = new JetstreamConsumer(endpoint, stubStore({ trackedAccountDids: async () => [DID],
      loadStreamCursor: async () => CURSOR, disablePost: disable,
    }), { reconnectBaseMs: 10 }).run(abort.signal);
    const first = event(CURSOR + 1).replace('"record"', '"first"');
    const second = event(CURSOR + 1).replace('"record"', '"second"');
    await tick(); latest().open(); latest().message(first); latest().message(second);
    await vi.advanceTimersByTimeAsync(10);
    expect(new URL(latest().url).searchParams.get("cursor")).toBe(String(CURSOR + 1));
    disable.mockImplementation(async () => {});
    latest().open(); latest().message(first); latest().message(second);
    await tick();
    expect(disable).toHaveBeenCalledTimes(4); // no <=cursor dedupe that loses second
    abort.abort(); await run;
  });

  it("skips malformed record keys at the boundary but preserves store errors", async () => {
    const disablePost = vi.fn(async () => {});
    const deactivateActivity = vi.fn(async () => {});
    const store = stubStore({ disablePost, deactivateActivity });
    const launch = new JetstreamConsumer(endpoint, store);
    const audience = new AudienceActivityConsumer(endpoint, store, { perTarget: 10, globalCap: 100 });
    for (const key of [{ bad: "key" }, "bad/key"]) {
      const malformed = JSON.parse(event(CURSOR + 1));
      malformed.commit.rkey = key;
      expect(await launch.handleEvent(malformed, new Set([DID]))).toBe(false);
      expect(await audience.handleEvent(malformed, new Set([DID]))).toBe(false);
    }
    expect(disablePost).not.toHaveBeenCalled(); expect(deactivateActivity).not.toHaveBeenCalled();
    disablePost.mockRejectedValueOnce(new Error("db unavailable"));
    await expect(launch.handleEvent(JSON.parse(event(CURSOR + 1)), new Set([DID]))).rejects.toThrow("db unavailable");
  });
});

describe("audience stream lifecycle", () => {
  it("serializes create then delete so delayed activity cannot resurrect a deleted record", async () => {
    const gate = deferred();
    const order: string[] = [];
    const abort = new AbortController();
    const run = new AudienceActivityConsumer(endpoint, stubStore({ audienceWatchDids: async () => [DID],
      recordActivity: async () => { order.push("create started"); await gate.promise; order.push("create done"); },
      recordEngagements: async () => { order.push("edge"); },
      deactivateActivity: async () => { order.push("delete"); },
    }), { perTarget: 10, globalCap: 100 }).run(abort.signal);
    await tick(); latest().open();
    latest().message(JSON.stringify({ did: DID, time_us: CURSOR + 1, kind: "commit", commit: {
      operation: "create", collection: "app.bsky.feed.like", rkey: "record",
      record: { $type: "app.bsky.feed.like", createdAt: "2026-09-10T00:00:00Z",
        subject: { uri: `at://${OTHER}/app.bsky.feed.post/post`, cid: "bafyreihphrndnt2cvnv3nk442f6kohdnpagk4xip74f2jn36uoal25vhta" } },
    } }));
    latest().message(event(CURSOR + 2, "delete", "app.bsky.feed.like"));
    expect(order).toEqual(["create started"]);
    gate.resolve(); await tick();
    expect(order).toEqual(["create started", "create done", "edge", "delete"]);
    abort.abort(); await run;
  });

  it("replays a failed first audience message without advancing past it or its queued successors", async () => {
    const deactivate = vi.fn(async (): Promise<void> => { throw new Error("pool timeout"); });
    const abort = new AbortController();
    const run = new AudienceActivityConsumer(endpoint, stubStore({ audienceWatchDids: async () => [DID],
      deactivateActivity: deactivate,
    }), { perTarget: 10, globalCap: 100, reconnectBaseMs: 10 }).run(abort.signal);
    await tick(); latest().open();
    latest().message(event(CURSOR + 1, "delete", "app.bsky.feed.like"));
    latest().message(event(CURSOR + 2, "delete", "app.bsky.feed.like"));
    await vi.advanceTimersByTimeAsync(10);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(deactivate).toHaveBeenCalledOnce();
    expect(Number(new URL(latest().url).searchParams.get("cursor"))).toBeLessThanOrEqual(CURSOR);
    deactivate.mockImplementation(async () => {});
    latest().open(); latest().message(event(CURSOR + 1, "delete", "app.bsky.feed.like"));
    await tick(); expect(deactivate).toHaveBeenCalledTimes(2);
    abort.abort(); await run;
  });

  it("never opens for an empty cohort and closes rather than sending an empty filter on opt-out", async () => {
    let cohort: DidString[] = [];
    const abort = new AbortController();
    const run = new AudienceActivityConsumer(endpoint, stubStore({ audienceWatchDids: async () => cohort }),
      { perTarget: 10, globalCap: 100, cohortRefreshMs: 10 }).run(abort.signal);
    await tick(); expect(FakeSocket.instances).toHaveLength(0);
    cohort = [DID]; await vi.advanceTimersByTimeAsync(10); latest().open();
    expect(latest().sent).toHaveLength(1);
    cohort = []; await vi.advanceTimersByTimeAsync(10);
    expect(latest().close).toHaveBeenCalledOnce();
    expect(latest().sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(50); expect(FakeSocket.instances).toHaveLength(1);
    abort.abort(); await run;
  });

  it("rechecks current cohort before queued writes and does not backfill newly admitted DIDs", async () => {
    let cohort: DidString[] = [DID];
    const deactivate = vi.fn(async () => {});
    const abort = new AbortController();
    const run = new AudienceActivityConsumer(endpoint, stubStore({ audienceWatchDids: async () => cohort,
      deactivateActivity: deactivate,
    }), { perTarget: 10, globalCap: 100, cohortRefreshMs: 10 }).run(abort.signal);
    await tick(); latest().open();
    cohort = [OTHER]; await vi.advanceTimersByTimeAsync(10);
    latest().message(event(CURSOR + 1, "delete", "app.bsky.feed.like", OTHER)); // before admission
    latest().message(event(CURSOR + 20_000, "delete", "app.bsky.feed.like", DID)); // removed
    latest().message(event(CURSOR + 20_000, "delete", "app.bsky.feed.like", OTHER));
    await tick(); expect(deactivate).toHaveBeenCalledOnce();
    abort.abort(); await run;
  });
});
