import type { WorkerConfig } from "./config.js";
import { observePoolErrors } from "./db.js";
import { WorkerMetrics } from "./observability/metrics.js";
import { observedFetch } from "./observability/observed-fetch.js";
import { AppviewClient } from "./protocol/appview-client.js";
import { AudienceActivityConsumer } from "./protocol/audience-consumer.js";
import { JetstreamConsumer } from "./protocol/jetstream-consumer.js";
import { AccountCollector } from "./services/account-collector.js";
import { AudienceCollector } from "./services/audience-collector.js";
import { Orchestrator } from "./services/orchestrator.js";
import { PostCollector } from "./services/post-collector.js";
import { PostgresAnalyticsStore } from "./storage/postgres-store.js";
import { ApiSyncClient } from "./sync/api-sync.js";
import { NotificationsClient } from "./sync/notifications-client.js";

export function createRuntime(config: WorkerConfig) {
  const store = new PostgresAnalyticsStore(config.databaseUrl, config.syncEnabled);
  observePoolErrors(store.pool);
  const metrics = new WorkerMetrics(config.workerId, config.pollConcurrency);
  const protocol = new AppviewClient(config.appviewUrl, observedFetch(metrics));
  const jetstream = new JetstreamConsumer(config.jetstreamEndpoint, store);
  // Forward-only audience capture (v2): a bounded, rotating cohort of engagers
  // watched over Jetstream, no Tap and no repository backfill (design note).
  const audienceStream = new AudienceActivityConsumer(config.jetstreamEndpoint, store, {
    perTarget: config.audienceWatchPerTarget,
    globalCap: config.audienceWatchGlobalCap,
  });
  const accounts = new AccountCollector(protocol, store, config.postMaintenanceMissThreshold);
  const posts = new PostCollector(protocol, store);
  const audience = new AudienceCollector(
    protocol,
    store,
    config.followerSampleSize,
    config.followerFullScanLimit,
    config.engagerScanPageLimit,
    config.audienceHydrateLimit,
  );
  const sync = new ApiSyncClient(
    config.apiSyncUrl,
    config.apiSyncToken,
    config.workerId,
    store,
    config.syncBatchSize,
  );
  // The outbound half of the lifecycle email pass. The worker keeps the clock and
  // the API keeps the decision; see `sync/notifications-client.ts`.
  const notifications = new NotificationsClient(
    config.notificationsUrl,
    config.notificationsToken,
    config.workerId,
  );
  const orchestrator = new Orchestrator(store, accounts, posts, audience, sync, notifications, {
    workerId: config.workerId,
    concurrency: config.pollConcurrency,
    leaseSeconds: config.jobLeaseSeconds,
    maxJobAttempts: config.maxJobAttempts,
    maintenanceBatch: config.postMaintenanceBatch,
    maintenanceDrainMs: config.postMaintenanceDrainMs,
    profilePiggybackMinutes: config.profilePiggybackMinutes,
    followerRefreshHours: config.followerRefreshHours,
    audienceEnabled: config.audienceCollectionEnabled,
    audienceScanTopPosts: config.audienceScanTopPosts,
    audienceScanRecentPosts: config.audienceScanRecentPosts,
    audienceScanPagesPerPost: config.audienceScanPagesPerPost,
    postLaunchTrackingEnabled: config.postLaunchTrackingEnabled,
    syncEnabled: config.syncEnabled,
    notificationsEnabled: config.notificationsEnabled,
  }, metrics);
  return { store, protocol, jetstream, audienceStream, orchestrator, metrics };
}
