export type WorkerConfig = {
  databaseUrl: string;
  appviewUrl: string;
  tapUrl: string;
  tapAdminPassword?: string;
  apiSyncUrl?: string;
  apiSyncToken?: string;
  /**
   * Where to POST the hourly lifecycle-email pass, and the bearer to send with
   * it. Absent means notifications are genuinely unconfigured: the dispatch job
   * no-ops and the API's route would answer 503 anyway. Separate from the sync
   * pair on purpose — the sync URL points at the worker-sync receiver, and
   * overloading one setting for two destinations is how a config drifts into
   * being wrong in one place only.
   */
  notificationsUrl?: string;
  notificationsToken?: string;
  /** Derived from `notificationsUrl`; false leaves the dispatch job a no-op. */
  notificationsEnabled: boolean;
  workerId: string;
  pollConcurrency: number;
  jobLeaseSeconds: number;
  maxJobAttempts: number;
  postMaintenanceBatch: number;
  /**
   * How soon a `posts.maintenance` job re-wakes when its last batch came back
   * full — i.e. more posts are still due. Lower drains a backlog faster (a bulk
   * refresh reset all posts due at once); higher paces AppView harder. Steady
   * state is unaffected: a wake with a non-full batch idles ~15m instead. Default
   * 2s: at concurrency 4 and batch 25 that is a steady ~4 `getPosts`/s aggregate,
   * far under the public AppView ceiling, and a full ~17k-post backlog drains in
   * minutes instead of hours. Validated by the 2026-08-28 bulk refresh (D13).
   */
  postMaintenanceDrainMs: number;
  /**
   * How many consecutive maintenance cycles a tracked post must be absent from a
   * *nonempty* `getPosts` response before it is disabled as deleted. A wholly
   * empty response is a transient AppView blip and disables nothing regardless.
   * This is the cold backstop only — Jetstream still disables a post the instant
   * its delete event arrives — so a small count trades a brief delay in dropping
   * a genuinely-deleted cold post for immunity to the partial-response window
   * that once disabled ~223k live posts in bulk (design note). Default 3.
   */
  postMaintenanceMissThreshold: number;
  /**
   * Minimum minutes between piggybacked profile re-observations. While a tracked
   * account's own post is actively replaying, the orchestrator opportunistically
   * re-reads the account profile so follower gains show up alongside the post's
   * rising engagement, rather than waiting up to an hour for the next
   * `account.profile` sample. Throttled to at most one `getProfiles` per account
   * per window so a burst of simultaneously-replaying posts can't fan out. Set
   * high to effectively disable; the hourly profile job still runs. Default 5m.
   */
  profilePiggybackMinutes: number;
  /**
   * Audience/engager collection. Default OFF (design note): the first version
   * fanned out to 35k audience rows and a growing Tap resync queue from one
   * signup. When false, no audience job is enqueued, a stale one is dropped on
   * claim, and the forward audience stream never starts.
   *
   * v2 is forward-only and does NOT use Tap: a bounded `account.audience` scan
   * discovers engagers of an account's top recent posts (no per-post job
   * fanout), and a single Jetstream socket watches a bounded, rotating cohort of
   * those engagers (`wantedDids`) going forward — no repository backfill, so
   * there is no uncancellable resync to blow up. See `audienceWatchGlobalCap`.
   */
  audienceCollectionEnabled: boolean;
  /**
   * Top engagers to watch live per subscriber. The `account.audience` scan ranks
   * an account's engagers by recency; the most recent `audienceWatchPerTarget`
   * are eligible for the live Jetstream cohort. Kept small: this is "whose
   * activity best predicts a good time to post", not "everyone who ever engaged".
   */
  audienceWatchPerTarget: number;
  /**
   * Hard ceiling on the live audience cohort across all subscribers — the size
   * of the audience Jetstream socket's `wantedDids` filter. Must stay under
   * Jetstream's documented `wantedDids` limit; the launch-tracking socket has its
   * own separate budget. This is the single global bound that replaces the old
   * unbounded Tap repo set.
   */
  audienceWatchGlobalCap: number;
  /**
   * How many of an account's all-time top-interaction posts the bounded
   * `account.audience` scan reads engagers from per run — the evergreen half of
   * the scan set. Bounds the scan to O((top+recent) × pages), not O(all posts);
   * the W28 fanout was one engager job per discovered post.
   */
  audienceScanTopPosts: number;
  /**
   * How many of an account's most-recent *engaged* posts the scan also reads,
   * unioned with the top-interaction set and deduped. Without this the scan only
   * ever re-reads all-time hits, so an account whose biggest posts are a year old
   * but still posts daily never has its *current* audience sampled (operator,
   * 2026-08-29). "Recent engaged" = newest posts with interactions > 0, so brand-
   * new empty posts don't burn API calls before anyone has engaged.
   */
  audienceScanRecentPosts: number;
  /**
   * Max engagement pages read per post per kind in the `account.audience` scan
   * (100 engagers/page). Caps a viral post at a representative sample instead of
   * enumerating every liker — the honest sample the UI badges as such.
   */
  audienceScanPagesPerPost: number;
  /**
   * Max engagers hydrated (via `getProfiles`, 25/call) per `account.audience`
   * scan, most-engaged first. Follower/post counts come only from `getProfiles`,
   * so ranking the audience by size costs a bounded second pass — cap it to the
   * engagers actually surfaced rather than every drive-by liker.
   */
  audienceHydrateLimit: number;
  /**
   * Live post-launch tracking via Jetstream. Default ON: when a tracked account
   * publishes, the Jetstream consumer schedules a dense `post.metrics` replay job
   * within seconds so the launch is captured at high resolution. This is not the
   * audience fanout W28 disabled — it is O(new posts), one bounded self-
   * terminating job per newly published post, and it degrades gracefully (the
   * worker keeps running its polling paths if the socket cannot connect).
   */
  postLaunchTrackingEnabled: boolean;
  /** Jetstream WebSocket endpoint the launch tracker subscribes to. */
  jetstreamEndpoint: string;
  /** True only when a remote sync endpoint is configured; gates outbox writes. */
  syncEnabled: boolean;
  followerSampleSize: number;
  followerFullScanLimit: number;
  followerRefreshHours: number;
  engagerScanPageLimit: number;
  syncBatchSize: number;
  dashboardEnabled: boolean;
  dashboardHost: string;
  dashboardPort: number;
  dashboardUsername: string;
  dashboardPassword?: string;
  dashboardRefreshMs: number;
};

