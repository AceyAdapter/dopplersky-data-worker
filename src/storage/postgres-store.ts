import { readdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  asDatetimeString,
  type DatetimeString,
  type DidString,
} from "@atproto/lex";
import { Pool, type PoolClient } from "pg";
import type {
  AccountProfile,
  AudienceMember,
  BaselineRun,
  Engagement,
  Job,
  JobKind,
  OutboxEvent,
  PostMetrics,
  ProtocolActivity,
} from "../domain/types.js";
import {
  ACCOUNT_POST_METRICS_PRIORITY,
  EXPLICIT_POST_METRICS_PRIORITY,
  POST_REPLAY_WINDOW_MS,
} from "../scheduling/cadence.js";
import type { AnalyticsStore, CohortInput, DuePost, EnsureJobInput, PostMiss, ReplayEnsureResult } from "./store.js";

/** `ensureJob`'s historical default, kept so a caller omitting priority is unchanged. */
const DEFAULT_JOB_PRIORITY = 50;

/**
 * Rows per `ensureJobs` statement. Bounded so a bootstrap page (500 posts, or
 * ~1,900 standing account jobs) stays a small JSON parameter and a short
 * transaction.
 */
const ENSURE_JOB_BATCH = 500;

export class PostgresAnalyticsStore implements AnalyticsStore {
  readonly pool: Pool;
  /**
   * Outbox rows are only appended when a remote sync transport is configured.
   * In the converged same-database topology the API reads this database
   * directly, so an always-on outbox is guaranteed unbounded growth that is
   * never delivered (design note, §7).
   */
  private readonly syncEnabled: boolean;

  constructor(databaseUrl: string, syncEnabled = false) {
    this.syncEnabled = syncEnabled;
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 12,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async migrate(): Promise<void> {
    const migrationsDirectory = dirname(
      fileURLToPath(new URL("../../migrations/001_analytics.sql", import.meta.url)),
    );
    await this.pool.query(
      `CREATE SCHEMA IF NOT EXISTS analytics;
       CREATE TABLE IF NOT EXISTS analytics.schema_migrations (
         version text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const filenames = (await readdir(migrationsDirectory))
      .filter((filename) => /^\d+_[a-z0-9_]+\.sql$/.test(filename))
      .sort();
    for (const filename of filenames) {
      const version = filename.slice(0, -4);
      const applied = await this.pool.query(
        "SELECT 1 FROM analytics.schema_migrations WHERE version = $1",
        [version],
      );
      if (applied.rowCount) continue;
      const migration = await readFile(`${migrationsDirectory}/${filename}`, "utf8");
      await this.transaction(async (client) => {
        await client.query(migration);
        await client.query(
          `INSERT INTO analytics.schema_migrations (version)
           VALUES ($1) ON CONFLICT (version) DO NOTHING`,
          [version],
        );
      });
    }
  }

  async upsertActor(profile: Pick<AccountProfile, "did" | "handle"> & Partial<AccountProfile>): Promise<void> {
    await this.pool.query(
      `INSERT INTO analytics.actors (did, handle, display_name, avatar_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (did) DO UPDATE SET
         handle = COALESCE(EXCLUDED.handle, analytics.actors.handle),
         display_name = COALESCE(EXCLUDED.display_name, analytics.actors.display_name),
         avatar_url = COALESCE(EXCLUDED.avatar_url, analytics.actors.avatar_url),
         updated_at = now()`,
      [profile.did, profile.handle, profile.displayName ?? null, profile.avatar ?? null],
    );
  }

  async trackAccount(profile: AccountProfile): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO analytics.actors (did, handle, display_name, avatar_url)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (did) DO UPDATE SET
           handle = EXCLUDED.handle,
           display_name = EXCLUDED.display_name,
           avatar_url = EXCLUDED.avatar_url,
           updated_at = now()`,
        [profile.did, profile.handle, profile.displayName ?? null, profile.avatar ?? null],
      );
      await client.query(
        `INSERT INTO analytics.tracked_accounts (did)
         VALUES ($1)
         ON CONFLICT (did) DO UPDATE SET enabled = true, updated_at = now()`,
        [profile.did],
      );
    });
  }

