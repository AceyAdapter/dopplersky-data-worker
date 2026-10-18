import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { DashboardServer } from "./observability/dashboard-server.js";
import { createRuntime } from "./runtime.js";

vi.mock("./config.js", () => ({ loadConfig: vi.fn() }));
vi.mock("./runtime.js", () => ({ createRuntime: vi.fn() }));
vi.mock("./observability/database-snapshot.js", () => ({ createDatabaseSnapshotReader: vi.fn() }));
vi.mock("./observability/dashboard-server.js", () => ({ DashboardServer: vi.fn() }));

describe("worker runtime shutdown", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(process, "once").mockImplementation(() => process);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each([false, true])("aborts and drains consumers before pool close (dashboard close fails: %s)", async (closeFails) => {
    const fatal = new Error("permanent scheduler failure");
    const closeError = new Error("dashboard close failed");
    const schedulerStarted = deferred();
    const releaseConsumers = deferred();
    const consumersAborted = deferred();
    const events: string[] = [];
    let rejectScheduler!: (error: Error) => void;
    let aborts = 0;
    const consumer = (name: string) => ({
      async run(signal: AbortSignal) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
          events.push(`${name}:abort`);
          if (++aborts === 2) consumersAborted.resolve();
          resolve();
        }, { once: true }));
        await releaseConsumers.promise;
        events.push(`${name}:drained`);
      },
    });
    const closePool = vi.fn(async () => { events.push("pool:closed"); });
    vi.mocked(loadConfig).mockReturnValue({
      dashboardEnabled: true,
      postLaunchTrackingEnabled: true,
      audienceCollectionEnabled: true,
    } as ReturnType<typeof loadConfig>);
    vi.mocked(createRuntime).mockReturnValue({
      store: { migrate: async () => {}, close: closePool, pool: {} },
      orchestrator: {
        bootstrap: async () => {},
        run: () => new Promise<void>((_resolve, reject) => {
          rejectScheduler = reject;
          schedulerStarted.resolve();
        }),
      },
      jetstream: consumer("launch"),
      audienceStream: consumer("audience"),
    } as unknown as ReturnType<typeof createRuntime>);
    const closeDashboard = vi.fn(async () => {
      events.push("dashboard:closed");
      if (closeFails) throw closeError;
    });
    vi.mocked(DashboardServer).mockImplementation(class {
      start = async () => ({ host: "127.0.0.1", port: 3002 });
      close = closeDashboard;
    } as unknown as typeof DashboardServer);

    const main = import("./main.js");
    const rejected = expect(main).rejects.toBe(closeFails ? closeError : fatal);
    await schedulerStarted.promise;
    rejectScheduler(fatal);
    await consumersAborted.promise;
    expect(closePool).not.toHaveBeenCalled();
    expect(closeDashboard).not.toHaveBeenCalled();
    releaseConsumers.resolve();
    await rejected;
    expect(events).toEqual([
      "launch:abort", "audience:abort", "launch:drained", "audience:drained",
      "dashboard:closed", "pool:closed",
    ]);
    expect(closePool).toHaveBeenCalledOnce();
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
