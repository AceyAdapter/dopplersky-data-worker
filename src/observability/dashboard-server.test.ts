import { afterEach, describe, expect, it, vi } from "vitest";
import type { DidString } from "@atproto/lex";
import { DashboardServer, type DashboardActions, isAuthorized } from "./dashboard-server.js";
import type { DatabaseSnapshot } from "./database-snapshot.js";
import { WorkerMetrics } from "./metrics.js";
import type { RisingPostsSnapshot } from "./rising-posts.js";

const servers: DashboardServer[] = [];
const AUTH = { Authorization: `Basic ${Buffer.from("dopplersky:calypso").toString("base64")}` };

function stubActions(overrides: Partial<DashboardActions> = {}): DashboardActions {
  return {
    disable: vi.fn(async () => true),
    enable: vi.fn(async () => true),
    audienceOn: vi.fn(async () => true),
    audienceOff: vi.fn(async () => true),
    ...overrides,
  };
}

async function startServer(overrides: Partial<Parameters<typeof makeServer>[0]> = {}) {
  const server = makeServer(overrides);
  servers.push(server);
  const address = await server.start();
  return { server, base: `http://127.0.0.1:${address.port}` };
}

function makeServer(overrides: {
  actions?: DashboardActions | undefined;
  readRisingPosts?: (() => Promise<RisingPostsSnapshot>) | undefined;
} = {}) {
  return new DashboardServer({
    host: "127.0.0.1",
    port: 0,
    username: "dopplersky",
    password: "calypso",
    refreshMs: 2_000,
    metrics: new WorkerMetrics("worker-a", 8),
    readDatabaseSnapshot: async () => emptyDatabaseSnapshot(),
    readRisingPosts: overrides.readRisingPosts,
    actions: "actions" in overrides ? overrides.actions : stubActions(),
  });
}

const VALID_DID = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa" as DidString;

describe("dashboard account actions", () => {
  it("routes each action to its handler for a valid DID", async () => {
    const actions = stubActions();
    const { base } = await startServer({ actions });
    const cases: Array<[string, keyof DashboardActions]> = [
      ["disable", "disable"],
      ["enable", "enable"],
      ["audience-on", "audienceOn"],
      ["audience-off", "audienceOff"],
    ];
    for (const [action, method] of cases) {
      const response = await fetch(`${base}/actions/account`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ did: VALID_DID, action }),
      });
      expect(response.status).toBe(200);
      expect(actions[method]).toHaveBeenCalledWith(VALID_DID);
    }
  });

  it("returns 404 when the action reports no such tracked account", async () => {
    const { base } = await startServer({ actions: stubActions({ disable: vi.fn(async () => false) }) });
    const response = await fetch(`${base}/actions/account`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ did: VALID_DID, action: "disable" }),
    });
    expect(response.status).toBe(404);
  });

  it("rejects an invalid DID, an unknown action, and bad JSON with 400", async () => {
    const { base } = await startServer();
    const bodies = [
      JSON.stringify({ did: "not-a-did", action: "disable" }),
      JSON.stringify({ did: VALID_DID, action: "delete-everything" }),
      "{not json",
    ];
    for (const body of bodies) {
      const response = await fetch(`${base}/actions/account`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body,
      });
      expect(response.status).toBe(400);
    }
  });

  it("requires authentication for actions", async () => {
    const actions = stubActions();
    const { base } = await startServer({ actions });
    const response = await fetch(`${base}/actions/account`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ did: VALID_DID, action: "disable" }),
    });
    expect(response.status).toBe(401);
    expect(actions.disable).not.toHaveBeenCalled();
  });

  it("404s the action route when no actions are wired", async () => {
    const { base } = await startServer({ actions: undefined });
    const response = await fetch(`${base}/actions/account`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ did: VALID_DID, action: "disable" }),
    });
    expect(response.status).toBe(404);
  });
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("dashboard authentication", () => {
  it("requires the configured username and password", () => {
    const correct = `Basic ${Buffer.from("dopplersky:calypso").toString("base64")}`;
    const wrong = `Basic ${Buffer.from("dopplersky:wrong").toString("base64")}`;
    expect(isAuthorized(correct, "dopplersky", "calypso")).toBe(true);
    expect(isAuthorized(wrong, "dopplersky", "calypso")).toBe(false);
    expect(isAuthorized(undefined, "dopplersky", "calypso")).toBe(false);
  });

  it("protects the dashboard and serves the dependency-free page after auth", async () => {
    const server = new DashboardServer({
      host: "127.0.0.1",
      port: 0,
      username: "dopplersky",
      password: "calypso",
      refreshMs: 2_000,
      metrics: new WorkerMetrics("worker-a", 8),
      readDatabaseSnapshot: async () => emptyDatabaseSnapshot(),
    });
    servers.push(server);
    const address = await server.start();
    const url = `http://127.0.0.1:${address.port}/`;

    const unauthorized = await fetch(url);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain("Basic");

    const authorized = await fetch(url, {
      headers: { Authorization: `Basic ${Buffer.from("dopplersky:calypso").toString("base64")}` },
    });
    expect(authorized.status).toBe(200);
    const body = await authorized.text();
    expect(body).toContain("Worker pulse");
    expect(body).toContain("new EventSource('/events')");
    // External navigation is intentional; the dashboard must still load no external assets.
    expect(body).not.toMatch(/<(?:script|link|img)\b[^>]*(?:src|href)=["']https?:\/\//i);
    expect(authorized.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(authorized.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

function emptyDatabaseSnapshot(): DatabaseSnapshot {
  return {
    sampledAt: new Date().toISOString(),
    queryDurationMs: 1,
    queue: [],
    queueTotals: { total: 0, overdue: 0, scheduled: 0, leased: 0, expiredLeases: 0, withErrors: 0 },
    workers: [],
    accounts: [],
    trackedAccounts: { total: 0, rows: [] },
    onboarding: [],
    workload: {
      trackedAccounts: 0,
      enabledPosts: 0,
      replayWindowPosts: 0,
      dueMaintenancePosts: 0,
      replaySamplesLastHour: 0,
      stalestPostSampleSeconds: null,
      databaseBytes: 0,
      databaseConnections: 0,
    },
  };
}
