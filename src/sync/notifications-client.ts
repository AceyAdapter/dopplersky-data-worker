import { currentDatetimeString } from "@atproto/lex";

/**
 * The clock-side half of the lifecycle email pass.
 *
 * The worker does not send mail and does not read `auth.app_user` — reads of that
 * table belong to `dopplersky-api`, which also owns the SMTP configuration. What
 * the worker has is the one thing the API does not: a durable, restart-surviving
 * job queue. So the worker holds the hour and the API holds the decision, and this
 * is the wire between them.
 *
 * Unconfigured is silent, not broken: with no `NOTIFICATIONS_URL` this reports
 * `null` and the dispatch job no-ops, exactly like `ApiSyncClient` with no
 * `API_SYNC_URL`.
 */
export type NotificationDispatchSummary = {
  dryRun: boolean;
  scanned: number;
  sent: number;
  skipped: number;
  failed: number;
};

export class NotificationsClient {
  constructor(
    private readonly endpoint: string | undefined,
    private readonly token: string | undefined,
    private readonly workerId: string,
    /**
     * A pass does real SMTP work, so this is a slow request, but it is still
     * bounded: it must finish inside the job's lease or the next worker would
     * start a second pass while this one is still going. The job queue is what
     * retries, so failing fast beats hanging.
     */
    private readonly timeoutMs = 30_000,
  ) {}

  get enabled(): boolean {
    return this.endpoint !== undefined;
  }

  /**
   * Ask the API to run one pass. Returns null when notifications are
   * unconfigured; throws when the API answers anything but success, so the job
   * fails loudly and retries on the queue's own backoff.
   */
  async dispatch(signal?: AbortSignal): Promise<NotificationDispatchSummary | null> {
    if (!this.endpoint) return null;

    const headers = new Headers({ "content-type": "application/json" });
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ workerId: this.workerId, requestedAt: currentDatetimeString() }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Notification dispatch failed with HTTP ${response.status}`);
    }

    const body = (await response.json()) as {
      success?: boolean;
      data?: NotificationDispatchSummary;
    };
    return body.data ?? null;
  }
}
