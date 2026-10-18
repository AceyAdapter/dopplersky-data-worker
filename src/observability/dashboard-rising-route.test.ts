import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardServer } from "./dashboard-server.js";
import type { DatabaseSnapshot } from "./database-snapshot.js";
import type { RisingPostsSnapshot } from "./rising-posts.js";
import { WorkerMetrics } from "./metrics.js";

const AUTH = { Authorization: `Basic ${Buffer.from("test:private").toString("base64")}` };
const servers: DashboardServer[] = [];
const snapshot: RisingPostsSnapshot = {
  sampledAt: "2026-09-15T02:00:00.000Z", queryDurationMs: 10,
  windowMinutes: 60, postAgeHours: 48, freshnessMinutes: 15, minSpanMinutes: 10, previousMinCoverageRatio: 0.8,
  totalEligible: 0, rows: [],
};
async function start(read?: () => Promise<RisingPostsSnapshot>) {
  const readDatabaseSnapshot = vi.fn(async () => ({} as DatabaseSnapshot));
  const server = new DashboardServer({ host: "127.0.0.1", port: 0, username: "test", password: "private",
    refreshMs: 2000, metrics: new WorkerMetrics("test-worker", 1), readDatabaseSnapshot, readRisingPosts: read });
  servers.push(server);
  const address = await server.start();
  return { base: `http://127.0.0.1:${address.port}`, readDatabaseSnapshot };
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(servers.splice(0).map((server) => server.close())); });

describe("private rising-post endpoint", () => {
  it("requires dashboard authentication before executing any read", async () => {
    const read = vi.fn(async () => snapshot);
    const { base } = await start(read);
    const invalidHeaders: Record<string, string>[] = [{}, { Authorization: "Basic d3Jvbmc6d3Jvbmc=" }];
    for (const headers of invalidHeaders) {
      const response = await fetch(`${base}/rising-posts`, { headers });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("Basic");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("returns a no-store private snapshot independently of health/SSE reads", async () => {
    const read = vi.fn(async () => snapshot);
    const { base, readDatabaseSnapshot } = await start(read);
    const response = await fetch(`${base}/rising-posts`, { headers: AUTH });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.json()).toEqual(snapshot);
    expect(readDatabaseSnapshot).not.toHaveBeenCalled();
  });

  it("mounts only when wired and rejects non-GET requests", async () => {
    const unwired = await start();
    expect((await fetch(`${unwired.base}/rising-posts`, { headers: AUTH })).status).toBe(404);
    const read = vi.fn(async () => snapshot);
    const { base } = await start(read);
    const response = await fetch(`${base}/rising-posts`, { method: "POST", headers: AUTH });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(read).not.toHaveBeenCalled();
  });

  it("shares one in-flight read across concurrent viewers", async () => {
    let release!: (value: RisingPostsSnapshot) => void;
    const read = vi.fn(() => new Promise<RisingPostsSnapshot>((resolve) => { release = resolve; }));
    const { base } = await start(read);
    const requests = Array.from({ length: 4 }, () => fetch(`${base}/rising-posts`, { headers: AUTH }));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    release(snapshot);
    const responses = await Promise.all(requests);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("caches successes for 30 seconds without relabelling their snapshot time", async () => {
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const read = vi.fn(async () => snapshot);
    const { base } = await start(read);
    await fetch(`${base}/rising-posts`, { headers: AUTH });
    clock += 29_999;
    const cached = await fetch(`${base}/rising-posts`, { headers: AUTH });
    expect((await cached.json()).sampledAt).toBe(snapshot.sampledAt);
    expect(read).toHaveBeenCalledTimes(1);
    clock += 1;
    await fetch(`${base}/rising-posts`, { headers: AUTH });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("fails closed without leaking errors, backs off, and then recovers", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const read = vi.fn<() => Promise<RisingPostsSnapshot>>()
      .mockRejectedValueOnce(new Error("sensitive upstream error"))
      .mockResolvedValue(snapshot);
    const { base } = await start(read);
    const failed = await fetch(`${base}/rising-posts`, { headers: AUTH });
    expect(failed.status).toBe(503);
    expect(failed.headers.get("retry-after")).toBe("30");
    expect(await failed.text()).not.toContain("sensitive");
    expect((await fetch(`${base}/rising-posts`, { headers: AUTH })).status).toBe(503);
    expect(read).toHaveBeenCalledTimes(1);
    expect((await fetch(`${base}/healthz`, { headers: AUTH })).status).toBe(200);
    clock += 30_000;
    expect((await fetch(`${base}/rising-posts`, { headers: AUTH })).status).toBe(200);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
