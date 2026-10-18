import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type DidString, isDidString } from "@atproto/lex";
import { DASHBOARD_HTML } from "./dashboard-html.js";
import type { DatabaseSnapshot } from "./database-snapshot.js";
import type { WorkerMetrics } from "./metrics.js";
import type { RisingPostsSnapshot } from "./rising-posts.js";

/**
 * The four per-account operator actions the dashboard can drive. Each mirrors a
 * CLI verb and returns false when the target DID is not a tracked account, which
 * the handler maps to 404. Wiring this optional keeps a read-only deployment
 * read-only — the action route only mounts when it is provided.
 */
export type DashboardActions = {
  disable(did: DidString): Promise<boolean>;
  enable(did: DidString): Promise<boolean>;
  audienceOn(did: DidString): Promise<boolean>;
  audienceOff(did: DidString): Promise<boolean>;
};

const ACCOUNT_ACTIONS = ["disable", "enable", "audience-on", "audience-off"] as const;
type AccountAction = (typeof ACCOUNT_ACTIONS)[number];
const MAX_ACTION_BODY_BYTES = 2_048;

export type DashboardServerOptions = {
  host: string;
  port: number;
  username: string;
  password: string;
  refreshMs: number;
  metrics: WorkerMetrics;
  readDatabaseSnapshot: () => Promise<DatabaseSnapshot>;
  readRisingPosts?: () => Promise<RisingPostsSnapshot>;
  actions?: DashboardActions;
};

const RISING_CACHE_MS = 30_000;

export class DashboardServer {
  private readonly clients = new Set<ServerResponse>();
  private server?: Server;
  private timer?: NodeJS.Timeout;
  private polling = false;
  private risingCache?: { value: RisingPostsSnapshot; at: number };
  private risingRead?: Promise<RisingPostsSnapshot>;
  private risingRetryAfter = 0;

