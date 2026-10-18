import type { Pool } from "pg";

export type RisingPost = {
  uri: string;
  authorDid: string;
  handle: string | null;
  text: string | null;
  createdAt: string;
  latestSampleAt: string;
  observedMinutes: number;
  /** Saved, changed-only observations in this interval, including both endpoints. */
  sampleCount: number;
  interactions: number;
  gainedInteractions: number;
  interactionsPerHour: number;
  previousInteractionsPerHour: number | null;
  maxGapMinutes: number;
};

export type RisingPostsSnapshot = {
  /** Database transaction time, not the browser clock or a post's sample time. */
  sampledAt: string;
  queryDurationMs: number;
  windowMinutes: number;
  postAgeHours: number;
  freshnessMinutes: number;
  minSpanMinutes: number;
  previousMinCoverageRatio: number;
  /** Positive-growth intervals meeting every quality/scope filter, before top 30. */
  totalEligible: number;
  rows: RisingPost[];
};

const bounds = {
  windowMinutes: 60,
  postAgeHours: 48,
  freshnessMinutes: 15,
  minSpanMinutes: 10,
  previousMinCoverageRatio: 0.8,
} as const;

/**
 * Private operator read only; never put this on the dashboard's 2s SSE path.
 * The HTTP caller owns its 30s cache. No enrollment, sampling, or metric writes.
 *
 * A row is an enabled account's own enabled original post (is_reply=false;
 * unknown reply status is excluded). Both post age and all observations are
 * bounded by database time. Quotes are originals; another account's audience
 * cohort posts and standalone explicit tracking are not this account's posts.
 *
 * End at the latest genuine saved AppView observation within 15 minutes. Start
 * at the earliest such observation in the preceding 60 minutes, requiring at
 * least 10 minutes of measured time. This is a variable-span endpoint average,
 * NOT a first-24h average, instantaneous rate, or interpolated trailing hour.
 * Samples at/before created_at are excluded: seedLaunchPost stores a synthetic
 * zero origin with the SAME source='appview' as actual observations. A rare
 * genuine observation exactly at creation is conservatively excluded too.
 *
 * The series is changed-only: absent samples are neither zeros nor evidence of
 * continuous polling. sampleCount counts saved endpoints and maxGapMinutes
 * reports their largest gap; no gap is filled. A decrease in ANY individual
 * counter anywhere in the current interval excludes the row, even if another
 * counter rises or a reset later rebounds. This conservative policy sacrifices
 * coverage rather than ranking correction/recovery as growth. Negative raw
 * counters also invalidate an interval. Only strictly positive net gains rank.
 *
 * The previous interval ends at the current baseline. Its earliest observation
 * must lie within one current-span before that baseline and cover 80–100% of
 * that span, at least 10 minutes. No comparable endpoints or any counter drop /
 * invalid counter makes the comparison null; an observed, unchanged interval
 * may legitimately be zero. Both rates use their OWN actual elapsed time.
 *
 * Index path: each enabled account -> tracked_posts_account_metrics_idx's
 * bounded last-15m range -> posts PK -> post_metric_samples (uri,sampled_at) PK
 * in at most 135 minutes. OFFSET 0 preserves the account-parameterized access
 * path instead of flattening it into a scan of all tracked posts. Per-candidate
 * materialization/window work touches only that URI's bounded samples, never
 * the historical series. Existing cadence (30m after 6h, 6h after 24h, plus
 * backoff) means many <=48h posts correctly cannot qualify. This isn't a
 * comprehensive leaderboard or a claim of continuous 48h coverage.
 */
