import type { Pool } from "pg";

export type QueueRow = {
  kind: string;
  priority: number;
  total: number;
  overdue: number;
  scheduled: number;
  leased: number;
  expiredLeases: number;
  withErrors: number;
  oldestOverdueSeconds: number | null;
  p50OverdueSeconds: number | null;
  p95OverdueSeconds: number | null;
};

export type DatabaseSnapshot = {
  sampledAt: string;
  queryDurationMs: number;
  queue: QueueRow[];
  queueTotals: {
    total: number;
    overdue: number;
    scheduled: number;
    leased: number;
    expiredLeases: number;
    withErrors: number;
  };
  workers: Array<{
    workerId: string;
    activeLeases: number;
    nextLeaseExpirySeconds: number;
  }>;
  accounts: Array<{ state: string; count: number }>;
  trackedAccounts: {
    total: number;
    rows: Array<{
      did: string;
      handle: string;
      displayName: string | null;
      enabled: boolean;
      audienceEnabled: boolean;
      baselineState: string;
      followers: number | null;
      trackedPosts: number;
      lastProfileRefreshSeconds: number | null;
    }>;
  };
  onboarding: Array<{
    handle: string;
    state: string;
    pagesProcessed: number;
    postsDiscovered: number;
    appviewRequests: number;
    ageSeconds: number;
    idleSeconds: number;
  }>;
  workload: {
    trackedAccounts: number;
    enabledPosts: number;
    replayWindowPosts: number;
    dueMaintenancePosts: number;
    replaySamplesLastHour: number;
    stalestPostSampleSeconds: number | null;
    databaseBytes: number;
    databaseConnections: number;
  };
};

type QueueDbRow = {
  kind: string;
  priority: number;
  total: number;
  overdue: number;
  scheduled: number;
  leased: number;
  expired_leases: number;
  with_errors: number;
  oldest_overdue_seconds: number | null;
  p50_overdue_seconds: number | null;
  p95_overdue_seconds: number | null;
};

// The operator table lists every tracked account, enabled or not, but caps the
// per-snapshot payload so a large roster can't bloat the 2s SSE frame. The count
// window (below) still reports the true total so the UI can flag truncation.
const TRACKED_ACCOUNTS_LIMIT = 250;

type TrackedAccountDbRow = {
  did: string;
  handle: string;
  display_name: string | null;
  enabled: boolean;
  audience_enabled: boolean;
  baseline_state: string;
  followers: string | null;
  tracked_posts: number;
  last_profile_refresh_seconds: number | null;
  total_accounts: number;
};

export type Workload = DatabaseSnapshot["workload"];

/**
 * The cheap, per-tick blocks: queue, workers, accounts, the tracked-account
 * page, and onboarding. These are small aggregates or capped scans (~200-400ms
 * total) and are safe to run on the 2s SSE cadence. The expensive workload
 * counts are read separately (see `readWorkloadBlock`) and cached, so they never
 * sit on this hot path. `queryDurationMs` here is what a 2s frame actually waits
 * on — the workload refresh happens in the background.
 */
