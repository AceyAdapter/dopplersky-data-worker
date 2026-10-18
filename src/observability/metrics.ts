import type { JobKind } from "../domain/types.js";

export type JobOutcome = "completed" | "rescheduled" | "failed" | "degraded";

type Bucket = {
  second: number;
  claimed: number;
  completed: number;
  rescheduled: number;
  failed: number;
  degraded: number;
  jobDurationMs: number[];
  appviewDurationMs: number[];
  appviewRequests: number;
  appviewErrors: number;
  appview429s: number;
};

type KindTotals = {
  claimed: number;
  completed: number;
  rescheduled: number;
  failed: number;
  degraded: number;
  active: number;
};

type EndpointTotals = {
  requests: number;
  errors: number;
  rateLimited: number;
  durationMs: number[];
};

export type RuntimeMetricsSnapshot = {
  workerId: string;
  startedAt: string;
  uptimeSeconds: number;
  concurrency: number;
  active: number;
  handledPerSecond: number;
  lastMinute: {
    claimed: number;
    completed: number;
    rescheduled: number;
    failed: number;
    degraded: number;
    appviewRequests: number;
    appviewErrors: number;
    appview429s: number;
    appviewP50Ms: number | null;
    appviewP95Ms: number | null;
    jobP95Ms: number | null;
  };
  jobsByKind: Array<KindTotals & { kind: JobKind }>;
  appviewByEndpoint: Array<{
    endpoint: string;
    requests: number;
    errors: number;
    rateLimited: number;
    p95Ms: number | null;
  }>;
  series: Array<{
    at: string;
    handled: number;
    failed: number;
    appviewRequests: number;
    appviewAverageMs: number | null;
  }>;
  recentErrors: Array<{ at: string; kind: JobKind; message: string; degraded: boolean }>;
};

const RETAIN_SECONDS = 5 * 60;
const SERIES_SECONDS = 2 * 60;

export class WorkerMetrics {
  private readonly startedAtMs: number;
  private readonly buckets = new Map<number, Bucket>();
  private readonly kinds = new Map<JobKind, KindTotals>();
  private readonly endpoints = new Map<number, Map<string, EndpointTotals>>();
  private readonly errors: RuntimeMetricsSnapshot["recentErrors"] = [];

  constructor(
    private readonly workerId: string,
    private readonly concurrency: number,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAtMs = now();
  }

  recordClaim(kind: JobKind): void {
    const totals = this.kind(kind);
    totals.claimed += 1;
    totals.active += 1;
    this.bucket().claimed += 1;
  }

  recordJob(
    kind: JobKind,
    outcome: JobOutcome,
    durationMs: number,
    error?: unknown,
  ): void {
    const totals = this.kind(kind);
    totals.active = Math.max(0, totals.active - 1);
    totals[outcome] += 1;

    const bucket = this.bucket();
    bucket[outcome] += 1;
    bucket.jobDurationMs.push(Math.max(0, durationMs));

    if (outcome === "failed" || outcome === "degraded") {
      this.errors.unshift({
        at: new Date(this.now()).toISOString(),
        kind,
        message: safeMessage(error),
        degraded: outcome === "degraded",
      });
      this.errors.splice(20);
    }
  }

  recordAppview(endpoint: string, durationMs: number, status?: number): void {
    const second = this.currentSecond();
    const bucket = this.bucket(second);
    bucket.appviewRequests += 1;
    bucket.appviewDurationMs.push(Math.max(0, durationMs));
    if (status === undefined || status >= 400) bucket.appviewErrors += 1;
    if (status === 429) bucket.appview429s += 1;

    let endpoints = this.endpoints.get(second);
    if (!endpoints) {
      endpoints = new Map();
      this.endpoints.set(second, endpoints);
    }
    const totals = endpoints.get(endpoint) ?? {
      requests: 0,
      errors: 0,
      rateLimited: 0,
      durationMs: [],
    };
    totals.requests += 1;
    totals.durationMs.push(Math.max(0, durationMs));
    if (status === undefined || status >= 400) totals.errors += 1;
    if (status === 429) totals.rateLimited += 1;
    endpoints.set(endpoint, totals);
    this.prune(second);
  }

