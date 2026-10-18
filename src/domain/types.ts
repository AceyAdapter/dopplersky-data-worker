import type {
  AtUriString,
  CidString,
  DatetimeString,
  DidString,
  HandleString,
} from "@atproto/lex";

export type AccountProfile = {
  did: DidString;
  handle: HandleString;
  displayName?: string;
  avatar?: string;
  createdAt?: DatetimeString;
  indexedAt?: DatetimeString;
  followers: number;
  following: number;
  posts: number;
};

export type PostMetrics = {
  uri: AtUriString;
  cid: CidString;
  authorDid: DidString;
  createdAt: DatetimeString;
  indexedAt: DatetimeString;
  text: string;
  isReply: boolean;
  hasEmbed: boolean;
  likes: number;
  replies: number;
  quotes: number;
  reposts: number;
};

export type EngagementKind = "like" | "repost" | "reply" | "quote";
export type ActivityKind = EngagementKind | "post" | "follow";

export type Engagement = {
  postUri: AtUriString;
  actorDid: DidString;
  kind: EngagementKind;
  recordUri?: AtUriString;
  occurredAt?: DatetimeString;
};

export type ProtocolActivity = {
  recordUri: AtUriString;
  actorDid: DidString;
  collection: string;
  kind: ActivityKind;
  subjectUri?: AtUriString;
  subjectDid?: DidString;
  cid?: CidString;
  occurredAt: DatetimeString;
  active: boolean;
  live: boolean;
};

export type AudienceCandidate = {
  did: DidString;
  handle?: HandleString;
  displayName?: string;
  avatar?: string;
};

export type AudienceMember = AudienceCandidate & {
  targetDid: DidString;
  isFollower?: boolean;
  isEngager: boolean;
  inclusionProbability: number;
};

export const JOB_KINDS = [
  "account.profile",
  "account.posts",
  "posts.maintenance",
  "audience.followers",
  // Bounded engager discovery for one subscriber: read engagers of the account's
  // top-interaction recent posts (capped posts × capped pages), never one job per
  // post. Feeds the rotating live audience cohort. Replaces the W28 per-post
  // `post.engagers` fanout as the discovery path.
  "account.audience",
  "post.metrics",
  "post.engagers",
  "sync.flush",
  // One singleton job that asks `dopplersky-api` to run the lifecycle email pass
  // (trial ending, trial ended). The worker is only the clock: it holds the
  // durable timer, and the API holds the decision, because reads of
  // `auth.app_user` belong there. Self-rearming hourly.
  "notifications.dispatch",
] as const;

export type JobKind = (typeof JOB_KINDS)[number];

/**
 * The lifecycle of an account's post baseline, mirrored on
 * `tracked_accounts.baseline_state` and `collection_runs.state`. Monotonic
 * except for an explicit new collection generation. `degraded` means the
 * bounded retry budget was exhausted; it is a resting state, not a spin.
 */
export const COLLECTION_STATES = [
  "queued",
  "collecting",
  "ready",
  "degraded",
  "cancelled",
] as const;

export type CollectionState = (typeof COLLECTION_STATES)[number];

/** A resumable baseline run: the generation account totals are published from. */
export type BaselineRun = {
  id: number;
  cursor?: string;
  profileSampledAt?: DatetimeString;
};

export type Job = {
  id: string;
  kind: JobKind;
  subject: string;
  payload: Record<string, unknown>;
  attempts: number;
};

export type OutboxEvent = {
  id: string;
  eventType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  createdAt: DatetimeString;
};