const risingPostsSql = `
WITH clock AS MATERIALIZED (SELECT now() AS sampled_at),
candidates AS MATERIALIZED (
  SELECT tracked.uri, account.did AS author_did, actor.handle, post.text, post.created_at
  FROM clock
  JOIN analytics.tracked_accounts account ON account.enabled
  CROSS JOIN LATERAL (
    SELECT tracked.uri, tracked.account_did
    FROM analytics.tracked_posts tracked
    WHERE tracked.account_did = account.did
      AND tracked.enabled AND tracked.reason = 'account'
      AND tracked.metrics_sampled_at >= clock.sampled_at - $2 * interval '1 minute'
      AND tracked.metrics_sampled_at <= clock.sampled_at
    OFFSET 0
  ) tracked
  JOIN analytics.posts post ON post.uri = tracked.uri AND post.author_did = tracked.account_did
  JOIN analytics.actors actor ON actor.did = account.did
  WHERE post.is_reply = false
    AND post.created_at >= clock.sampled_at - $1 * interval '1 hour'
    AND post.created_at <= clock.sampled_at
),
measured AS MATERIALIZED (
  SELECT candidate.*, measurement.*
  FROM candidates candidate CROSS JOIN clock
  CROSS JOIN LATERAL (
    WITH samples AS MATERIALIZED (
      SELECT sample.sampled_at,
        sample.likes::numeric AS likes, sample.replies::numeric AS replies,
        sample.quotes::numeric AS quotes, sample.reposts::numeric AS reposts,
        (sample.likes::numeric + sample.replies::numeric + sample.quotes::numeric + sample.reposts::numeric) AS interactions
      FROM analytics.post_metric_samples sample
      WHERE sample.uri = candidate.uri
        AND sample.sampled_at >= clock.sampled_at - ($3 * 2 + $2) * interval '1 minute'
        AND sample.sampled_at <= clock.sampled_at
        AND sample.sampled_at > candidate.created_at
        AND sample.source = 'appview'
      ORDER BY sample.sampled_at
    ),
    latest AS (
      SELECT * FROM samples
      WHERE sampled_at >= clock.sampled_at - $2 * interval '1 minute'
      ORDER BY sampled_at DESC LIMIT 1
    ),
    baseline AS (
      SELECT * FROM samples
      WHERE sampled_at >= (SELECT sampled_at FROM latest) - $3 * interval '1 minute'
      ORDER BY sampled_at ASC LIMIT 1
    ),
    previous AS (
      SELECT sample.* FROM samples sample CROSS JOIN baseline CROSS JOIN latest
      WHERE sample.sampled_at >= baseline.sampled_at - (latest.sampled_at - baseline.sampled_at)
        AND sample.sampled_at <= baseline.sampled_at - $4 * interval '1 minute'
        AND baseline.sampled_at - sample.sampled_at >= (latest.sampled_at - baseline.sampled_at) * $5
      ORDER BY sample.sampled_at ASC LIMIT 1
    ),
    steps AS (
      SELECT sampled_at,
        sampled_at - lag(sampled_at) OVER time AS gap,
        likes < lag(likes) OVER time OR replies < lag(replies) OVER time
          OR quotes < lag(quotes) OVER time OR reposts < lag(reposts) OVER time AS decreased,
        likes < 0 OR replies < 0 OR quotes < 0 OR reposts < 0 AS invalid_counter
      FROM samples WINDOW time AS (ORDER BY sampled_at)
    )
    SELECT latest.sampled_at AS latest_sample_at,
      extract(epoch FROM (latest.sampled_at - baseline.sampled_at)) / 60.0 AS observed_minutes,
      (SELECT count(*) FROM samples WHERE sampled_at >= baseline.sampled_at) AS sample_count,
      latest.interactions::text AS interactions,
      (latest.interactions - baseline.interactions)::text AS gained_interactions,
      (latest.interactions - baseline.interactions) * 3600.0
        / nullif(extract(epoch FROM (latest.sampled_at - baseline.sampled_at)), 0) AS interactions_per_hour,
      CASE WHEN previous.sampled_at IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM steps
        WHERE sampled_at >= previous.sampled_at AND sampled_at <= baseline.sampled_at
          AND (invalid_counter OR (sampled_at > previous.sampled_at AND decreased))
      ) THEN (baseline.interactions - previous.interactions) * 3600.0
        / nullif(extract(epoch FROM (baseline.sampled_at - previous.sampled_at)), 0)
      ELSE NULL END AS previous_interactions_per_hour,
      (SELECT max(extract(epoch FROM gap)) / 60.0 FROM steps
        WHERE sampled_at > baseline.sampled_at) AS max_gap_minutes
    FROM latest CROSS JOIN baseline LEFT JOIN previous ON true
    WHERE latest.sampled_at - baseline.sampled_at >= $4 * interval '1 minute'
      AND latest.interactions > baseline.interactions
      AND NOT EXISTS (
        SELECT 1 FROM steps WHERE sampled_at >= baseline.sampled_at
          AND (invalid_counter OR (sampled_at > baseline.sampled_at AND decreased))
      )
  ) measurement
),
ranked AS (
  SELECT measured.*, count(*) OVER () AS total_eligible
  FROM measured
  ORDER BY interactions_per_hour DESC, gained_interactions::numeric DESC,
    latest_sample_at DESC, uri COLLATE "C" ASC
  LIMIT $6
)
SELECT clock.sampled_at, ranked.* FROM clock LEFT JOIN ranked ON true
ORDER BY ranked.interactions_per_hour DESC, ranked.gained_interactions::numeric DESC,
  ranked.latest_sample_at DESC, ranked.uri COLLATE "C" ASC
`;

