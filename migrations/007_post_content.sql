-- Persist the small piece of the public post record needed by analytics views.
-- Metrics remain in post_current_metrics / post_metric_samples; this only
-- closes the display gap that previously forced the web UI to use sample copy.
ALTER TABLE analytics.posts
  ADD COLUMN IF NOT EXISTS text text;
ALTER TABLE analytics.posts
  ADD COLUMN IF NOT EXISTS is_reply boolean;
ALTER TABLE analytics.posts
  ADD COLUMN IF NOT EXISTS has_embed boolean;

