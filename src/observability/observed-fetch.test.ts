import { describe, expect, it, vi } from "vitest";
import { WorkerMetrics } from "./metrics.js";
import { observedFetch } from "./observed-fetch.js";

describe("observedFetch", () => {
  it("records the XRPC endpoint and HTTP status without consuming the response", async () => {
    const implementation = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const metrics = new WorkerMetrics("worker-a", 4);
    const fetch = observedFetch(metrics, implementation as typeof globalThis.fetch);

    const response = await fetch("https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris=x");

    expect(await response.json()).toEqual({ ok: true });
    expect(metrics.snapshot().appviewByEndpoint[0]).toMatchObject({
      endpoint: "app.bsky.feed.getPosts",
      requests: 1,
      errors: 0,
    });
  });

  it("records a transport failure as an error and rethrows it", async () => {
    const implementation = vi.fn(async () => { throw new TypeError("offline"); });
    const metrics = new WorkerMetrics("worker-a", 4);
    const fetch = observedFetch(metrics, implementation as typeof globalThis.fetch);

    await expect(fetch("https://public.api.bsky.app/xrpc/app.bsky.actor.getProfiles"))
      .rejects.toThrow("offline");
    expect(metrics.snapshot().lastMinute.appviewErrors).toBe(1);
  });
});
