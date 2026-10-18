import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createDatabaseSnapshotReader, type DatabaseSnapshot, type Workload } from "./database-snapshot.js";

const pool = {} as Pool; // injected readers ignore it

const live: Omit<DatabaseSnapshot, "workload"> = {
  sampledAt: "2026-09-01T00:00:00.000Z",
  queryDurationMs: 12,
  queue: [],
  queueTotals: { total: 0, overdue: 0, scheduled: 0, leased: 0, expiredLeases: 0, withErrors: 0 },
  workers: [],
  accounts: [],
  trackedAccounts: { total: 0, rows: [] },
  onboarding: [],
};

function workload(enabledPosts: number): Workload {
  return {
    trackedAccounts: 1,
    enabledPosts,
    replayWindowPosts: 0,
    dueMaintenancePosts: 0,
    replaySamplesLastHour: 0,
    stalestPostSampleSeconds: null,
    databaseBytes: 0,
    databaseConnections: 0,
  };
}

describe(createDatabaseSnapshotReader, () => {
  it("reads workload once on cold start and reuses it within the TTL", async () => {
    const readWorkload = vi.fn(async () => workload(1));
    const readLive = vi.fn(async () => live);
    let clock = 1_000;
    const read = createDatabaseSnapshotReader(pool, {
      workloadTtlMs: 30_000, now: () => clock, readLive, readWorkload,
    });

    const first = await read();
    expect(first.workload.enabledPosts).toBe(1);

    clock += 5_000; // still within TTL
    await read();
    await read();

    expect(readWorkload).toHaveBeenCalledTimes(1); // cached
    expect(readLive).toHaveBeenCalledTimes(3); // live every frame
  });

  it("refreshes workload in the background once it is stale, serving the last value meanwhile", async () => {
    let releaseRefresh: () => void = () => {};
    let call = 0;
    const readWorkload = vi.fn((): Promise<Workload> => {
      call += 1;
      if (call === 1) return Promise.resolve(workload(1)); // cold read resolves immediately
      return new Promise((resolve) => { releaseRefresh = () => resolve(workload(2)); }); // gated
    });
    let clock = 1_000;
    const read = createDatabaseSnapshotReader(pool, {
      workloadTtlMs: 30_000, now: () => clock, readLive: async () => live, readWorkload,
    });

    await read(); // cold: workload=1
    clock += 31_000; // now stale

    // this frame triggers a background refresh (still gated) but serves the cached value
    const stale = await read();
    expect(stale.workload.enabledPosts).toBe(1); // served immediately, not blocked on the refresh
    expect(readWorkload).toHaveBeenCalledTimes(2); // refresh started in the background

    releaseRefresh(); // let the background refresh complete
    await vi.waitFor(async () => {
      const fresh = await read();
      expect(fresh.workload.enabledPosts).toBe(2); // now serving the refreshed value
    });
  });

  it("keeps the last good workload when a refresh fails", async () => {
    let call = 0;
    const readWorkload = vi.fn(async () => {
      call += 1;
      if (call === 2) throw new Error("transient DB error");
      return workload(call === 1 ? 7 : 9);
    });
    let clock = 1_000;
    const read = createDatabaseSnapshotReader(pool, {
      workloadTtlMs: 10_000, now: () => clock, readLive: async () => live, readWorkload,
    });

    await read(); // workload=7
    clock += 11_000;
    const afterFailedRefresh = await read(); // triggers the failing refresh
    await vi.waitFor(() => expect(readWorkload).toHaveBeenCalledTimes(2));
    expect(afterFailedRefresh.workload.enabledPosts).toBe(7); // last good value, not blanked
  });
});