  snapshot(): RuntimeMetricsSnapshot {
    const nowMs = this.now();
    const nowSecond = Math.floor(nowMs / 1_000);
    this.prune(nowSecond);

    const minute = this.window(nowSecond - 59, nowSecond);
    const handled = minute.reduce((sum, bucket) =>
      sum + bucket.completed + bucket.rescheduled + bucket.failed + bucket.degraded, 0);
    const appviewDurations = minute.flatMap((bucket) => bucket.appviewDurationMs);
    const jobDurations = minute.flatMap((bucket) => bucket.jobDurationMs);

    return {
      workerId: this.workerId,
      startedAt: new Date(this.startedAtMs).toISOString(),
      uptimeSeconds: Math.max(0, Math.floor((nowMs - this.startedAtMs) / 1_000)),
      concurrency: this.concurrency,
      active: [...this.kinds.values()].reduce((sum, totals) => sum + totals.active, 0),
      handledPerSecond: round(handled / 60, 2),
      lastMinute: {
        claimed: sum(minute, "claimed"),
        completed: sum(minute, "completed"),
        rescheduled: sum(minute, "rescheduled"),
        failed: sum(minute, "failed"),
        degraded: sum(minute, "degraded"),
        appviewRequests: sum(minute, "appviewRequests"),
        appviewErrors: sum(minute, "appviewErrors"),
        appview429s: sum(minute, "appview429s"),
        appviewP50Ms: percentile(appviewDurations, 0.5),
        appviewP95Ms: percentile(appviewDurations, 0.95),
        jobP95Ms: percentile(jobDurations, 0.95),
      },
      jobsByKind: [...this.kinds.entries()]
        .map(([kind, totals]) => ({ kind, ...totals }))
        .sort((a, b) => b.claimed - a.claimed || a.kind.localeCompare(b.kind)),
      appviewByEndpoint: this.endpointSnapshot(nowSecond),
      series: this.series(nowSecond),
      recentErrors: [...this.errors],
    };
  }

  private currentSecond(): number {
    return Math.floor(this.now() / 1_000);
  }

  private bucket(second = this.currentSecond()): Bucket {
    const existing = this.buckets.get(second);
    if (existing) return existing;
    const bucket: Bucket = {
      second,
      claimed: 0,
      completed: 0,
      rescheduled: 0,
      failed: 0,
      degraded: 0,
      jobDurationMs: [],
      appviewDurationMs: [],
      appviewRequests: 0,
      appviewErrors: 0,
      appview429s: 0,
    };
    this.buckets.set(second, bucket);
    this.prune(second);
    return bucket;
  }

  private kind(kind: JobKind): KindTotals {
    const totals = this.kinds.get(kind) ?? {
      claimed: 0,
      completed: 0,
      rescheduled: 0,
      failed: 0,
      degraded: 0,
      active: 0,
    };
    this.kinds.set(kind, totals);
    return totals;
  }

  private window(from: number, to: number): Bucket[] {
    const output: Bucket[] = [];
    for (let second = from; second <= to; second += 1) {
      const bucket = this.buckets.get(second);
      if (bucket) output.push(bucket);
    }
    return output;
  }

  private series(nowSecond: number): RuntimeMetricsSnapshot["series"] {
    const output: RuntimeMetricsSnapshot["series"] = [];
    for (let second = nowSecond - SERIES_SECONDS + 1; second <= nowSecond; second += 1) {
      const bucket = this.buckets.get(second);
      const duration = bucket?.appviewDurationMs ?? [];
      output.push({
        at: new Date(second * 1_000).toISOString(),
        handled: bucket
          ? bucket.completed + bucket.rescheduled + bucket.failed + bucket.degraded
          : 0,
        failed: bucket ? bucket.failed + bucket.degraded : 0,
        appviewRequests: bucket?.appviewRequests ?? 0,
        appviewAverageMs: duration.length > 0
          ? round(duration.reduce((total, value) => total + value, 0) / duration.length, 1)
          : null,
      });
    }
    return output;
  }

  private endpointSnapshot(nowSecond: number): RuntimeMetricsSnapshot["appviewByEndpoint"] {
    const output = new Map<string, EndpointTotals>();
    for (let second = nowSecond - 59; second <= nowSecond; second += 1) {
      for (const [endpoint, source] of this.endpoints.get(second) ?? []) {
        const target = output.get(endpoint) ?? {
          requests: 0,
          errors: 0,
          rateLimited: 0,
          durationMs: [],
        };
        target.requests += source.requests;
        target.errors += source.errors;
        target.rateLimited += source.rateLimited;
        target.durationMs.push(...source.durationMs);
        output.set(endpoint, target);
      }
    }
    return [...output.entries()]
      .map(([endpoint, totals]) => ({
        endpoint,
        requests: totals.requests,
        errors: totals.errors,
        rateLimited: totals.rateLimited,
        p95Ms: percentile(totals.durationMs, 0.95),
      }))
      .sort((a, b) => b.requests - a.requests || a.endpoint.localeCompare(b.endpoint));
  }

  private prune(nowSecond: number): void {
    const minimum = nowSecond - RETAIN_SECONDS;
    for (const second of this.buckets.keys()) {
      if (second < minimum) this.buckets.delete(second);
    }
    for (const second of this.endpoints.keys()) {
      if (second < minimum) this.endpoints.delete(second);
    }
  }
}

function sum<K extends keyof Pick<Bucket,
  "claimed" | "completed" | "rescheduled" | "failed" | "degraded" |
  "appviewRequests" | "appviewErrors" | "appview429s"
>>(buckets: Bucket[], key: K): number {
  return buckets.reduce((total, bucket) => total + bucket[key], 0);
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return round(sorted[index] ?? 0, 1);
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  return message.slice(0, 300);
}