  constructor(private readonly options: DashboardServerOptions) {}

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) throw new Error("Dashboard server is already running");
    this.server = createServer((request, response) => this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (!server) return reject(new Error("Dashboard server was not created"));
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(this.options.port, this.options.host, () => {
        server.off("error", onError);
        resolve();
      });
    });
    const address = this.server.address() as AddressInfo;
    return { host: this.options.host, port: address.port };
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const client of this.clients) client.end();
    this.clients.clear();
    const server = this.server;
    this.server = undefined;
    if (!server || !server.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    if (!isAuthorized(request.headers.authorization, this.options.username, this.options.password)) {
      response.writeHead(401, {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "WWW-Authenticate": 'Basic realm="Dopplersky worker", charset="UTF-8"',
      });
      response.end("Authentication required\n");
      return;
    }

    const method = request.method ?? "GET";
    const path = new URL(request.url ?? "/", "http://dashboard.local").pathname;
    if (method === "GET" && path === "/") {
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
        "Content-Type": "text/html; charset=utf-8",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      });
      response.end(DASHBOARD_HTML);
      return;
    }
    if (method === "GET" && path === "/events") {
      this.addClient(request, response);
      return;
    }
    if (path === "/rising-posts") {
      response.setHeader("X-Robots-Tag", "noindex, nofollow");
      if (!this.options.readRisingPosts) {
        return this.sendJson(response, 404, { ok: false, error: "Rising posts are not enabled" });
      }
      if (method !== "GET") {
        response.writeHead(405, { "Cache-Control": "no-store", Allow: "GET" });
        response.end();
        return;
      }
      void this.handleRisingPosts(response, this.options.readRisingPosts);
      return;
    }
    if (method === "GET" && path === "/healthz") {
      response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json" });
      response.end('{"ok":true}\n');
      return;
    }
    if (path === "/actions/account") {
      if (!this.options.actions) {
        return this.sendJson(response, 404, { ok: false, error: "Actions are not enabled" });
      }
      if (method !== "POST") {
        response.writeHead(405, { "Cache-Control": "no-store", Allow: "POST" });
        response.end();
        return;
      }
      void this.handleAccountAction(request, response, this.options.actions);
      return;
    }
    response.writeHead(404, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
  }

  /** Separate, demand-driven read: never add this work to the 2s SSE loop. */
  private async handleRisingPosts(
    response: ServerResponse,
    read: () => Promise<RisingPostsSnapshot>,
  ): Promise<void> {
    if (this.risingCache && Date.now() - this.risingCache.at < RISING_CACHE_MS) {
      return this.sendJson(response, 200, this.risingCache.value);
    }
    if (Date.now() < this.risingRetryAfter) {
      response.setHeader("Retry-After", "30");
      return this.sendJson(response, 503, { ok: false, error: "Rising posts temporarily unavailable" });
    }
    if (!this.risingRead) {
      const pending = Promise.resolve().then(read).then((value) => {
        this.risingCache = { value, at: Date.now() };
        return value;
      }).catch((error: unknown) => {
        this.risingCache = undefined;
        this.risingRetryAfter = Date.now() + RISING_CACHE_MS;
        console.error(JSON.stringify({ level: "error", component: "dashboard", message: "Rising posts query failed" }));
        throw error;
      }).finally(() => {
        this.risingRead = undefined;
      });
      this.risingRead = pending;
    }
    try {
      const value = await this.risingRead;
      if (!response.destroyed && !response.writableEnded) this.sendJson(response, 200, value);
    } catch {
      if (!response.destroyed && !response.writableEnded) {
        response.setHeader("Retry-After", "30");
        this.sendJson(response, 503, { ok: false, error: "Rising posts temporarily unavailable" });
      }
    }
  }

  private async handleAccountAction(
    request: IncomingMessage,
    response: ServerResponse,
    actions: DashboardActions,
  ): Promise<void> {
    let body: string;
    try {
      body = await readBody(request, MAX_ACTION_BODY_BYTES);
    } catch {
      return this.sendJson(response, 413, { ok: false, error: "Request body too large" });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return this.sendJson(response, 400, { ok: false, error: "Invalid JSON body" });
    }
    const { did, action } = (parsed ?? {}) as { did?: unknown; action?: unknown };
    if (typeof did !== "string" || !isDidString(did)) {
      return this.sendJson(response, 400, { ok: false, error: "A valid account DID is required" });
    }
    if (typeof action !== "string" || !ACCOUNT_ACTIONS.includes(action as AccountAction)) {
      return this.sendJson(response, 400, { ok: false, error: "Unknown action" });
    }
    try {
      const applied = await this.applyAction(actions, action as AccountAction, did);
      if (!applied) {
        return this.sendJson(response, 404, { ok: false, error: "No such tracked account" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ level: "error", component: "dashboard", action, message }));
      return this.sendJson(response, 500, { ok: false, error: "Action failed" });
    }
    // Push a fresh snapshot so the operator sees the new state immediately rather
    // than waiting for the next 2s tick.
    void this.poll();
    this.sendJson(response, 200, { ok: true });
  }

  private applyAction(actions: DashboardActions, action: AccountAction, did: DidString): Promise<boolean> {
    switch (action) {
      case "disable": return actions.disable(did);
      case "enable": return actions.enable(did);
      case "audience-on": return actions.audienceOn(did);
      case "audience-off": return actions.audienceOff(did);
    }
  }

  private sendJson(response: ServerResponse, status: number, payload: unknown): void {
    response.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
    response.end(`${JSON.stringify(payload)}\n`);
  }

  private addClient(request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
      "Cache-Control": "no-cache, no-store, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    });
    response.write("retry: 2000\n\n");
    this.clients.add(response);
    const remove = () => {
      this.clients.delete(response);
      if (this.clients.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    };
    request.once("close", remove);
    response.once("close", remove);

    if (!this.timer) {
      void this.poll();
      this.timer = setInterval(() => void this.poll(), this.options.refreshMs);
      this.timer.unref();
    }
  }

  private async poll(): Promise<void> {
    if (this.polling || this.clients.size === 0) return;
    this.polling = true;
    try {
      const database = await this.options.readDatabaseSnapshot();
      this.broadcast("snapshot", {
        runtime: this.options.metrics.snapshot(),
        database,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({
        level: "error",
        component: "dashboard",
        message,
      }));
      this.broadcast("dashboard-error", { message: "Database snapshot failed" });
    } finally {
      this.polling = false;
    }
  }

  private broadcast(event: string, payload: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.clients) client.write(frame);
  }
}

function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        request.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

export function isAuthorized(
  authorization: string | undefined,
  expectedUsername: string,
  expectedPassword: string,
): boolean {
  if (!authorization?.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return false;
    return safeEqual(decoded.slice(0, separator), expectedUsername) &&
      safeEqual(decoded.slice(separator + 1), expectedPassword);
  } catch {
    return false;
  }
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
