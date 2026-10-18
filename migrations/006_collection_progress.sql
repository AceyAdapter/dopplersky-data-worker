-- Fast, side-effect-free subtotals for the active onboarding run. The API
-- aggregates only rows committed to one collection generation; final account
-- snapshots remain worker-published after the complete cursor walk.
CREATE INDEX IF NOT EXISTS post_current_metrics_collection_run_idx
  ON analytics.post_current_metrics (collection_run_id)
  WHERE collection_run_id IS NOT NULL;