  async recordAccountSample(profile: AccountProfile, sampledAt: DatetimeString): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO analytics.account_metric_samples
           (did, sampled_at, followers, following, posts)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (did, sampled_at) DO UPDATE SET
           followers = EXCLUDED.followers,
           following = EXCLUDED.following,
           posts = EXCLUDED.posts`,
        [profile.did, sampledAt, profile.followers, profile.following, profile.posts],
      );
      // Advance the shared throttle clock: every profile observation (hourly
      // account.profile and the active-replay piggyback alike) stamps it, so
      // beginProfileRefreshIfDue measures time since the last real observation.
      await client.query(
        `UPDATE analytics.tracked_accounts SET last_profile_refresh_at = now() WHERE did = $1`,
        [profile.did],
      );
      await this.appendOutbox(client, "account.sampled", profile.did, {
        did: profile.did,
        sampledAt,
        followers: profile.followers,
        following: profile.following,
        posts: profile.posts,
      });
    });
  }

  async refreshAccountEngagementTotals(did: DidString, sampledAt: DatetimeString): Promise<void> {
    await this.pool.query(accountTotalsSql("account.sampled_at = $2"), [did, sampledAt]);
  }

  async refreshLatestAccountEngagementTotals(did: DidString): Promise<void> {
    await this.pool.query(
      accountTotalsSql(
        `account.sampled_at = (
           SELECT max(sampled_at) FROM analytics.account_metric_samples WHERE did = $1
         )`,
      ),
      [did],
    );
  }

  async accountPostsBackfilled(did: DidString): Promise<boolean> {
    const result = await this.pool.query<{ complete: boolean }>(
      `SELECT posts_backfilled_at IS NOT NULL AS complete
       FROM analytics.tracked_accounts
       WHERE did = $1`,
      [did],
    );
    return result.rows[0]?.complete ?? false;
  }

  async markAccountPostsBackfilled(did: DidString): Promise<void> {
    await this.pool.query(
      `UPDATE analytics.tracked_accounts
       SET posts_backfilled_at = COALESCE(posts_backfilled_at, now()),
           baseline_state = 'ready',
           last_safe_error = NULL,
           updated_at = now()
       WHERE did = $1`,
      [did],
    );
  }

  async audienceEnabledForAccount(did: DidString): Promise<boolean> {
    const result = await this.pool.query<{ ok: boolean }>(
      "SELECT (enabled AND audience_enabled) AS ok FROM analytics.tracked_accounts WHERE did = $1",
      [did],
    );
    return result.rows[0]?.ok ?? false;
  }

  async audienceEnabledAccountDids(): Promise<DidString[]> {
    const result = await this.pool.query<{ did: DidString }>(
      "SELECT did FROM analytics.tracked_accounts WHERE enabled AND audience_enabled ORDER BY priority DESC, did",
    );
    return result.rows.map((row) => row.did);
  }

  async setAudienceEnabled(did: DidString, enabled: boolean): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE analytics.tracked_accounts SET audience_enabled = $2, updated_at = now() WHERE did = $1",
      [did, enabled],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async enableAudience(did: DidString): Promise<boolean> {
    // Opt one account into the engager audience scan (W41; the premium hook) and
    // enqueue an immediate scan so it starts without a restart. The scan only
    // runs when AUDIENCE_COLLECTION_ENABLED is on and self-drops otherwise, so
    // the enqueue is harmless when the global flag is off. Mirrors the
    // `enable-audience` CLI verb. Priority 70 matches AUDIENCE_JOB_PRIORITY.
    const updated = await this.setAudienceEnabled(did, true);
    if (!updated) return false;
    await this.enqueue("account.audience", did, new Date(), { did }, 70);
    return true;
  }

  async resetTrial(did: DidString): Promise<boolean> {
    // Clear the trial window and return the user to 'none' so a fresh 7-day
    // trial can be activated. Operator-only (CLI in production): first-activation-
    // wins is deliberate, so nothing in the app can call this, and nothing calls
    // it automatically. The rest of the row — identity, sign-in history — is
    // left untouched.
    const result = await this.pool.query(
      `UPDATE auth.app_user
       SET status = 'none', trial_started_at = NULL, trial_expires_at = NULL, updated_at = now()
       WHERE did = $1`,
      [did],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async grantPremium(did: DidString): Promise<boolean> {
    // Operator grant of a permanent entitlement. `status = 'active'` is the only
    // state the product already reads as premium with NO expiry test, so this
    // needs no schema change and no consumer change — see the interface comment.
    //
    // The trial columns are deliberately left alone: a granted account really did
    // trial, and `trial_started_at` is the operator's conversion signal. Nothing
    // reads `trial_expires_at` while the status is 'active'; `resetTrial` is the
    // way back, and it clears the window as it returns the row to 'none'.
    const result = await this.pool.query(
      `UPDATE auth.app_user
       SET status = 'active', plan = 'premium', updated_at = now()
       WHERE did = $1`,
      [did],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async reactivateAccount(did: DidString): Promise<boolean> {
    // Reverse a prior cancelAccount: re-enable the account and re-establish the
    // O(1) standing jobs that the hard-cancel deleted, so collection resumes
    // without waiting for a worker restart's bootstrap. baseline_state returns to
    // 'ready' if the baseline had completed, otherwise 'queued' so the profile
    // job re-derives it. ensureJob inserts if absent and never pulls an existing
    // due_at forward (W45).
    const result = await this.pool.query(
      `UPDATE analytics.tracked_accounts
       SET enabled = true,
           baseline_state = CASE WHEN posts_backfilled_at IS NOT NULL THEN 'ready' ELSE 'queued' END,
           last_safe_error = NULL,
           profile_miss_count = 0,
           updated_at = now()
       WHERE did = $1`,
      [did],
    );
    if ((result.rowCount ?? 0) === 0) return false;
    const now = new Date();
    await this.ensureJob("account.profile", did, now, { did }, 80);
    await this.ensureJob("posts.maintenance", did, now, { did }, 55);
    return true;
  }

  async accountEnabled(did: DidString): Promise<boolean> {
    const result = await this.pool.query<{ enabled: boolean }>(
      "SELECT enabled FROM analytics.tracked_accounts WHERE did = $1",
      [did],
    );
    return result.rows[0]?.enabled ?? false;
  }

  async cancelAccount(did: DidString): Promise<boolean> {
    return this.transaction(async (client) => {
      const updated = await client.query(
        `UPDATE analytics.tracked_accounts
         SET enabled = false, baseline_state = 'cancelled', updated_at = now()
         WHERE did = $1`,
        [did],
      );
      await client.query(
        `UPDATE analytics.collection_runs
         SET state = 'cancelled', completed_at = now(), last_progress_at = now()
         WHERE did = $1 AND state IN ('queued', 'collecting')`,
        [did],
      );
      // Every account/post job carries its DID in the payload, so this removes
      // queued profile, baseline-pagination, and maintenance work in one delete.
      // A leased job survives, but its handler rechecks `enabled` before doing
      // work and drops itself instead of rescheduling.
      await client.query("DELETE FROM analytics.jobs WHERE payload->>'did' = $1", [did]);
      return (updated.rowCount ?? 0) > 0;
    });
  }

  async registerProfileMiss(did: DidString, threshold: number): Promise<boolean> {
    return this.transaction(async (client) => {
      // Only an enabled account accrues misses; an already-disabled one is a
      // no-op (RETURNING yields no row), so a leased profile job that races the
      // disable can't drive the counter past threshold twice.
      const bumped = await client.query<{ profile_miss_count: number }>(
        `UPDATE analytics.tracked_accounts
         SET profile_miss_count = profile_miss_count + 1, updated_at = now()
         WHERE did = $1 AND enabled
         RETURNING profile_miss_count`,
        [did],
      );
      const count = bumped.rows[0]?.profile_miss_count;
      if (count === undefined || count < threshold) return false;
      // Use the existing cancelled state, as operator disable does. An invented
      // 'unresolvable' state violates migration 004's CHECK and rolls this entire
      // transaction back (including the miss increment). Keep the reason separate
      // in last_safe_error, preserving the database/API collection-state contract.
      await client.query(
        `UPDATE analytics.tracked_accounts
         SET enabled = false, baseline_state = 'cancelled',
             last_safe_error = left($2, 2000), updated_at = now()
         WHERE did = $1`,
        [did, `Profile unresolvable after ${threshold} consecutive checks (deleted/deactivated/suspended)`],
      );
      await client.query(
        `UPDATE analytics.collection_runs
         SET state = 'cancelled', completed_at = now(), last_progress_at = now()
         WHERE did = $1 AND state IN ('queued', 'collecting')`,
        [did],
      );
      // Same one-shot delete as cancelAccount: every account/post job carries the
      // DID in its payload. A concurrently-leased job survives the delete but
      // rechecks `enabled` and drops itself.
      await client.query("DELETE FROM analytics.jobs WHERE payload->>'did' = $1", [did]);
      return true;
    });
  }

  async resetProfileMisses(did: DidString): Promise<void> {
    // Guarded so the healthy hourly path — the overwhelming majority — writes
    // nothing: only an account carrying a streak is touched.
    await this.pool.query(
      `UPDATE analytics.tracked_accounts
       SET profile_miss_count = 0, updated_at = now()
       WHERE did = $1 AND profile_miss_count <> 0`,
      [did],
    );
  }

  async degradeAccount(did: DidString, safeError: string): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        `UPDATE analytics.tracked_accounts
         SET baseline_state = CASE WHEN baseline_state = 'ready' THEN 'ready' ELSE 'degraded' END,
             last_safe_error = left($2, 2000),
             updated_at = now()
         WHERE did = $1`,
        [did, safeError],
      );
      // The run stays 'collecting' with its committed cursor so the daily
      // profile job resumes it; degraded is a rest, not a dead end. Only the
      // record of the failure and the attempt count advance here.
      await client.query(
        `UPDATE analytics.collection_runs
         SET last_safe_error = left($2, 2000),
             attempts = attempts + 1,
             last_progress_at = now()
         WHERE did = $1 AND state = 'collecting'`,
        [did, safeError],
      );
    });
  }

  async getOrCreateBaselineRun(did: DidString, profileSampledAt: DatetimeString): Promise<BaselineRun> {
    return this.transaction(async (client) => {
      const existing = await client.query<{ id: string; cursor: string | null; profile_sampled_at: Date | null }>(
        `SELECT id, cursor, profile_sampled_at FROM analytics.collection_runs
         WHERE did = $1 AND kind = 'post_baseline' AND state IN ('queued', 'collecting')
         ORDER BY started_at DESC
         LIMIT 1`,
        [did],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        return {
          id: Number(row.id),
          ...(row.cursor ? { cursor: row.cursor } : {}),
          profileSampledAt: row.profile_sampled_at
            ? asDatetimeString(row.profile_sampled_at.toISOString())
            : profileSampledAt,
        };
      }
      const created = await client.query<{ id: string }>(
        `INSERT INTO analytics.collection_runs (did, kind, state, profile_sampled_at)
         VALUES ($1, 'post_baseline', 'collecting', $2)
         RETURNING id`,
        [did, profileSampledAt],
      );
      await client.query(
        `UPDATE analytics.tracked_accounts
         SET baseline_state = 'collecting', updated_at = now()
         WHERE did = $1 AND baseline_state <> 'ready'`,
        [did],
      );
      return { id: Number(created.rows[0]!.id), profileSampledAt };
    });
  }

  async advanceBaselineRun(runId: number, cursor: string | undefined, discovered: number): Promise<void> {
    await this.pool.query(
      `UPDATE analytics.collection_runs
       SET cursor = $2,
           pages_processed = pages_processed + 1,
           posts_discovered = posts_discovered + $3,
           appview_requests = appview_requests + 1,
           last_progress_at = now()
       WHERE id = $1`,
      [runId, cursor ?? null, discovered],
    );
  }

  async finalizeBaselineRun(runId: number): Promise<void> {
    await this.pool.query(
      `UPDATE analytics.collection_runs
       SET state = 'ready', cursor = NULL, completed_at = now(),
           last_progress_at = now(), last_safe_error = NULL
       WHERE id = $1`,
      [runId],
    );
  }

  async hasPendingAccountPostsJob(did: DidString): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM analytics.jobs
       WHERE kind = 'account.posts' AND payload->>'did' = $1
       LIMIT 1`,
      [did],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async beginRecentScanIfDue(did: DidString, minHours: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE analytics.tracked_accounts
       SET last_recent_scan_at = now(), updated_at = now()
       WHERE did = $1
         AND (last_recent_scan_at IS NULL OR last_recent_scan_at < now() - ($2 * interval '1 hour'))`,
      [did, minHours],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async beginProfileRefreshIfDue(did: DidString, minMinutes: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE analytics.tracked_accounts
       SET last_profile_refresh_at = now(), updated_at = now()
       WHERE did = $1 AND enabled
         AND (last_profile_refresh_at IS NULL OR last_profile_refresh_at < now() - ($2 * interval '1 minute'))`,
      [did, minMinutes],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async upsertPost(post: PostMetrics, reason: "account" | "explicit", accountDid?: DidString): Promise<boolean> {
    return this.transaction(async (client) => {
      const existing = await client.query(
        "SELECT 1 FROM analytics.tracked_posts WHERE uri = $1",
        [post.uri],
      );
      await client.query(
        `INSERT INTO analytics.actors (did) VALUES ($1)
         ON CONFLICT (did) DO NOTHING`,
        [post.authorDid],
      );
      await client.query(
        `INSERT INTO analytics.posts
           (uri, cid, author_did, created_at, indexed_at, text, is_reply, has_embed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (uri) DO UPDATE SET
           cid = EXCLUDED.cid,
           indexed_at = EXCLUDED.indexed_at,
           text = EXCLUDED.text,
           is_reply = EXCLUDED.is_reply,
           has_embed = EXCLUDED.has_embed,
           updated_at = now()`,
        [
          post.uri,
          post.cid,
          post.authorDid,
          post.createdAt,
          post.indexedAt,
          post.text,
          post.isReply,
          post.hasEmbed,
        ],
      );
      await client.query(
        `INSERT INTO analytics.tracked_posts (uri, account_did, reason)
         VALUES ($1, $2, $3)
         ON CONFLICT (uri) DO UPDATE SET
           account_did = COALESCE(EXCLUDED.account_did, analytics.tracked_posts.account_did),
           reason = CASE WHEN EXCLUDED.reason = 'explicit' THEN 'explicit' ELSE analytics.tracked_posts.reason END,
           enabled = true,
           updated_at = now()`,
        [post.uri, accountDid ?? null, reason],
      );
      return existing.rowCount === 0;
    });
  }

  async seedLaunchPost(post: PostMetrics, accountDid: DidString): Promise<void> {
    const parkAt = new Date(new Date(post.createdAt).getTime() + POST_REPLAY_WINDOW_MS);
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO analytics.actors (did) VALUES ($1) ON CONFLICT (did) DO NOTHING`,
        [post.authorDid],
      );
      await client.query(
        `INSERT INTO analytics.posts
           (uri, cid, author_did, created_at, indexed_at, text, is_reply, has_embed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (uri) DO UPDATE SET
           cid = EXCLUDED.cid,
           indexed_at = COALESCE(analytics.posts.indexed_at, EXCLUDED.indexed_at),
           text = EXCLUDED.text,
           is_reply = EXCLUDED.is_reply,
           has_embed = EXCLUDED.has_embed,
           updated_at = now()`,
        [
          post.uri, post.cid, post.authorDid, post.createdAt, post.indexedAt,
          post.text, post.isReply, post.hasEmbed,
        ],
      );
      // Track the post immediately and park cold maintenance past the replay
      // window; the dense post.metrics job owns sampling during the launch. On a
      // replayed create, leave next_poll_at alone so a live replay's schedule is
      // never pulled around.
      await client.query(
        `INSERT INTO analytics.tracked_posts (uri, account_did, reason, next_poll_at)
         VALUES ($1, $2, 'account', $3)
         ON CONFLICT (uri) DO UPDATE SET
           account_did = COALESCE(EXCLUDED.account_did, analytics.tracked_posts.account_did),
           enabled = true,
           updated_at = now()`,
        [post.uri, accountDid, parkAt],
      );
      // Definitional origin sample: a just-created post has zero engagement. Never
      // clobbers a real later sample — the replay writes its own (uri, sampled_at)
      // rows and this one is keyed at created_at.
      await client.query(
        `INSERT INTO analytics.post_metric_samples (uri, sampled_at, likes, replies, quotes, reposts)
         VALUES ($1, $2, 0, 0, 0, 0)
         ON CONFLICT (uri, sampled_at) DO NOTHING`,
        [post.uri, post.createdAt],
      );
      // Initialize current metrics only if absent, so a replayed create can never
      // stomp metrics the replay has since written. account_did is denormalized
      // from the tracking row (written just above) for the per-account ranking.
      await client.query(
        `INSERT INTO analytics.post_current_metrics
           (uri, likes, replies, quotes, reposts, metrics_sampled_at, account_did)
         VALUES ($1, 0, 0, 0, 0, $2,
           (SELECT account_did FROM analytics.tracked_posts WHERE uri = $1))
         ON CONFLICT (uri) DO NOTHING`,
        [post.uri, post.createdAt],
      );
      await this.appendOutbox(client, "post.sampled", post.uri, {
        uri: post.uri,
        cid: post.cid,
        sampledAt: post.createdAt,
        likes: 0,
        replies: 0,
        quotes: 0,
        reposts: 0,
      });
    });
  }

  async disablePost(uri: string): Promise<void> {
    await this.pool.query(
      `UPDATE analytics.tracked_posts
       SET enabled = false, updated_at = now()
       WHERE uri = $1`,
      [uri],
    );
  }

  async registerPostMisses(misses: PostMiss[], threshold: number): Promise<string[]> {
    if (misses.length === 0) return [];
    // One statement: bump each still-enabled post's miss run and reschedule it,
    // flipping enabled off only once the run reaches the threshold. Empty-batch
    // responses never reach here (the collector guards them), so a miss always
    // means "absent from a response that did return other posts".
    const result = await this.pool.query<{ uri: string; enabled: boolean }>(
      `UPDATE analytics.tracked_posts t
       SET consecutive_misses = t.consecutive_misses + 1,
           next_poll_at = miss.next_poll_at,
           enabled = t.consecutive_misses + 1 < $3,
           updated_at = now()
       FROM unnest($1::text[], $2::timestamptz[]) AS miss(uri, next_poll_at)
       WHERE t.uri = miss.uri AND t.enabled
       RETURNING t.uri, t.enabled`,
      [misses.map((m) => m.uri), misses.map((m) => m.nextPollAt.toISOString()), threshold],
    );
    return result.rows.filter((row) => !row.enabled).map((row) => row.uri);
  }

  async upsertPostCurrentMetrics(
    post: PostMetrics,
    sampledAt: DatetimeString,
    nextPollAt: Date,
    runId?: number,
  ): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        `UPDATE analytics.posts
         SET cid = $2, indexed_at = $3, text = $4, is_reply = $5,
             has_embed = $6, updated_at = now()
         WHERE uri = $1`,
        [post.uri, post.cid, post.indexedAt, post.text, post.isReply, post.hasEmbed],
      );
      await client.query(
        // account_did is denormalized from the tracking row (written before any
        // metrics in every path) so the per-account interactions ranking is an
        // ordered index scan (migration 010). `interactions` is a generated
        // column and is never written here.
        `INSERT INTO analytics.post_current_metrics
           (uri, likes, replies, quotes, reposts, metrics_sampled_at, collection_run_id, account_did)
         VALUES ($1, $2, $3, $4, $5, $6, $7,
           (SELECT account_did FROM analytics.tracked_posts WHERE uri = $1))
         ON CONFLICT (uri) DO UPDATE SET
           likes = EXCLUDED.likes,
           replies = EXCLUDED.replies,
           quotes = EXCLUDED.quotes,
           reposts = EXCLUDED.reposts,
           metrics_sampled_at = EXCLUDED.metrics_sampled_at,
           collection_run_id = COALESCE(EXCLUDED.collection_run_id, analytics.post_current_metrics.collection_run_id),
           account_did = COALESCE(EXCLUDED.account_did, analytics.post_current_metrics.account_did),
           updated_at = now()`,
        [post.uri, post.likes, post.replies, post.quotes, post.reposts, sampledAt, runId ?? null],
      );
      await client.query(
        `UPDATE analytics.tracked_posts
         SET metrics_sampled_at = $2,
             next_poll_at = $3,
             refresh_count = refresh_count + 1,
             consecutive_misses = 0,
             updated_at = now()
         WHERE uri = $1`,
        [post.uri, sampledAt, nextPollAt],
      );
    });
  }

  async dueMaintenancePosts(did: DidString, limit: number): Promise<DuePost[]> {
    const result = await this.pool.query<{ uri: string; created_at: Date }>(
      `SELECT tracked.uri, post.created_at
       FROM analytics.tracked_posts tracked
       JOIN analytics.posts post ON post.uri = tracked.uri
       WHERE tracked.account_did = $1
         AND tracked.enabled
         AND tracked.next_poll_at <= now()
       ORDER BY tracked.next_poll_at ASC
       LIMIT $2`,
      [did, limit],
    );
    return result.rows.map((row) => ({
      uri: row.uri,
      createdAt: asDatetimeString(row.created_at.toISOString()),
    }));
  }

  async recordPostSample(post: PostMetrics, sampledAt: DatetimeString): Promise<boolean> {
    return this.transaction(async (client) => {
      const latest = await client.query<{
        likes: string;
        replies: string;
        quotes: string;
        reposts: string;
      }>(
        `SELECT likes, replies, quotes, reposts
         FROM analytics.post_metric_samples
         WHERE uri = $1
         ORDER BY sampled_at DESC
         LIMIT 1`,
        [post.uri],
      );
      const previous = latest.rows[0];
      const changed = !previous ||
        Number(previous.likes) !== post.likes ||
        Number(previous.replies) !== post.replies ||
        Number(previous.quotes) !== post.quotes ||
        Number(previous.reposts) !== post.reposts;
      if (!changed) return false;

      await client.query(
        `INSERT INTO analytics.post_metric_samples
           (uri, sampled_at, likes, replies, quotes, reposts)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (uri, sampled_at) DO NOTHING`,
        [post.uri, sampledAt, post.likes, post.replies, post.quotes, post.reposts],
      );
      await client.query(
        `UPDATE analytics.tracked_posts
         SET last_changed_at = $2, updated_at = now()
         WHERE uri = $1`,
        [post.uri, sampledAt],
      );
      // Refresh the post's virality ranking value (migration 011). A running max
      // over the post's own sample series — cheap and O(1) per account (no
      // fanout): the series is bounded to the dense post-launch window. Mirrors
      // the replay view's `peakPerHour`, but floors the interval at 600s so an
      // early 30-second sample cannot read as thousands/hour. The max only grows
      // as samples accrue, so a write that adds no qualifying interval leaves the
      // stored value untouched rather than clearing it.
      await client.query(
        `WITH rated AS (
           SELECT
             sample.sampled_at,
             lag(sample.sampled_at) OVER w AS prev_at,
             ((sample.likes + sample.replies + sample.quotes + sample.reposts)
              - lag(sample.likes + sample.replies + sample.quotes + sample.reposts) OVER w)::double precision AS gain,
             extract(epoch FROM (sample.sampled_at - lag(sample.sampled_at) OVER w)) AS interval_seconds
           FROM analytics.post_metric_samples sample
           WHERE sample.uri = $1
           WINDOW w AS (ORDER BY sample.sampled_at)
         ),
         peak AS (
           SELECT sampled_at, gain / (interval_seconds / 3600.0) AS rate
           FROM rated
           WHERE prev_at IS NOT NULL AND interval_seconds >= 600 AND gain > 0
           ORDER BY rate DESC
           LIMIT 1
         )
         UPDATE analytics.post_current_metrics metric
         SET peak_interactions_per_hour = peak.rate,
             peak_velocity_at_seconds = GREATEST(0, extract(epoch FROM (peak.sampled_at - post.created_at)))::integer
         FROM peak, analytics.posts post
         WHERE metric.uri = $1 AND post.uri = $1`,
        [post.uri],
      );
      // Refresh the post's launch-window ranking value (migration 018): the
      // cumulative interactions at the last sample within the first 24h of the
      // post's life. A post starts at zero, so this is the interactions gained
      // in the launch window; the API derives the average/hour rate from it at
      // read time (count / min(24h, age)). Storing the count, not the rate, lets
      // it freeze correctly once the window closes even if the post then goes
      // quiet and stops producing samples — while a sample past 24h leaves the
      // in-window count untouched rather than growing it. No in-window sample
      // (a post first seen after its launch closed) leaves the value NULL.
      await client.query(
        `UPDATE analytics.post_current_metrics metric
         SET launch_window_interactions = w.interactions
         FROM (
           SELECT (sample.likes + sample.replies + sample.quotes + sample.reposts) AS interactions
           FROM analytics.post_metric_samples sample
           JOIN analytics.posts post ON post.uri = sample.uri
           WHERE sample.uri = $1
             AND sample.sampled_at <= post.created_at + INTERVAL '24 hours'
           ORDER BY sample.sampled_at DESC
           LIMIT 1
         ) w
         WHERE metric.uri = $1`,
        [post.uri],
      );
      await this.appendOutbox(client, "post.sampled", post.uri, {
        uri: post.uri,
        cid: post.cid,
        sampledAt,
        likes: post.likes,
        replies: post.replies,
        quotes: post.quotes,
        reposts: post.reposts,
      });
      return true;
    });
  }

  async createAudienceCohort(input: CohortInput): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO analytics.audience_cohorts
         (target_did, method, population_size, sample_size, scan_complete, seed)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [input.targetDid, input.method, input.populationSize, input.sampleSize, input.scanComplete, input.seed],
    );
    return result.rows[0]!.id;
  }

  async upsertAudienceMembers(members: AudienceMember[], cohortId?: string): Promise<void> {
    if (members.length === 0) return;
    const payload = members.map((member) => ({
      target_did: member.targetDid,
      actor_did: member.did,
      handle: member.handle ?? null,
      display_name: member.displayName ?? null,
      avatar_url: member.avatar ?? null,
      is_follower: member.isFollower ?? null,
      is_engager: member.isEngager,
      inclusion_probability: member.inclusionProbability,
    }));
    await this.transaction(async (client) => {
      await client.query(
        `WITH input AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
             target_did text, actor_did text, handle text, display_name text,
             avatar_url text, is_follower boolean, is_engager boolean,
             inclusion_probability double precision
           )
         )
         INSERT INTO analytics.actors (did, handle, display_name, avatar_url)
         SELECT actor_did, handle, display_name, avatar_url FROM input
         ON CONFLICT (did) DO UPDATE SET
           handle = COALESCE(EXCLUDED.handle, analytics.actors.handle),
           display_name = COALESCE(EXCLUDED.display_name, analytics.actors.display_name),
           avatar_url = COALESCE(EXCLUDED.avatar_url, analytics.actors.avatar_url),
           updated_at = now()`,
        [JSON.stringify(payload)],
      );
      await client.query(
        `WITH input AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
             target_did text, actor_did text, handle text, display_name text,
             avatar_url text, is_follower boolean, is_engager boolean,
             inclusion_probability double precision
           )
         )
         INSERT INTO analytics.audience_members
           (target_did, actor_did, is_follower, is_engager)
         SELECT target_did, actor_did, is_follower, is_engager FROM input
         ON CONFLICT (target_did, actor_did) DO UPDATE SET
           is_follower = COALESCE(EXCLUDED.is_follower, analytics.audience_members.is_follower),
           is_engager = analytics.audience_members.is_engager OR EXCLUDED.is_engager,
           last_seen_at = now()`,
        [JSON.stringify(payload)],
      );
      if (cohortId) {
        await client.query(
          `WITH input AS (
             SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
               actor_did text, inclusion_probability double precision
             )
           )
           INSERT INTO analytics.audience_cohort_members
             (cohort_id, actor_did, inclusion_probability)
           SELECT $2, actor_did, inclusion_probability FROM input
           ON CONFLICT (cohort_id, actor_did) DO UPDATE SET
             inclusion_probability = EXCLUDED.inclusion_probability`,
          [JSON.stringify(payload), cohortId],
        );
      }
    });
  }

  async upsertActorProfiles(profiles: AccountProfile[]): Promise<void> {
    if (profiles.length === 0) return;
    // One row per DID, so the ON CONFLICT (did) batch never updates a row twice.
    const byDid = new Map<string, AccountProfile>();
    for (const profile of profiles) byDid.set(profile.did, profile);
    const payload = [...byDid.values()].map((profile) => ({
      did: profile.did,
      handle: profile.handle,
      display_name: profile.displayName ?? null,
      avatar_url: profile.avatar ?? null,
      followers_count: profile.followers,
      following_count: profile.following,
      posts_count: profile.posts,
    }));
    await this.pool.query(
      `WITH input AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
           did text, handle text, display_name text, avatar_url text,
           followers_count bigint, following_count bigint, posts_count bigint
         )
       )
       INSERT INTO analytics.actors
         (did, handle, display_name, avatar_url,
          followers_count, following_count, posts_count, profile_hydrated_at)
       SELECT did, handle, display_name, avatar_url,
              followers_count, following_count, posts_count, now()
       FROM input
       ON CONFLICT (did) DO UPDATE SET
         handle = COALESCE(EXCLUDED.handle, analytics.actors.handle),
         display_name = COALESCE(EXCLUDED.display_name, analytics.actors.display_name),
         avatar_url = COALESCE(EXCLUDED.avatar_url, analytics.actors.avatar_url),
         followers_count = EXCLUDED.followers_count,
         following_count = EXCLUDED.following_count,
         posts_count = EXCLUDED.posts_count,
         profile_hydrated_at = now(),
         updated_at = now()`,
      [JSON.stringify(payload)],
    );
  }

  async recordEngagements(engagements: Engagement[]): Promise<void> {
    // Collapse to one row per edge_key first: a single INSERT ... ON CONFLICT
    // errors ("cannot affect row a second time") if the batch carries the same
    // conflict key twice, and real getLikes pagination can return one actor twice
    // — which a multi-post scan accumulates into one batch.
    const deduped = dedupeEngagements(engagements);
    if (deduped.length === 0) return;
    const payload = deduped.map((edge) => ({
      edge_key: engagementEdgeKey(edge),
      post_uri: edge.postUri,
      actor_did: edge.actorDid,
      kind: edge.kind,
      record_uri: edge.recordUri ?? null,
      occurred_at: edge.occurredAt ?? null,
    }));
    await this.transaction(async (client) => {
      await client.query(
        `WITH input AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(actor_did text)
         )
         INSERT INTO analytics.actors (did)
         SELECT DISTINCT actor_did FROM input
         ON CONFLICT (did) DO NOTHING`,
        [JSON.stringify(payload)],
      );
      await client.query(
        `WITH input AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
             edge_key text, post_uri text, actor_did text, kind text,
             record_uri text, occurred_at timestamptz
           )
         )
         INSERT INTO analytics.engagement_edges
           (edge_key, post_uri, actor_did, kind, record_uri, occurred_at)
         SELECT edge_key, post_uri, actor_did, kind, record_uri, occurred_at FROM input
         ON CONFLICT (edge_key) DO UPDATE SET
           record_uri = COALESCE(EXCLUDED.record_uri, analytics.engagement_edges.record_uri),
           occurred_at = COALESCE(EXCLUDED.occurred_at, analytics.engagement_edges.occurred_at),
           active = true,
           removed_at = NULL,
           discovered_at = now()`,
        [JSON.stringify(payload)],
      );
    });
  }

  async recordEngagementScan(
    postUri: string,
    kind: Engagement["kind"],
    enumerated: number,
    complete: boolean,
    cursor?: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO analytics.engagement_scan_status
         (post_uri, kind, enumerated, complete, continuation_cursor)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (post_uri, kind) DO UPDATE SET
         enumerated = EXCLUDED.enumerated,
         complete = EXCLUDED.complete,
         continuation_cursor = EXCLUDED.continuation_cursor,
         scanned_at = now()`,
      [postUri, kind, enumerated, complete, cursor ?? null],
    );
  }

  async recordActivity(activity: ProtocolActivity): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO analytics.actors (did) VALUES ($1)
         ON CONFLICT (did) DO NOTHING`,
        [activity.actorDid],
      );
      await client.query(
        `INSERT INTO analytics.protocol_activity
           (record_uri, actor_did, collection, kind, subject_uri, subject_did,
            cid, occurred_at, active, live)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (record_uri) DO UPDATE SET
           subject_uri = COALESCE(EXCLUDED.subject_uri, analytics.protocol_activity.subject_uri),
           subject_did = COALESCE(EXCLUDED.subject_did, analytics.protocol_activity.subject_did),
           cid = COALESCE(EXCLUDED.cid, analytics.protocol_activity.cid),
           occurred_at = CASE
             WHEN EXCLUDED.active THEN EXCLUDED.occurred_at
             ELSE analytics.protocol_activity.occurred_at
           END,
           active = EXCLUDED.active,
           live = EXCLUDED.live,
           updated_at = now()`,
        [
          activity.recordUri,
          activity.actorDid,
          activity.collection,
          activity.kind,
          activity.subjectUri ?? null,
          activity.subjectDid ?? null,
          activity.cid ?? null,
          activity.occurredAt,
          activity.active,
          activity.live,
        ],
      );
    });
  }

  async deactivateActivity(recordUri: string): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        `UPDATE analytics.protocol_activity
         SET active = false, updated_at = now()
         WHERE record_uri = $1`,
        [recordUri],
      );
      await client.query(
        `UPDATE analytics.engagement_edges
         SET active = false,
             removed_at = COALESCE(removed_at, now())
         WHERE record_uri = $1`,
        [recordUri],
      );
    });
  }

  async trackedAccountDids(): Promise<DidString[]> {
    const result = await this.pool.query<{ did: DidString }>(
      "SELECT did FROM analytics.tracked_accounts WHERE enabled ORDER BY priority DESC, did",
    );
    return result.rows.map((row) => row.did);
  }

  /**
   * Reconcile the whole restart replay cohort in one statement (see the store
   * interface). The shape matters more than it looks:
   *
   * - `recent` is MATERIALIZED so the `created_at` filter is applied *before*
   *   the join. Leaving the age test as a join filter makes the planner hash all
   *   5.9M tracked posts against all 5.8M posts and discard 5.7M rows in a
   *   spill-to-disk hash join — measured at 26.6 s on production, versus 4.5 s
   *   for the same rows via the materialized form.
   * - Building the payloads `ORDER BY tracked.uri` keeps the nested-loop plan.
   *   Without the ordering the planner can flip to the hash join above, which is
   *   6x slower for the same answer.
   * - `ON CONFLICT` keeps `ensureJobs`' policy exactly: raise priority, never
   *   pull `due_at` forward. A post published while the worker was down still
   *   gets its launch replay — that is the walk's whole purpose — but an
   *   existing schedule is untouched.
   *
   * Once migration 027's `(created_at, uri)` index exists, the cohort scan is an
   * index-only read over the ~168k in-window rows (12 ms against a
   * production-shaped 5.78M-row set) instead of a 5.78M-row sequential scan
   * (247 ms, 122,883 buffers). What remains is floor-limited and was measured
   * rather than assumed: ~2.6 s to match the cohort against `tracked_posts`,
   * and ~6.5 s for the INSERT's 167k conflict checks. An anti-join
   * (`LEFT JOIN analytics.jobs … WHERE existing IS NULL OR existing.priority <
   * target`) was tried to skip those checks and is *worse* — the planner
   * materializes all 5.8M job rows into a hash (6.4 s) to save lookups it never
   * actually skips. Bounding the cohort with a watermark was rejected outright:
   * see migration 027's header for why it can silently drop a launch replay.
   */
  async ensureReplayJobs(replaySince: DatetimeString | null): Promise<ReplayEnsureResult> {
    const result = await this.pool.query<{ cohort: number; affected: number }>(
      `WITH recent AS MATERIALIZED (
         SELECT uri
         FROM analytics.posts
         WHERE $1::timestamptz IS NOT NULL AND created_at > $1
       ),
       payloads AS MATERIALIZED (
         SELECT
           'post.metrics'::text AS kind,
           tracked.uri AS subject,
           jsonb_strip_nulls(jsonb_build_object(
             'uri', tracked.uri,
             'explicit', (tracked.reason = 'explicit'),
             'unchangedRuns', 0,
             'accountDid', tracked.account_did
           )) AS payload,
           'post.metrics:' || tracked.uri AS dedupe_key,
           CASE WHEN tracked.reason = 'explicit' THEN ${EXPLICIT_POST_METRICS_PRIORITY}
                ELSE ${ACCOUNT_POST_METRICS_PRIORITY} END AS priority
         FROM analytics.tracked_posts tracked
         LEFT JOIN recent ON recent.uri = tracked.uri
         WHERE tracked.enabled
           AND (tracked.reason = 'explicit' OR recent.uri IS NOT NULL)
         ORDER BY tracked.uri
       ),
       written AS (
         INSERT INTO analytics.jobs (kind, subject, payload, dedupe_key, priority, due_at)
         SELECT kind, subject, payload, dedupe_key, priority, now()
         FROM payloads
         ON CONFLICT (dedupe_key) DO UPDATE SET
           priority = EXCLUDED.priority,
           updated_at = now()
         WHERE analytics.jobs.priority < EXCLUDED.priority
         RETURNING dedupe_key
       )
       SELECT
         (SELECT count(*)::int FROM payloads) AS cohort,
         (SELECT count(*)::int FROM written) AS affected`,
      [replaySince],
    );
    return result.rows[0] ?? { cohort: 0, affected: 0 };
  }

  async audienceWatchDids(perTarget: number, globalCap: number): Promise<DidString[]> {
    // Per subscriber, rank engagers by recency and keep the top `perTarget`; then
    // dedupe across subscribers and globally cap at `globalCap`, most-recent
    // first. `last_seen_at` is bumped every time a scan re-observes the engager,
    // so the cohort naturally rotates toward whoever is currently engaging.
    const result = await this.pool.query<{ did: DidString }>(
      `WITH ranked AS (
         SELECT
           member.actor_did,
           member.last_seen_at,
           row_number() OVER (
             PARTITION BY member.target_did
             ORDER BY member.last_seen_at DESC, member.actor_did
           ) AS rk
         FROM analytics.audience_members member
         JOIN analytics.tracked_accounts account
           ON account.did = member.target_did AND account.enabled AND account.audience_enabled
         WHERE member.is_engager
       )
       SELECT actor_did AS did
       FROM ranked
       WHERE rk <= $1
       GROUP BY actor_did
       ORDER BY max(last_seen_at) DESC, actor_did
       LIMIT $2`,
      [perTarget, globalCap],
    );
    return result.rows.map((row) => row.did);
  }

  async postsForAudienceScan(
    did: DidString,
    topLimit: number,
    recentLimit: number,
  ): Promise<DuePost[]> {
    // Union of two bounded pools over the same engaged-post set: the top
    // `topLimit` by all-time interactions (evergreen audience) and the newest
    // `recentLimit` posts (current audience). Both windows require interactions > 0
    // so an empty just-posted post never fills a recency slot or burns an engager
    // read. A post in both pools is one row — the union is naturally deduped.
    //
    // Exclude posts already known gone: at the post level `tracked_posts.enabled`
    // is flipped false only when a post is confirmed deleted/unavailable (a
    // Jetstream delete, a never-indexed launch give-up, or the maintenance
    // miss-threshold) — never by an operator action — so it is the standing "this
    // post is gone" mark. Without this filter the recency window kept re-selecting
    // deleted posts, and every scan wasted engager reads on them (and hit the
    // AppView's buggy deleted-post path — getRepostedBy 500s). LEFT JOIN + `IS NOT
    // FALSE` is defensive: a post with no tracking row (shouldn't happen — upsert
    // writes it before metrics) is kept, only an explicit `enabled = false` drops.
    const result = await this.pool.query<{ uri: string; created_at: Date }>(
      `WITH engaged AS (
         SELECT metrics.uri, post.created_at, metrics.interactions,
                row_number() OVER (ORDER BY metrics.interactions DESC, metrics.uri) AS by_interactions,
                row_number() OVER (ORDER BY post.created_at DESC, metrics.uri) AS by_recency
         FROM analytics.post_current_metrics metrics
         JOIN analytics.posts post ON post.uri = metrics.uri
         LEFT JOIN analytics.tracked_posts tracked ON tracked.uri = metrics.uri
         WHERE metrics.account_did = $1 AND metrics.interactions > 0
           AND tracked.enabled IS NOT FALSE
       )
       SELECT uri, created_at
       FROM engaged
       WHERE by_interactions <= $2 OR by_recency <= $3
       ORDER BY interactions DESC, uri`,
      [did, topLimit, recentLimit],
    );
    return result.rows.map((row) => ({
      uri: row.uri,
      createdAt: asDatetimeString(row.created_at.toISOString()),
    }));
  }

  async enqueue(
    kind: JobKind,
    subject: string,
    dueAt: Date,
    payload: Record<string, unknown> = {},
    priority = 50,
  ): Promise<void> {
    const dedupeKey = `${kind}:${subject}`;
    await this.pool.query(
      `INSERT INTO analytics.jobs (kind, subject, payload, dedupe_key, priority, due_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (dedupe_key) DO UPDATE SET
         payload = EXCLUDED.payload,
         priority = GREATEST(analytics.jobs.priority, EXCLUDED.priority),
         due_at = LEAST(analytics.jobs.due_at, EXCLUDED.due_at),
         updated_at = now()`,
      [kind, subject, payload, dedupeKey, priority, dueAt],
    );
  }

  async ensureJob(
    kind: JobKind,
    subject: string,
    dueAt: Date,
    payload: Record<string, unknown> = {},
    priority = DEFAULT_JOB_PRIORITY,
  ): Promise<void> {
    await this.ensureJobs([{ kind, subject, dueAt, payload, priority }]);
  }

  /**
   * Ensure many standing jobs in one statement per batch.
   *
   * `ensureJob` is one `INSERT … ON CONFLICT` per call — fine for a handful of
   * jobs, pathological for a cohort. Bootstrap re-ensures one job per tracked
   * post, ~165k on production, and at ~2.6 ms of round-trip latency each that is
   * seven minutes of the worker sitting in its own startup: not collecting, and
   * with its dashboard (which the deploy's readiness probe asks) not yet
   * listening. Every one of those statements was a no-op, because the jobs
   * already existed at the right priority (workspace 2026-09-15).
   */
  async ensureJobs(entries: EnsureJobInput[]): Promise<void> {
    if (entries.length === 0) return;
    // `ON CONFLICT` cannot touch the same row twice in one statement, and the
    // sequential form resolves a duplicate by "highest priority wins"
    // (`WHERE analytics.jobs.priority < EXCLUDED.priority`), so collapse each
    // batch's duplicates the same way before sending it.
    const byKey = new Map<string, EnsureJobInput & { dedupeKey: string; priority: number }>();
    for (const entry of entries) {
      const dedupeKey = `${entry.kind}:${entry.subject}`;
      const priority = entry.priority ?? DEFAULT_JOB_PRIORITY;
      const existing = byKey.get(dedupeKey);
      if (existing && existing.priority >= priority) continue;
      byKey.set(dedupeKey, { ...entry, priority, dedupeKey });
    }
    const rows = [...byKey.values()];
    for (let start = 0; start < rows.length; start += ENSURE_JOB_BATCH) {
      const batch = rows.slice(start, start + ENSURE_JOB_BATCH).map((entry) => ({
        kind: entry.kind,
        subject: entry.subject,
        payload: entry.payload ?? {},
        dedupe_key: entry.dedupeKey,
        priority: entry.priority,
        due_at: entry.dueAt.toISOString(),
      }));
      await this.pool.query(
        `INSERT INTO analytics.jobs (kind, subject, payload, dedupe_key, priority, due_at)
         SELECT batch.kind, batch.subject, batch.payload, batch.dedupe_key, batch.priority, batch.due_at
         FROM jsonb_to_recordset($1::jsonb) AS batch(
           kind text, subject text, payload jsonb, dedupe_key text, priority smallint, due_at timestamptz
         )
         ON CONFLICT (dedupe_key) DO UPDATE SET
           priority = EXCLUDED.priority,
           updated_at = now()
         WHERE analytics.jobs.priority < EXCLUDED.priority`,
        [JSON.stringify(batch)],
      );
    }
  }

  async claimJobs(workerId: string, limit: number, leaseSeconds: number): Promise<Job[]> {
    const result = await this.pool.query<{
      id: string;
      kind: JobKind;
      subject: string;
      payload: Record<string, unknown>;
      attempts: number;
    }>(
      `WITH due AS (
         SELECT id FROM analytics.jobs
         WHERE due_at <= now()
           AND (leased_by IS NULL OR lease_expires_at < now())
         ORDER BY priority DESC, due_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       )
       UPDATE analytics.jobs jobs
       SET leased_by = $1,
           lease_expires_at = now() + ($3 * interval '1 second'),
           updated_at = now()
       FROM due
       WHERE jobs.id = due.id
       RETURNING jobs.id, jobs.kind, jobs.subject, jobs.payload, jobs.attempts`,
      [workerId, limit, leaseSeconds],
    );
    return result.rows;
  }

  async completeJob(id: string): Promise<void> {
    await this.pool.query("DELETE FROM analytics.jobs WHERE id = $1", [id]);
  }

  async rescheduleJob(id: string, dueAt: Date, payload: Record<string, unknown> = {}): Promise<void> {
    await this.pool.query(
      `UPDATE analytics.jobs
       SET payload = $3,
           due_at = $2,
           leased_by = NULL,
           lease_expires_at = NULL,
           attempts = 0,
           last_error = NULL,
           updated_at = now()
       WHERE id = $1`,
      [id, dueAt, payload],
    );
  }

  async failJob(id: string, error: unknown, retryAt: Date): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.pool.query(
      `UPDATE analytics.jobs
       SET attempts = attempts + 1,
           leased_by = NULL,
           lease_expires_at = NULL,
           due_at = $2,
           last_error = left($3, 2000),
           updated_at = now()
       WHERE id = $1`,
      [id, retryAt, message],
    );
  }

  async outbox(limit: number): Promise<OutboxEvent[]> {
    const result = await this.pool.query<{
      id: string;
      event_type: string;
      aggregate_id: string;
      payload: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT id, event_type, aggregate_id, payload, created_at
       FROM analytics.sync_outbox
       WHERE delivered_at IS NULL
       ORDER BY id
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      aggregateId: row.aggregate_id,
      payload: row.payload,
      createdAt: asDatetimeString(row.created_at.toISOString()),
    }));
  }

  async markOutboxDelivered(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.pool.query(
      "UPDATE analytics.sync_outbox SET delivered_at = now() WHERE id = ANY($1::bigint[])",
      [ids],
    );
  }

  async loadStreamCursor(stream: string): Promise<number | undefined> {
    const result = await this.pool.query<{ cursor: string }>(
      "SELECT cursor FROM analytics.stream_cursors WHERE stream = $1",
      [stream],
    );
    // bigint arrives as a string; time_us (~1.7e15 µs) is well under
    // Number.MAX_SAFE_INTEGER (9e15), so Number() is lossless for centuries.
    const raw = result.rows[0]?.cursor;
    return raw === undefined ? undefined : Number(raw);
  }

  async saveStreamCursor(stream: string, cursor: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO analytics.stream_cursors (stream, cursor, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (stream) DO UPDATE SET
         cursor = GREATEST(analytics.stream_cursors.cursor, EXCLUDED.cursor),
         updated_at = now()`,
      [stream, cursor],
    );
  }

  private async appendOutbox(
    client: PoolClient,
    eventType: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.syncEnabled) return;
    await client.query(
      `INSERT INTO analytics.sync_outbox (event_type, aggregate_id, payload)
       VALUES ($1, $2, $3)`,
      [eventType, aggregateId, payload],
    );
  }

  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await fn(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

/**
 * Publish account engagement totals from the current-metrics table.
 *
 * The old query summed the latest `post_metric_samples` row with a
 * `sampled_at <= profile_sampled_at` cutoff. In a multi-page baseline every
 * page is sampled after the profile, so most posts were excluded and the total
 * came out roughly half the real value even though the backfill was marked
 * complete (design note). Summing `post_current_metrics` for the account's
 * enabled tracked posts has no cutoff, so a completed baseline's total equals
 * the sum of the posts it observed by construction. `sampleFilter` selects
 * which account sample row receives the total (a specific `sampled_at`, or the
 * newest for maintenance/recent refreshes).
 */
function accountTotalsSql(sampleFilter: string): string {
  return `WITH totals AS (
      SELECT
        COALESCE(sum(metrics.likes), 0) AS likes,
        COALESCE(sum(metrics.replies), 0) AS replies,
        COALESCE(sum(metrics.quotes), 0) AS quotes,
        COALESCE(sum(metrics.reposts), 0) AS reposts
      FROM analytics.tracked_posts tracked
      JOIN analytics.post_current_metrics metrics ON metrics.uri = tracked.uri
      WHERE tracked.account_did = $1 AND tracked.enabled
    )
    UPDATE analytics.account_metric_samples account
    SET likes = totals.likes,
        replies = totals.replies,
        quotes = totals.quotes,
        reposts = totals.reposts
    FROM totals
    WHERE account.did = $1 AND ${sampleFilter}`;
}

/**
 * Collapse engagements to one per `edge_key`, last write winning. A single
 * `INSERT ... ON CONFLICT (edge_key) DO UPDATE` throws if the same conflict key
 * appears twice in the batch; a bounded audience scan accumulates engagers across
 * many posts, and AppView pagination can surface one actor twice, so the batch
 * must be deduped before it reaches Postgres.
 */
export function dedupeEngagements(engagements: Engagement[]): Engagement[] {
  const byKey = new Map<string, Engagement>();
  for (const edge of engagements) byKey.set(engagementEdgeKey(edge), edge);
  return [...byKey.values()];
}

export function engagementEdgeKey(edge: Engagement): string {
  if ((edge.kind === "reply" || edge.kind === "quote") && edge.recordUri) {
    return `record:${edge.recordUri}`;
  }
  return `actor:${edge.postUri}\u001f${edge.actorDid}\u001f${edge.kind}`;
}