async function readLiveSnapshot(pool: Pool): Promise<Omit<DatabaseSnapshot, "workload">> {
  const started = performance.now();
  const [queueResult, workerResult, accountResult, trackedAccountResult, onboardingResult] =
    await Promise.all([
    pool.query<QueueDbRow>(
      `SELECT
         kind,
         priority::int,
         count(*)::int AS total,
         count(*) FILTER (WHERE due_at <= now())::int AS overdue,
         count(*) FILTER (WHERE due_at > now())::int AS scheduled,
         count(*) FILTER (WHERE lease_expires_at > now())::int AS leased,
         count(*) FILTER (
           WHERE leased_by IS NOT NULL AND lease_expires_at <= now()
         )::int AS expired_leases,
         count(*) FILTER (WHERE last_error IS NOT NULL)::int AS with_errors,
         max(EXTRACT(EPOCH FROM (now() - due_at)))
           FILTER (WHERE due_at <= now())::float8 AS oldest_overdue_seconds,
         percentile_cont(0.5) WITHIN GROUP (
           ORDER BY EXTRACT(EPOCH FROM (now() - due_at))
         ) FILTER (WHERE due_at <= now())::float8 AS p50_overdue_seconds,
         percentile_cont(0.95) WITHIN GROUP (
           ORDER BY EXTRACT(EPOCH FROM (now() - due_at))
         ) FILTER (WHERE due_at <= now())::float8 AS p95_overdue_seconds
       FROM analytics.jobs
       GROUP BY kind, priority
       ORDER BY priority DESC, kind ASC`,
    ),
    pool.query<{
      worker_id: string;
      active_leases: number;
      next_lease_expiry_seconds: number;
    }>(
      `SELECT
         leased_by AS worker_id,
         count(*)::int AS active_leases,
         min(EXTRACT(EPOCH FROM (lease_expires_at - now())))::float8
           AS next_lease_expiry_seconds
       FROM analytics.jobs
       WHERE leased_by IS NOT NULL AND lease_expires_at > now()
       GROUP BY leased_by
       ORDER BY leased_by`,
    ),
    pool.query<{ state: string; count: number }>(
      `SELECT baseline_state AS state, count(*)::int AS count
       FROM analytics.tracked_accounts
       WHERE enabled
       GROUP BY baseline_state
       ORDER BY baseline_state`,
    ),
    pool.query<TrackedAccountDbRow>(
      `SELECT
         ta.did,
         COALESCE(actors.handle, ta.did) AS handle,
         actors.display_name,
         ta.enabled,
         ta.audience_enabled,
         ta.baseline_state,
         latest.followers,
         (SELECT count(*)::int
          FROM analytics.tracked_posts tp
          WHERE tp.account_did = ta.did AND tp.enabled) AS tracked_posts,
         EXTRACT(EPOCH FROM (now() - ta.last_profile_refresh_at))::float8
           AS last_profile_refresh_seconds,
         count(*) OVER ()::int AS total_accounts
       FROM analytics.tracked_accounts ta
       LEFT JOIN analytics.actors actors ON actors.did = ta.did
       LEFT JOIN LATERAL (
         SELECT followers FROM analytics.account_metric_samples s
         WHERE s.did = ta.did
         ORDER BY s.sampled_at DESC
         LIMIT 1
       ) latest ON true
       ORDER BY ta.enabled DESC, ta.priority DESC, latest.followers DESC NULLS LAST, handle ASC
       LIMIT ${TRACKED_ACCOUNTS_LIMIT}`,
    ),
    pool.query<{
      handle: string | null;
      state: string;
      pages_processed: number;
      posts_discovered: number;
      appview_requests: number;
      age_seconds: number;
      idle_seconds: number;
    }>(
      `SELECT
         COALESCE(actors.handle, runs.did) AS handle,
         runs.state,
         runs.pages_processed,
         runs.posts_discovered,
         runs.appview_requests,
         EXTRACT(EPOCH FROM (now() - runs.started_at))::float8 AS age_seconds,
         EXTRACT(EPOCH FROM (now() - runs.last_progress_at))::float8 AS idle_seconds
       FROM analytics.collection_runs runs
       LEFT JOIN analytics.actors actors ON actors.did = runs.did
       WHERE runs.kind = 'post_baseline'
         AND (runs.state IN ('queued', 'collecting', 'degraded')
           OR runs.completed_at > now() - interval '1 hour')
       ORDER BY
         CASE runs.state WHEN 'collecting' THEN 0 WHEN 'queued' THEN 1
           WHEN 'degraded' THEN 2 ELSE 3 END,
         runs.started_at DESC
       LIMIT 10`,
    ),
  ]);

  const queue = queueResult.rows.map((row) => ({
    kind: row.kind,
    priority: row.priority,
    total: row.total,
    overdue: row.overdue,
    scheduled: row.scheduled,
    leased: row.leased,
    expiredLeases: row.expired_leases,
    withErrors: row.with_errors,
    oldestOverdueSeconds: nullableNumber(row.oldest_overdue_seconds),
    p50OverdueSeconds: nullableNumber(row.p50_overdue_seconds),
    p95OverdueSeconds: nullableNumber(row.p95_overdue_seconds),
  }));

  return {
    sampledAt: new Date().toISOString(),
    queryDurationMs: Math.round((performance.now() - started) * 10) / 10,
    queue,
    queueTotals: queue.reduce((totals, row) => ({
      total: totals.total + row.total,
      overdue: totals.overdue + row.overdue,
      scheduled: totals.scheduled + row.scheduled,
      leased: totals.leased + row.leased,
      expiredLeases: totals.expiredLeases + row.expiredLeases,
      withErrors: totals.withErrors + row.withErrors,
    }), { total: 0, overdue: 0, scheduled: 0, leased: 0, expiredLeases: 0, withErrors: 0 }),
    workers: workerResult.rows.map((row) => ({
      workerId: row.worker_id,
      activeLeases: row.active_leases,
      nextLeaseExpirySeconds: Number(row.next_lease_expiry_seconds),
    })),
    accounts: accountResult.rows,
    trackedAccounts: {
      total: trackedAccountResult.rows[0]?.total_accounts ?? 0,
      rows: trackedAccountResult.rows.map((row) => ({
        did: row.did,
        handle: row.handle,
        displayName: row.display_name,
        enabled: row.enabled,
        audienceEnabled: row.audience_enabled,
        baselineState: row.baseline_state,
        followers: row.followers === null ? null : Number(row.followers),
        trackedPosts: row.tracked_posts,
        lastProfileRefreshSeconds: nullableNumber(row.last_profile_refresh_seconds),
      })),
    },
    onboarding: onboardingResult.rows.map((row) => ({
      handle: row.handle ?? "unknown",
      state: row.state,
      pagesProcessed: row.pages_processed,
      postsDiscovered: row.posts_discovered,
      appviewRequests: row.appview_requests,
      ageSeconds: Number(row.age_seconds),
      idleSeconds: Number(row.idle_seconds),
    })),
  };
}