type Numeric = string | number;
type RawRow = {
  sampled_at: Date | string;
  uri: string | null;
  author_did: string;
  handle: string | null;
  text: string | null;
  created_at: Date | string;
  latest_sample_at: Date | string;
  observed_minutes: Numeric;
  sample_count: Numeric;
  interactions: Numeric;
  gained_interactions: Numeric;
  interactions_per_hour: Numeric;
  previous_interactions_per_hour: Numeric | null;
  max_gap_minutes: Numeric;
  total_eligible: Numeric | null;
};

/** One read-only transaction; the server-side timeout cannot leak to pool users. */
export async function readRisingPosts(pool: Pool): Promise<RisingPostsSnapshot> {
  const started = performance.now();
  const client = await pool.connect();
  let discardClient = false;
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await client.query<RawRow>(risingPostsSql, [
      bounds.postAgeHours, bounds.freshnessMinutes, bounds.windowMinutes,
      bounds.minSpanMinutes, bounds.previousMinCoverageRatio, 30,
    ]);
    const first = result.rows[0];
    if (!first) throw new Error("Rising posts query returned no snapshot");
    const rows: RisingPost[] = result.rows.filter((row) => row.uri !== null).map((row) => ({
      uri: row.uri!,
      authorDid: row.author_did,
      handle: row.handle,
      text: row.text,
      createdAt: timestamp(row.created_at),
      latestSampleAt: timestamp(row.latest_sample_at),
      observedMinutes: safeNumber(row.observed_minutes),
      sampleCount: safeInteger(row.sample_count),
      interactions: safeInteger(row.interactions),
      gainedInteractions: safeInteger(row.gained_interactions),
      interactionsPerHour: safeNumber(row.interactions_per_hour),
      previousInteractionsPerHour: row.previous_interactions_per_hour === null
        ? null : safeNumber(row.previous_interactions_per_hour),
      maxGapMinutes: safeNumber(row.max_gap_minutes),
    }));
    const sampledAt = timestamp(first.sampled_at);
    const totalEligible = first.uri === null ? 0 : safeInteger(first.total_eligible);
    await client.query("COMMIT");
    return { sampledAt, queryDurationMs: performance.now() - started, ...bounds, totalEligible, rows };
  } catch (error) {
    try { await client.query("ROLLBACK"); }
    catch { discardClient = true; } // Never return a client with uncertain transaction state.
    throw error;
  } finally {
    client.release(discardClient);
  }
}

function safeNumber(value: unknown): number {
  if ((typeof value !== "number" && typeof value !== "string") ||
      (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value))) {
    throw new Error("Rising posts query returned an invalid number");
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > Number.MAX_SAFE_INTEGER) {
    throw new Error("Rising posts query returned an unsafe number");
  }
  return number;
}

function safeInteger(value: unknown): number {
  const number = safeNumber(value);
  if (!Number.isSafeInteger(number) ||
      (typeof value === "string" && !/^\d+$/.test(value))) {
    throw new Error("Rising posts query returned an unsafe integer");
  }
  return number;
}

function timestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Rising posts query returned an invalid timestamp");
  return date.toISOString();
}
