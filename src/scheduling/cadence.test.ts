import { describe, expect, test } from "vitest";
import {
  POST_REPLAY_WINDOW_MS,
  engagerBackfillPriority,
  jitteredRetryDelayMs,
  nextEngagerScanDelayMs,
  nextMetricRefreshAt,
  nextPostPollDelayMs,
  postReplayComplete,
  retryDelayMs,
} from "./cadence.js";

describe(nextPostPollDelayMs, () => {
  const now = new Date("2026-08-25T12:00:00Z");
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  test.each([
    { note: "launch window (<15m)", ageMs: 5 * minute, expected: 30_000 },
    { note: "first hour (<1h)", ageMs: 30 * minute, expected: 2 * minute },
    { note: "first six hours (<6h)", ageMs: 3 * hour, expected: 10 * minute },
    { note: "first day (<24h)", ageMs: 12 * hour, expected: 30 * minute },
    { note: "first week (<7d)", ageMs: 3 * day, expected: 6 * hour },
    { note: "settled, daily floor", ageMs: 14 * day, expected: day },
    { note: "old post stays daily", ageMs: 60 * day, expected: day, explicit: false },
  ])("$note", ({ ageMs, expected, explicit = true }) => {
    expect(nextPostPollDelayMs({
      now,
      createdAt: new Date(now.getTime() - ageMs),
      unchangedRuns: 0,
      explicit,
    })).toBe(expected);
  });

  test("unchanged metrics back off up to 4x, capped at a day", () => {
    const createdAt = new Date(now.getTime() - 30 * minute); // 2m tier
    expect(nextPostPollDelayMs({ now, createdAt, unchangedRuns: 9, explicit: true })).toBe(4 * 2 * minute);
    expect(nextPostPollDelayMs({ now, createdAt, unchangedRuns: 99, explicit: true })).toBe(4 * 2 * minute);
    // A settled post on the daily tier cannot back off past a day.
    const old = new Date(now.getTime() - 20 * day);
    expect(nextPostPollDelayMs({ now, createdAt: old, unchangedRuns: 99, explicit: true })).toBe(day);
  });
});

describe(postReplayComplete, () => {
  const now = new Date("2026-08-25T12:00:00Z");

  test("account posts graduate once past the replay window; explicit never do", () => {
    const young = new Date(now.getTime() - POST_REPLAY_WINDOW_MS + 60_000);
    const old = new Date(now.getTime() - POST_REPLAY_WINDOW_MS - 60_000);
    expect(postReplayComplete(young, now, false)).toBe(false);
    expect(postReplayComplete(old, now, false)).toBe(true);
    expect(postReplayComplete(old, now, true)).toBe(false);
  });
});

describe(retryDelayMs, () => {
  test("uses bounded exponential retry delays", () => {
    expect(retryDelayMs(0)).toBe(60_000);
    expect(retryDelayMs(1)).toBe(120_000);
    expect(retryDelayMs(99)).toBe(6 * 3_600_000);
  });
});

describe(nextMetricRefreshAt, () => {
  const now = new Date("2026-08-25T12:00:00Z");
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  test("samples young posts densely, then targets 1d/2d/7d/30d and a cold rotation", () => {
    const at = (ageMs: number) =>
      nextMetricRefreshAt(new Date(now.getTime() - ageMs), now).getTime();
    // Just posted -> first refresh 15m after creation, while engagement is hottest.
    expect(at(0)).toBe(now.getTime() + 15 * minute);
    // 20m old -> creation + 1h.
    expect(at(20 * minute)).toBe(now.getTime() - 20 * minute + hour);
    // 90m old -> creation + 3h.
    expect(at(90 * minute)).toBe(now.getTime() - 90 * minute + 3 * hour);
    // 5h old -> creation + 6h.
    expect(at(5 * hour)).toBe(now.getTime() - 5 * hour + 6 * hour);
    // 8h old -> creation + 12h.
    expect(at(8 * hour)).toBe(now.getTime() - 8 * hour + 12 * hour);
    // 12h old -> next refresh at creation + 1 day (i.e. 12h from now).
    expect(at(0.5 * day)).toBe(now.getTime() - 0.5 * day + day);
    // 30h old -> creation + 2 days.
    expect(at(1.25 * day)).toBe(now.getTime() - 1.25 * day + 2 * day);
    // 40 days old -> cold rotation, 30 days from now.
    expect(at(40 * day)).toBe(now.getTime() + 30 * day);
  });
});

describe(jitteredRetryDelayMs, () => {
  test("stays within +/-12.5% of the pure retry delay", () => {
    const base = retryDelayMs(3);
    expect(jitteredRetryDelayMs(3, () => 0)).toBe(Math.round(base * 0.875));
    expect(jitteredRetryDelayMs(3, () => 1)).toBe(Math.round(base * 1.125));
    const mid = jitteredRetryDelayMs(3, () => 0.5);
    expect(mid).toBeGreaterThanOrEqual(Math.round(base * 0.875));
    expect(mid).toBeLessThanOrEqual(Math.round(base * 1.125));
  });
});

describe(nextEngagerScanDelayMs, () => {
  test("backs expensive enumeration off as the post ages", () => {
    const now = new Date("2026-08-25T12:00:00Z");
    expect(nextEngagerScanDelayMs(new Date("2026-08-25T11:50:00Z"), now)).toBe(60_000);
    expect(nextEngagerScanDelayMs(new Date("2026-08-24T11:00:00Z"), now)).toBe(2 * 60 * 60_000);
    expect(nextEngagerScanDelayMs(new Date("2026-07-01T00:00:00Z"), now)).toBe(7 * 24 * 60 * 60_000);
  });
});

describe(engagerBackfillPriority, () => {
  test.each([
    { note: "recent post", ageDays: 7, expected: 65 },
    { note: "older post", ageDays: 90, expected: 40 },
    { note: "archive post", ageDays: 800, expected: 25 },
  ])("$note", ({ ageDays, expected }) => {
    const now = new Date("2026-08-25T12:00:00Z");
    const createdAt = new Date(now.getTime() - ageDays * 24 * 60 * 60_000);
    expect(engagerBackfillPriority(createdAt, now)).toBe(expected);
  });
});
