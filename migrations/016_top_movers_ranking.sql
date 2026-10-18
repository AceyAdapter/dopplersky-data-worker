-- Rank the fastest-rising posts ACROSS ALL tracked accounts — the homepage
-- "what's taking off right now" band (design note-adjacent; API `/posts/top_movers`).
--
-- Migration 011 gave every account its own virality ranking via a partial
-- `(account_did, peak DESC)` index. That index is keyed account-first, so it
-- cannot serve a query that orders by `peak_interactions_per_hour DESC` with NO
-- account equality — a cross-account leaderboard would fall back to a full scan
-- + sort of every scored post.
--
-- This adds the account-agnostic analog: the same partial predicate, but keyed
-- on peak alone, so the global ORDER BY reads straight down the index and stops
-- at the page. The homepage query additionally filters to recent, non-reply
-- posts (a created_at cutoff on analytics.posts and is_reply, both on the joined
-- row, not this index); with the small recency window and edge caching on the
-- read, filtering those per row off the top of this index is cheap. Only scored
-- posts are indexed, so unscored posts (no dense early series) never appear and
-- never read as a fabricated zero — identical honesty to migration 011. All
-- analytics.*; index-only, no column or data change.

CREATE INDEX IF NOT EXISTS post_current_metrics_peak_idx
  ON analytics.post_current_metrics (peak_interactions_per_hour DESC)
  WHERE peak_interactions_per_hour IS NOT NULL;
