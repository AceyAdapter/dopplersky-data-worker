import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { DASHBOARD_HTML } from "./dashboard-html.js";

const DID = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const URI = `at://${DID}/app.bsky.feed.post/3example`;
function snapshot() {
  return {
    sampledAt: new Date().toISOString(), queryDurationMs: 12, totalEligible: 1,
    freshnessMinutes: 15, windowMinutes: 60, postAgeHours: 48, minSpanMinutes: 10,
    rows: [{ uri: URI, authorDid: DID, handle: "example.bsky.social",
      text: '<img src=x onerror="alert(1)"> & test', createdAt: new Date(Date.now() - 7_200_000).toISOString(),
      latestSampleAt: new Date(Date.now() - 60_000).toISOString(), observedMinutes: 40,
      sampleCount: 6, maxGapMinutes: 10, interactions: 140, gainedInteractions: 40,
      interactionsPerHour: 60, previousInteractionsPerHour: null }],
  };
}

class Element {
  innerHTML = "";
  textContent = "";
  value = "";
  disabled = false;
  className = "";
  classes = new Set<string>();
  listeners = new Map<string, () => void>();
  classList = {
    add: (...names: string[]) => names.forEach((name) => this.classes.add(name)),
    remove: (...names: string[]) => names.forEach((name) => this.classes.delete(name)),
  };
  addEventListener(name: string, callback: () => void) { this.listeners.set(name, callback); }
  setAttribute() {}
}

async function page(data = snapshot()) {
  const elements = new Map<string, Element>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => data }));
  const document = { hidden: false, getElementById: element, querySelectorAll: () => [], addEventListener: vi.fn() };
  const timers = { setInterval: vi.fn(), setTimeout: vi.fn(), clearTimeout: vi.fn() };
  const script = /<script>([\s\S]*?)<\/script>/.exec(DASHBOARD_HTML)?.[1];
  expect(script).toBeDefined();
  runInNewContext(script!, {
    document, window: timers, EventSource: class { addEventListener() {} },
    fetch: fetcher, URL, AbortController, Intl, Date, console,
  });
  await vi.waitFor(() => expect(element("risingRefresh").disabled).toBe(false));
  return { element, fetcher, document, timers };
}

describe("private rising-post dashboard UI", () => {
  it("runs the shipped browser script, escapes post text, and links to the exact post", async () => {
    const { element, fetcher } = await page();
    const html = element("risingRows").innerHTML;
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(html).toContain("No comparable prior window");
    expect(html).toContain("Dopplersky ↗");
    expect(html).toContain('rel="noopener noreferrer"');
    const links = [...html.matchAll(/href="([^"]+)"/g)].map((m) => new URL(m[1]!.replaceAll("&amp;", "&")));
    expect(links[0]?.origin).toBe("https://dopplersky.com");
    expect(links[0]?.pathname).toBe("/user/example.bsky.social/posts");
    expect(links[0]?.searchParams.get("post")).toBe(URI);
    expect(links[0]?.searchParams.get("internal")).toBe("1");
    expect(decodeURIComponent(links[1]!.pathname)).toBe(`/profile/${DID}/post/3example`);
    expect(fetcher).toHaveBeenCalledWith("/rising-posts", expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
    expect(element("risingStatus").textContent).toContain("1 qualifying");
  });

  it("filters only displayed results without another database request", async () => {
    const { element, fetcher } = await page();
    element("risingFilter").value = "nobody-matches";
    element("risingFilter").listeners.get("input")!();
    expect(element("risingRows").innerHTML).toContain("No matching posts in these results");
    expect(fetcher).toHaveBeenCalledTimes(1);
    element("risingFilter").value = "EXAMPLE";
    element("risingFilter").listeners.get("input")!();
    expect(element("risingRows").innerHTML).toContain("Dopplersky ↗");
  });

  it("does not fabricate zero growth for an empty ranking", async () => {
    const data = snapshot(); data.rows = []; data.totalEligible = 0;
    const { element } = await page(data);
    expect(element("risingRows").innerHTML).toContain("No posts currently have fresh, positive growth");
    expect(element("risingRows").innerHTML).not.toContain("+0");
  });

  it("does not create links from a mismatched post identity", async () => {
    const data = snapshot(); data.rows[0]!.uri = "javascript:alert(1)";
    const { element } = await page(data);
    expect(element("risingRows").innerHTML).not.toContain("href=");
  });

  it("clearly marks retained results stale when refresh fails", async () => {
    const { element, fetcher } = await page();
    fetcher.mockRejectedValueOnce(new Error("offline"));
    element("risingRefresh").listeners.get("click")!();
    await vi.waitFor(() => expect(element("risingRefresh").disabled).toBe(false));
    expect(element("risingStatus").textContent).toContain("Refresh failed. Showing older results");
    expect(element("risingRows").classes.has("stale-rows")).toBe(true);
    element("risingFilter").listeners.get("input")!();
    expect(element("risingStatus").textContent).toContain("Refresh failed");
    expect(element("risingRows").innerHTML).toContain("Dopplersky ↗");
  });

  it("does not poll rising posts while the page is hidden", async () => {
    const { document, timers, fetcher } = await page();
    document.hidden = true;
    const poll = timers.setInterval.mock.calls.find((args) => args[1] === 30_000)?.[0] as (() => void);
    expect(poll).toBeTypeOf("function"); poll();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
