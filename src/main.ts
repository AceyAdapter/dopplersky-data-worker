import "dotenv/config";
import { loadConfig } from "./config.js";
import { DashboardServer } from "./observability/dashboard-server.js";
import { createDatabaseSnapshotReader } from "./observability/database-snapshot.js";
import { readRisingPosts } from "./observability/rising-posts.js";
import { createRuntime } from "./runtime.js";

const config = loadConfig();
const runtime = createRuntime(config);
const abort = new AbortController();

await runtime.store.migrate();
await runtime.orchestrator.bootstrap();

// Cache the expensive workload counts so they refresh in the background on a
// slow cadence instead of on every 2s SSE frame (the ~2.5s pulse query).
const readSnapshot = createDatabaseSnapshotReader(runtime.store.pool);
const dashboard = config.dashboardEnabled
  ? new DashboardServer({
      host: config.dashboardHost,
      port: config.dashboardPort,
      username: config.dashboardUsername,
      password: config.dashboardPassword!,
      refreshMs: config.dashboardRefreshMs,
      metrics: runtime.metrics,
      readDatabaseSnapshot: readSnapshot,
      readRisingPosts: () => readRisingPosts(runtime.store.pool),
      actions: {
        disable: (did) => runtime.store.cancelAccount(did),
        enable: (did) => runtime.store.reactivateAccount(did),
        audienceOn: (did) => runtime.store.enableAudience(did),
        audienceOff: (did) => runtime.store.setAudienceEnabled(did, false),
      },
    })
  : undefined;
if (dashboard) {
  const address = await dashboard.start();
  console.log(JSON.stringify({
    level: "info",
    component: "dashboard",
    message: "worker dashboard listening",
    host: address.host,
    port: address.port,
  }));
}

const shutdown = (signal: string) => {
  console.log(JSON.stringify({ level: "info", message: "shutting down", signal }));
  abort.abort();
};
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

// Live post-launch tracking (default on). Its own loop reconnects with backoff;
// this .catch is the last-resort net so a Jetstream failure degrades gracefully
// — the worker keeps collecting on its polling paths instead of crashing.
const jetstreamTask = config.postLaunchTrackingEnabled
  ? runtime.jetstream.run(abort.signal).catch((error) => {
      if (abort.signal.aborted) return;
      console.error(JSON.stringify({
        level: "error",
        component: "jetstream",
        message: error instanceof Error ? error.message : String(error),
        note: "launch tracking stopped; worker continues on polling paths",
      }));
    })
  : Promise.resolve();

// Forward-only audience capture (opt-in, design note). Its own loop reconnects
// with backoff; this .catch degrades gracefully so a socket failure never takes
// down collection. No Tap, so there is no repository backfill to seed or cancel.
const audienceTask = config.audienceCollectionEnabled
  ? runtime.audienceStream.run(abort.signal).catch((error) => {
      if (abort.signal.aborted) return;
      console.error(JSON.stringify({
        level: "error",
        component: "audience-jetstream",
        message: error instanceof Error ? error.message : String(error),
        note: "audience capture stopped; worker continues on its other paths",
      }));
    })
  : Promise.resolve();

try {
  await Promise.all([
    jetstreamTask,
    audienceTask,
    runtime.orchestrator.run(abort.signal),
  ]);
} catch (error) {
  if (!abort.signal.aborted) throw error;
} finally {
  // A fatal scheduler error must stop sibling consumers before ending their DB
  // pool. Promise.all rejects early; it does not cancel or drain those tasks.
  abort.abort();
  await Promise.allSettled([jetstreamTask, audienceTask]);
  try {
    await dashboard?.close();
  } finally {
    await runtime.store.close();
  }
}
