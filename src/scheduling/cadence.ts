export type PostCadenceInput = {
  createdAt: Date;
  now: Date;
  unchangedRuns: number;
  explicit: boolean;
};

/**
 * Dense post-replay cadence: how long until a live-tracked post's metrics are
 * sampled again. Front-loaded so a launch is captured at high resolution and
 * decays to daily as the post settles — ~30s for the first 15m, then 2m, 10m,
 * 30m, 6h, and daily. `unchangedRuns` stretches the interval for a post that has
 * stopped moving, so a quiet post backs off faster than a busy one (capped at a
 * day). Account (launch-tracked) posts ride this until `postReplayComplete`,
 * then graduate to the batched `posts.maintenance` cold rotation; explicit
 * operator posts keep sampling at the daily floor.
 */
export function nextPostPollDelayMs(input: PostCadenceInput): number {
  const age = Math.max(0, input.now.getTime() - input.createdAt.getTime());
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  let base: number;
  if (age < 15 * minute) base = 30_000;
  else if (age < hour) base = 2 * minute;
  else if (age < 6 * hour) base = 10 * minute;
  else if (age < day) base = 30 * minute;
  else if (age < 7 * day) base = 6 * hour;
  else base = day;

  const backoff = Math.min(4, 1 + Math.floor(Math.max(0, input.unchangedRuns) / 3));
  return Math.min(day, base * backoff);
}

/**
 * How long a launch-tracked (account) post stays on the dense `post.metrics`
 * replay job before graduating to the batched `posts.maintenance` cold rotation.
 * 30 days keeps the standing per-post replay jobs bounded to recent posts.
 * Explicit operator posts are never graduated — they keep sampling at the daily
 * floor of `nextPostPollDelayMs`.
 */
export const POST_REPLAY_WINDOW_MS = 30 * 24 * 60 * 60_000;

/**
 * Account-owned post replay stays ahead of the bounded audience scan for its
 * whole 30-day lifetime. These jobs are cheap, single-post reads; keeping one
 * stable priority also means a worker restart cannot silently demote the same
 * replay behind a long audience enumeration.
 */
export const ACCOUNT_POST_METRICS_PRIORITY = 75;

/**
 * An operator explicitly tracked this one post (`tracked_posts.reason =
 * 'explicit'`), so its replay outranks the account-wide replay cohort. Named
 * here beside the cohort priority it beats: the restart reconciliation now
 * builds these jobs in SQL, and the ordering must stay readable in one place
 * rather than as a literal inside a query string.
 */
export const EXPLICIT_POST_METRICS_PRIORITY = 90;

/**
 * Baseline history slices for a newly registered account.
 *
 * Deliberately BELOW `ACCOUNT_POST_METRICS_PRIORITY`. A baseline is historical
 * backfill with no deadline; a replay sample taken late is a permanently
 * degraded launch curve, because the dense early rise cannot be re-observed.
 * Onboarding a large batch at a higher priority than replay puts most of the
 * pool into history walks and starves every replay in production — which is what
 * 100 newly tracked accounts did on 2026-09-15 (7 of 8 slots on baselines,
 * post.metrics backlog 2 -> 1,765). The ordering is explicit here so it cannot
 * drift back.
 *
 * Above `posts.maintenance` (55) and `audience.followers` (50): an account
 * still onboarding is a worse state than a slightly later cold refresh, so a
 * baseline must not starve behind them.
 */
export const BASELINE_POSTS_PRIORITY = 65;

/**
 * Re-scans of an account's newest page — the cheap "what changed since the last
 * profile read" pass. Below replay (75) and above baseline (65).
 */
export const RECENT_POSTS_PRIORITY = 70;

/**
 * How long the dense replay waits before re-reading a just-launched post the
 * AppView has not indexed yet. Jetstream delivers the create the instant it hits
 * the firehose, but `getPosts` on the public AppView lags that by seconds — an
 * empty response is "not indexed yet", NOT "deleted". Retry on a short cadence
 * (the launch is still climbing) rather than disabling on the first empty read,
 * which is the mistake W40 fixed for cold maintenance but left in the launch path.
 */
export const LAUNCH_INDEX_RETRY_MS = 20_000;

/**
 * Max consecutive empty `getPosts` reads for a launch-tracked post before it is
 * treated as never-indexed / deleted and disabled. At {@link LAUNCH_INDEX_RETRY_MS}
 * that is ~15 minutes of grace — far past normal AppView propagation. A genuinely
 * deleted post still disables instantly via the Jetstream delete event; this
 * backstop only covers a post that never indexes at all.
 */
export const MAX_LAUNCH_INDEX_MISSES = 45;

/**
 * True once an account post has aged past the replay window and should hand off
 * from the dense replay job to batched maintenance. Explicit posts never
 * complete — the operator asked for them, so they keep sampling.
 */
export function postReplayComplete(createdAt: Date, now: Date, explicit: boolean): boolean {
  if (explicit) return false;
  return now.getTime() - createdAt.getTime() >= POST_REPLAY_WINDOW_MS;
}

export function nextEngagerScanDelayMs(createdAt: Date, now: Date): number {
  const age = Math.max(0, now.getTime() - createdAt.getTime());
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (age < 15 * minute) return minute;
  if (age < 2 * hour) return 5 * minute;
  if (age < day) return 15 * minute;
  if (age < 7 * day) return 2 * hour;
  if (age < 30 * day) return 12 * hour;
  return 7 * day;
}

export function engagerBackfillPriority(createdAt: Date, now: Date): number {
  const age = Math.max(0, now.getTime() - createdAt.getTime());
  const day = 24 * 60 * 60_000;
  if (age < 30 * day) return 65;
  if (age < 365 * day) return 40;
  return 25;
}

export function retryDelayMs(attempts: number): number {
  const minute = 60_000;
  return Math.min(6 * 60 * minute, minute * 2 ** Math.min(10, Math.max(0, attempts)));
}

/**
 * A retry delay with ±12.5% jitter, so a fleet of jobs that failed on the same
 * AppView outage does not retry in lockstep and hammer it on the same tick.
 * `retryDelayMs` stays the pure, asserted envelope; the jitter lives here.
 */
export function jitteredRetryDelayMs(attempts: number, random = Math.random): number {
  const base = retryDelayMs(attempts);
  return Math.round(base * (0.875 + random() * 0.25));
}

/**
 * When a tracked post's current metrics should next be refreshed by the bounded
 * batch maintenance path. Dopplersky is analytics for the person posting, so the
 * first hours after a post lands — when engagement climbs fastest and the author
 * is watching — get the densest sampling: ~15m, 1h, 3h, 6h, 12h, then daily out
 * to 1, 2, 7, and 30 days, then a 30-day cold rotation. This stays cheap because
 * every wake refreshes a whole account's due posts in one `getPosts` batch and a
 * wake with nothing due makes no AppView call at all. It is still coarser than
 * the 15s→6h `nextPostPollDelayMs` replay cadence, which belongs to the explicit
 * `post.metrics` workflow. The result is an absolute time so callers can store it
 * directly in `tracked_posts.next_poll_at`.
 */
export function nextMetricRefreshAt(createdAt: Date, now: Date): Date {
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const ageMs = Math.max(0, now.getTime() - createdAt.getTime());
  const rungs = [15 * minute, hour, 3 * hour, 6 * hour, 12 * hour, day, 2 * day, 7 * day, 30 * day];
  for (const target of rungs) {
    if (ageMs < target) return new Date(createdAt.getTime() + target);
  }
  return new Date(now.getTime() + 30 * day);
}
