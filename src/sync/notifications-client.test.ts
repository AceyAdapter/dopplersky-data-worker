import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationsClient } from "./notifications-client.js";

const URL = "https://api.example.test/api/dopplersky/notifications/run";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("NotificationsClient", () => {
  it("does nothing at all when notifications are unconfigured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const client = new NotificationsClient(undefined, undefined, "worker-1");

    expect(client.enabled).toBe(false);
    expect(await client.dispatch()).toBeNull();
    // Not even a connection attempt: unset has to be genuinely inert.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs with the internal bearer and returns the pass summary", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({
      success: true,
      data: { dryRun: false, scanned: 3, sent: 2, skipped: 1, failed: 0 },
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const client = new NotificationsClient(URL, "internal-token", "worker-1");
    const summary = await client.dispatch();

    expect(client.enabled).toBe(true);
    expect(summary).toEqual({ dryRun: false, scanned: 3, sent: 2, skipped: 1, failed: 0 });

    const [calledUrl, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toBe(URL);
    expect(init.method).toBe("POST");
    expect((init.headers as Headers).get("authorization")).toBe("Bearer internal-token");
    // The worker identifies itself so a pass in the API's logs can be traced back.
    expect(JSON.parse(String(init.body))).toMatchObject({ workerId: "worker-1" });
  });

  it("omits the bearer when no token is configured", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ success: true, data: null }));
    vi.stubGlobal("fetch", fetchSpy);
    await new NotificationsClient(URL, undefined, "worker-1").dispatch();
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Headers).get("authorization")).toBeNull();
  });

  it("throws on a non-success answer so the job fails and the queue retries", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ success: false }, 503)));
    await expect(new NotificationsClient(URL, "t", "worker-1").dispatch()).rejects.toThrow(
      /HTTP 503/,
    );
  });

  it("carries a timeout so a slow pass cannot outlive its job lease", async () => {
    const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
      // A real bounded signal, not an absent one: without this a hung provider
      // would hold the job until the lease expired.
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse({ success: true, data: null });
    });
    vi.stubGlobal("fetch", fetchSpy);
    await new NotificationsClient(URL, "t", "worker-1", 5_000).dispatch();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
