/** Native WebSocket has no receive-side pause. Bound application-owned buffering;
 * on overflow close and replay from the last *completed* event, never drop and
 * keep advancing. One handler at a time also preserves create/delete ordering. */
export type StreamLimits = {
  maxPendingMessages?: number;
  maxPendingBytes?: number;
  connectTimeoutMs?: number;
};

export type StreamControls = {
  signal: AbortSignal;
  send: (message: string) => void;
  stop: () => void;
};

type SessionOptions = StreamLimits & {
  url: string;
  signal: AbortSignal;
  component: string;
  didCount: number;
  onOpen?: (controls: StreamControls) => void;
  onMessage: (raw: string) => Promise<void>;
  maintenance?: { intervalMs: number; run: (controls: StreamControls) => Promise<void> }[];
};

export class StreamSessionError extends Error {
  constructor(message: string, readonly details: Record<string, string | number | boolean> = {}) {
    super(message);
  }
}

export function logStream(component: string, message: string, details: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ level: "info", component, message, ...details }));
}

export function retryDelay(base: number, maximum: number, failures: number): number {
  const ceiling = Math.min(maximum, base * 2 ** Math.min(failures, 20));
  // Equal jitter avoids both a reconnect herd and near-zero retry loops.
  return Math.max(1, Math.floor(ceiling * (0.5 + Math.random() * 0.5)));
}

export function streamSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Short URL + a required options_update: no unfiltered startup replay/burst.
 * Official v1 protocol: https://github.com/bluesky-social/jetstream-legacy#consuming-jetstream */
export function filteredStreamUrl(endpoint: string, collections: readonly string[], cursor?: number): string {
  const url = new URL(endpoint);
  url.searchParams.delete("wantedDids");
  url.searchParams.delete("wantedCollections");
  url.searchParams.delete("cursor");
  for (const collection of collections) url.searchParams.append("wantedCollections", collection);
  url.searchParams.set("requireHello", "true");
  if (cursor !== undefined) url.searchParams.set("cursor", String(cursor));
  return url.toString();
}

export function streamOptionsUpdate(collections: readonly string[], dids: string[]): string {
  // Empty means ALL repos upstream. Never let opt-out become a firehose subscription.
  if (dids.length === 0 || dids.length > 10_000) throw new Error("Jetstream filter requires 1–10000 DIDs");
  return JSON.stringify({ type: "options_update", payload: { wantedCollections: [...collections], wantedDids: dids } });
}

export function eventCursor(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export async function consumeJetstream(options: SessionOptions): Promise<void> {
  if (options.signal.aborted) return;
  const maxMessages = options.maxPendingMessages ?? 256;
  const maxBytes = options.maxPendingBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Jetstream queue limits must be positive integers");
  }
  const socket = new WebSocket(options.url);
  const controller = new AbortController();
  const queue: { raw: string; bytes: number }[] = [];
  let pendingBytes = 0;
  let active = false;
  let stopped = false;
  let opened = false;
  let failure: unknown;
  let drain: Promise<void> = Promise.resolve();
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const timers: ReturnType<typeof setTimeout>[] = [];
  const maintenance = new Set<Promise<void>>();
  const started = Date.now();

  let drainAccepted = false;
  const stop = (error?: unknown, drainQueue = false) => {
    if (stopped) return;
    stopped = true;
    drainAccepted = drainQueue;
    failure = error;
    controller.abort();
    if (!drainQueue) queue.length = 0; // discarded work is NOT acknowledged
    for (const timer of timers) clearTimeout(timer);
    socket.removeEventListener("open", onOpen);
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("close", onClose);
    socket.removeEventListener("error", onError);
    try { socket.close(); } catch { /* settle even if close never emits an event */ }
    finish();
  };
  const controls: StreamControls = {
    signal: controller.signal,
    send: (message) => { if (!stopped) socket.send(message); },
    stop: () => stop(),
  };
  const onAbort = () => {
    // Shutdown can interrupt a bounded queue already draining after disconnect.
    drainAccepted = false;
    queue.length = 0;
    stop();
  };
  const onClose = (event: CloseEvent) => stop(new StreamSessionError("jetstream remote close", {
    closeCode: event.code, wasClean: event.wasClean, opened, uptimeMs: Date.now() - started,
    closeReason: event.reason.slice(0, 160),
  }), true);
  const onError = () => stop(new StreamSessionError("jetstream socket error", {
    opened, readyState: socket.readyState, uptimeMs: Date.now() - started,
  }), true);
  const pump = async () => {
    active = true;
    try {
      while ((!stopped || drainAccepted) && queue.length > 0) {
        const item = queue.shift()!;
        await options.onMessage(item.raw);
        pendingBytes -= item.bytes;
      }
    } catch (error) {
      // Even while draining after disconnect, the first failed write stops the
      // queue. Never acknowledge or attempt subsequent ordinal events.
      drainAccepted = false;
      queue.length = 0;
      if (stopped) failure = error;
      else stop(error);
    } finally {
      active = false;
    }
  };
  const onMessage = (event: MessageEvent) => {
    if (stopped || typeof event.data !== "string") return;
    const bytes = Buffer.byteLength(event.data, "utf8");
    if (queue.length + Number(active) >= maxMessages || pendingBytes + bytes > maxBytes) {
      // Drain the accepted bounded batch after closing input; discarding it on
      // every replay burst would advance only one event per reconnect forever.
      stop(new StreamSessionError("jetstream ingestion buffer full; replay required", {
        pendingMessages: queue.length + Number(active), pendingBytes, maxMessages, maxBytes,
      }), true);
      return;
    }
    queue.push({ raw: event.data, bytes });
    pendingBytes += bytes;
    if (!active) drain = pump();
  };
  const schedule = (task: NonNullable<SessionOptions["maintenance"]>[number]) => {
    if (stopped) return;
    const timer = setTimeout(() => {
      const work = (async () => {
        try { await task.run(controls); } catch (error) { stop(error); }
        if (!stopped) schedule(task);
      })();
      maintenance.add(work);
      void work.finally(() => maintenance.delete(work));
      const index = timers.indexOf(timer);
      if (index !== -1) timers.splice(index, 1);
    }, task.intervalMs);
    timers.push(timer);
  };
  const connectTimer = setTimeout(() => stop(new StreamSessionError("jetstream connect timeout", {
    opened: false, uptimeMs: Date.now() - started,
  })), options.connectTimeoutMs ?? 15_000);
  timers.push(connectTimer);
  const onOpen = () => {
    if (stopped) return;
    opened = true;
    clearTimeout(connectTimer);
    try {
      options.onOpen?.(controls);
      logStream(options.component, "jetstream connected", { didCount: options.didCount });
      for (const task of options.maintenance ?? []) schedule(task);
    } catch (error) { stop(error); }
  };
  socket.addEventListener("open", onOpen);
  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", onClose);
  socket.addEventListener("error", onError);
  options.signal.addEventListener("abort", onAbort, { once: true });
  if (options.signal.aborted) stop();
  await done;
  // Store methods do not accept AbortSignal. Await the sole active handler and
  // maintenance reads, rather than overlap old writes with a new connection.
  await drain;
  await Promise.all(maintenance);
  options.signal.removeEventListener("abort", onAbort);
  if (failure !== undefined) throw failure;
}