/**
 * The expensive workload counts: enabled posts and stalest sample scan the full
 * ~4.6M-row tracked_posts, the 30-day replay window scans posts, and the
 * last-hour sample count scans post_metric_samples — together ~2.5s on the prod
 * DB. They barely move second to second, so a cached reader refreshes them on a
 * slow cadence off the hot path (see createDatabaseSnapshotReader) instead of
 * paying this cost on every 2s frame.
 */
export async function readWorkloadBlock(pool: Pool): Promise<Workload> {
  const result = await pool.query<{
    tracked_accounts: number;
    enabled_posts: number;
    replay_window_posts: number;
    due_maintenance_posts: number;
    replay_samples_last_hour: number;
    stalest_post_sample_seconds: number | null;
    database_bytes: string;
    database_connections: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM analytics.tracked_accounts WHERE enabled)
         AS tracked_accounts,
       (SELECT count(*)::int FROM analytics.tracked_posts WHERE enabled)
         AS enabled_posts,
       (SELECT count(*)::int
        FROM analytics.tracked_posts tracked
        JOIN analytics.posts posts ON posts.uri = tracked.uri
        WHERE tracked.enabled
          AND tracked.reason = 'account'
          AND posts.created_at >= now() - interval '30 days')
         AS replay_window_posts,
       (SELECT count(*)::int
        FROM analytics.tracked_posts
        WHERE enabled AND next_poll_at <= now())
         AS due_maintenance_posts,
       (SELECT count(*)::int
        FROM analytics.post_metric_samples
        WHERE sampled_at >= now() - interval '1 hour')
         AS replay_samples_last_hour,
       (SELECT max(EXTRACT(EPOCH FROM (now() - metrics_sampled_at)))::float8
        FROM analytics.tracked_posts
        WHERE enabled AND metrics_sampled_at IS NOT NULL)
         AS stalest_post_sample_seconds,
       pg_database_size(current_database())::text AS database_bytes,
       (SELECT count(*)::int
        FROM pg_stat_activity
        WHERE datname = current_database()) AS database_connections`,
  );
  const workload = result.rows[0];
  if (!workload) throw new Error("Observability workload query returned no row");
  return {
    trackedAccounts: workload.tracked_accounts,
    enabledPosts: workload.enabled_posts,
    replayWindowPosts: workload.replay_window_posts,
    dueMaintenancePosts: workload.due_maintenance_posts,
    replaySamplesLastHour: workload.replay_samples_last_hour,
    stalestPostSampleSeconds: nullableNumber(workload.stalest_post_sample_seconds),
    databaseBytes: Number(workload.database_bytes),
    databaseConnections: workload.database_connections,
  };
}

/**
 * Full snapshot in one shot (live blocks + a fresh workload read). Kept for
 * callers/tests that want everything without caching; the dashboard uses
 * createDatabaseSnapshotReader instead so the workload cost stays off the hot path.
 */
export async function readDatabaseSnapshot(pool: Pool): Promise<DatabaseSnapshot> {
  const [live, workload] = await Promise.all([readLiveSnapshot(pool), readWorkloadBlock(pool)]);
  return { ...live, workload };
}

/**
 * A snapshot reader that keeps the expensive workload counts off the 2s SSE
 * cadence: live blocks are read every call (~200-400ms), while the workload
 * block is cached and refreshed in the BACKGROUND once it is older than
 * `workloadTtlMs`. A frame never blocks on the workload query except the very
 * first call (cold cache); after that it serves the last value and refreshes
 * asynchronously. A failed refresh keeps the last good value rather than
 * blanking the panel. `readLive`/`readWorkload`/`now` are injectable for tests.
 */
export function createDatabaseSnapshotReader(
  pool: Pool,
  options: {
    workloadTtlMs?: number;
    now?: () => number;
    readLive?: (pool: Pool) => Promise<Omit<DatabaseSnapshot, "workload">>;
    readWorkload?: (pool: Pool) => Promise<Workload>;
  } = {},
): () => Promise<DatabaseSnapshot> {
  const ttlMs = options.workloadTtlMs ?? 30_000;
  const now = options.now ?? Date.now;
  const readLive = options.readLive ?? readLiveSnapshot;
  const readWorkload = options.readWorkload ?? readWorkloadBlock;

  let cache: { at: number; value: Workload } | null = null;
  let refreshing: Promise<void> | null = null;
  const refresh = (): Promise<void> => {
    if (refreshing) return refreshing; // coalesce concurrent refreshes
    refreshing = readWorkload(pool)
      .then((value) => { cache = { at: now(), value }; })
      .catch(() => { /* keep the last good value; a transient error must not blank the panel */ })
      .finally(() => { refreshing = null; });
    return refreshing;
  };

  return async function readSnapshot(): Promise<DatabaseSnapshot> {
    if (!cache) await refresh(); // cold cache: block once so the first frame has real numbers
    else if (now() - cache.at > ttlMs) void refresh(); // stale: refresh in the background
    const live = await readLive(pool);
    // cache may still be null if the very first refresh failed; fall back to a
    // direct read so the panel shows real numbers (this call may throw, which
    // the dashboard poll surfaces as a snapshot error rather than fake zeros).
    const workload = cache?.value ?? await readWorkload(pool);
    return { ...live, workload };
  };
}

function nullableNumber(value: number | null): number | null {
  return value === null ? null : Number(value);
}
