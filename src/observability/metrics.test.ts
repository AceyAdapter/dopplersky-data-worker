import { describe, expect, it } from "vitest";
import { WorkerMetrics } from "./metrics.js";

describe("WorkerMetrics", () => {
  it("separates active work, outcomes, AppView latency, and rolling rates", () => {
    let now = Date.parse("2026-08-30T12:00:00.000Z");
    const metrics = new WorkerMetrics("worker-a", 8, () => now);

    metrics.recordClaim("post.metrics");
    metrics.recordClaim("post.metrics");
    metrics.recordJob("post.metrics", "rescheduled", 80);
    metrics.recordAppview("app.bsky.feed.getPosts", 40, 200);
    metrics.recordAppview("app.bsky.feed.getPosts", 120, 429);

    now += 1_000;
    metrics.recordJob("post.metrics", "failed", 250, new Error("temporary failure"));

    const snapshot = metrics.snapshot();
    expect(snapshot.workerId).toBe("worker-a");
    expect(snapshot.active).toBe(0);
    expect(snapshot.handledPerSecond).toBe(0.03);
    expect(snapshot.lastMinute).toMatchObject({
      claimed: 2,
      rescheduled: 1,
      failed: 1,
      appviewRequests: 2,
      appviewErrors: 1,
      appview429s: 1,
      appviewP50Ms: 40,
      appviewP95Ms: 120,
      jobP95Ms: 250,
    });
    expect(snapshot.jobsByKind).toEqual([{
      kind: "post.metrics",
      claimed: 2,
      completed: 0,
      rescheduled: 1,
      failed: 1,
      degraded: 0,
      active: 0,
    }]);
    expect(snapshot.appviewByEndpoint[0]).toMatchObject({
      endpoint: "app.bsky.feed.getPosts",
      requests: 2,
      errors: 1,
      rateLimited: 1,
      p95Ms: 120,
    });
    expect(snapshot.recentErrors[0]).toMatchObject({
      kind: "post.metrics",
      message: "temporary failure",
      degraded: false,
    });
  });

  it("drops old events from the rolling minute without losing process totals", () => {
    let now = 0;
    const metrics = new WorkerMetrics("worker-a", 4, () => now);
    metrics.recordClaim("account.profile");
    metrics.recordJob("account.profile", "completed", 20);

    now = 61_000;
    const snapshot = metrics.snapshot();
    expect(snapshot.handledPerSecond).toBe(0);
    expect(snapshot.lastMinute.completed).toBe(0);
    expect(snapshot.jobsByKind[0]?.completed).toBe(1);
  });
});