function integer(name: string, fallback: number, minimum = 1): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function boolean(name: string, fallback: boolean): boolean {
  const value = optional(name)?.toLowerCase();
  if (value === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${name} must be a boolean`);
}

function httpUrl(name: string, fallback?: string): string | undefined {
  const raw = optional(name) ?? fallback;
  if (!raw) return undefined;
  const value = new URL(raw);
  if (value.protocol !== "http:" && value.protocol !== "https:") {
    throw new Error(`${name} must be an http(s) URL`);
  }
  return value.toString();
}

function wsUrl(name: string, fallback: string): string {
  const value = new URL(optional(name) ?? fallback);
  if (value.protocol !== "ws:" && value.protocol !== "wss:") {
    throw new Error(`${name} must be a ws(s) URL`);
  }
  return value.toString();
}

export function loadConfig(): WorkerConfig {
  const databaseUrl = optional("DATABASE_URL");
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const appviewUrl = httpUrl("APPVIEW_URL", "https://public.api.bsky.app");
  const tapUrl = httpUrl("TAP_URL", "http://localhost:2480");
  if (!appviewUrl || !tapUrl) throw new Error("APPVIEW_URL and TAP_URL are required");

  const apiSyncUrl = httpUrl("API_SYNC_URL");
  // Parsed up here with the other optional URLs: the config literal below
  // derives `notificationsEnabled` from it, and a `const` declared after that
  // literal is in its temporal dead zone at the moment it is read.
  const notificationsUrl = httpUrl("NOTIFICATIONS_URL");

  const config: WorkerConfig = {
    databaseUrl,
    appviewUrl,
    tapUrl,
    workerId: optional("WORKER_ID") ?? `worker-${process.pid}`,
    pollConcurrency: integer("POLL_CONCURRENCY", 8),
    jobLeaseSeconds: integer("JOB_LEASE_SECONDS", 120),
    maxJobAttempts: integer("MAX_JOB_ATTEMPTS", 12),
    postMaintenanceBatch: integer("POST_MAINTENANCE_BATCH", 25, 1),
    postMaintenanceDrainMs: integer("POST_MAINTENANCE_DRAIN_MS", 2_000, 250),
    postMaintenanceMissThreshold: integer("POST_MAINTENANCE_MISS_THRESHOLD", 3, 1),
    profilePiggybackMinutes: integer("PROFILE_PIGGYBACK_MINUTES", 5, 1),
    audienceCollectionEnabled: boolean("AUDIENCE_COLLECTION_ENABLED", false),
    audienceWatchPerTarget: integer("AUDIENCE_WATCH_PER_TARGET", 300, 1),
    audienceWatchGlobalCap: integer("AUDIENCE_WATCH_GLOBAL_CAP", 5_000, 1),
    audienceScanTopPosts: integer("AUDIENCE_SCAN_TOP_POSTS", 10, 1),
    audienceScanRecentPosts: integer("AUDIENCE_SCAN_RECENT_POSTS", 15, 0),
    audienceScanPagesPerPost: integer("AUDIENCE_SCAN_PAGES_PER_POST", 3, 1),
    audienceHydrateLimit: integer("AUDIENCE_HYDRATE_LIMIT", 200, 1),
    postLaunchTrackingEnabled: boolean("POST_LAUNCH_TRACKING_ENABLED", true),
    jetstreamEndpoint: wsUrl("JETSTREAM_ENDPOINT", "wss://jetstream2.us-east.bsky.network/subscribe"),
    syncEnabled: apiSyncUrl !== undefined,
    notificationsEnabled: notificationsUrl !== undefined,
    followerSampleSize: integer("FOLLOWER_SAMPLE_SIZE", 2_000),
    followerFullScanLimit: integer("FOLLOWER_FULL_SCAN_LIMIT", 50_000),
    followerRefreshHours: integer("FOLLOWER_REFRESH_HOURS", 24),
    engagerScanPageLimit: integer("ENGAGER_SCAN_PAGE_LIMIT", 100),
    syncBatchSize: integer("SYNC_BATCH_SIZE", 500),
    dashboardEnabled: boolean("WORKER_DASHBOARD_ENABLED", false),
    dashboardHost: optional("WORKER_DASHBOARD_HOST") ?? "127.0.0.1",
    dashboardPort: integer("WORKER_DASHBOARD_PORT", 3002),
    dashboardUsername: optional("WORKER_DASHBOARD_USERNAME") ?? "dopplersky",
    dashboardRefreshMs: integer("WORKER_DASHBOARD_REFRESH_MS", 2_000, 500),
  };
  const tapAdminPassword = optional("TAP_ADMIN_PASSWORD");
  const apiSyncToken = optional("API_SYNC_TOKEN");
  const notificationsToken = optional("NOTIFICATIONS_TOKEN");
  const dashboardPassword = optional("WORKER_DASHBOARD_PASSWORD");
  if (tapAdminPassword) config.tapAdminPassword = tapAdminPassword;
  if (apiSyncUrl) config.apiSyncUrl = apiSyncUrl;
  if (apiSyncToken) config.apiSyncToken = apiSyncToken;
  if (notificationsUrl) config.notificationsUrl = notificationsUrl;
  if (notificationsToken) config.notificationsToken = notificationsToken;
  if (dashboardPassword) config.dashboardPassword = dashboardPassword;
  if (config.dashboardEnabled && !dashboardPassword) {
    throw new Error("WORKER_DASHBOARD_PASSWORD is required when the worker dashboard is enabled");
  }
  return config;
}
