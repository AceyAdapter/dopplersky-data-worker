-- Persist each Jetstream subscription's cursor so a worker restart resumes from
-- where it left off, and Jetstream replays the gap, instead of subscribing live
-- and silently dropping every post published during a deploy/restart window.
--
-- Before this, the launch tracker's cursor lived only in process memory: a fresh
-- start (every deploy — the container is recreated) reconnected at "now" and
-- never saw a tracked author's post that landed while the worker was down, so
-- that post fell to the slow polling paths and got a late first snapshot
-- (workspace: post-launch capture must be resilient to restarts, not just to
-- in-lifetime reconnects, which already resume from the in-memory cursor).
--
-- `stream` names the subscription ('launch' today; the audience socket can adopt
-- the same table later). `cursor` is Jetstream's `time_us` — microseconds since
-- the epoch — which fits in bigint without loss. One row per stream; the worker
-- flushes it every few seconds and on shutdown. All analytics.*.
CREATE TABLE IF NOT EXISTS analytics.stream_cursors (
  stream text PRIMARY KEY,
  cursor bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
