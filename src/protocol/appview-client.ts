import {
  Client,
  XrpcInvalidResponseError,
  XrpcResponseValidationError,
  type AtIdentifierString,
  type AtUriString,
  type DidString,
  type XrpcFailure,
} from "@atproto/lex";
import type {
  AccountProfile,
  AudienceCandidate,
  Engagement,
  PostMetrics,
} from "../domain/types.js";
import { app } from "../lexicons/index.js";
import { sanitizeAppviewResponse } from "./appview-response-sanitizer.js";

export type Page<T> = { items: T[]; cursor?: string };

export interface ProtocolReader {
  profiles(dids: DidString[], signal?: AbortSignal): Promise<AccountProfile[]>;
  authorPosts(actor: DidString, cursor?: string, signal?: AbortSignal): Promise<Page<PostMetrics>>;
  posts(uris: AtUriString[], signal?: AbortSignal): Promise<PostMetrics[]>;
  followers(actor: AtIdentifierString, cursor?: string, signal?: AbortSignal): Promise<Page<AudienceCandidate>>;
  followerRelationships(
    actor: AtIdentifierString,
    others: DidString[],
    signal?: AbortSignal,
  ): Promise<Map<string, boolean>>;
  likes(uri: AtUriString, cursor?: string, signal?: AbortSignal): Promise<Page<Engagement>>;
  reposts(uri: AtUriString, cursor?: string, signal?: AbortSignal): Promise<Page<Engagement>>;
  quotes(uri: AtUriString, cursor?: string, signal?: AbortSignal): Promise<Page<Engagement>>;
  replies(uri: AtUriString, signal?: AbortSignal): Promise<Engagement[]>;
}

export class AppviewClient implements ProtocolReader {
  readonly client: Client;

  constructor(serviceUrl: string, fetch: typeof globalThis.fetch = globalThis.fetch) {
    // Response validation stays on: the sanitizer only trims embed alt text the
    // worker never reads (an oversized one makes the AppView's own output fail
    // the pinned lexicon and wedge the whole author-feed page), so everything
    // else is still validated exactly as before.
    this.client = new Client({ service: serviceUrl, fetch: sanitizeAppviewResponse(fetch) }, {
      validateResponse: true,
      strictResponseProcessing: false,
    });
  }

  async profiles(dids: DidString[], signal?: AbortSignal): Promise<AccountProfile[]> {
    const profiles: AccountProfile[] = [];
    for (let start = 0; start < dids.length; start += 25) {
      const actors = dids.slice(start, start + 25);
      const body = await this.client.call(
        app.bsky.actor.getProfiles,
        { actors },
        requestOptions(signal),
      );
      profiles.push(...body.profiles.map(toAccountProfile));
    }
    return profiles;
  }

  async authorPosts(actor: DidString, cursor?: string, signal?: AbortSignal): Promise<Page<PostMetrics>> {
    const params: app.bsky.feed.getAuthorFeed.$Params = {
      actor,
      limit: 100,
      filter: "posts_with_replies",
      includePins: false,
    };
    if (cursor) params.cursor = cursor;
    const body = await this.client.call(
      app.bsky.feed.getAuthorFeed,
      params,
      requestOptions(signal),
    );
    const items = body.feed
      .map((item) => item.post)
      .filter((post) => post.author.did === actor)
      .map(toPostMetrics);
    return body.cursor ? { items, cursor: body.cursor } : { items };
  }

  async posts(uris: AtUriString[], signal?: AbortSignal): Promise<PostMetrics[]> {
    const posts: PostMetrics[] = [];
    for (let start = 0; start < uris.length; start += 25) {
      const body = await this.client.call(
        app.bsky.feed.getPosts,
        { uris: uris.slice(start, start + 25) },
        requestOptions(signal),
      );
      posts.push(...body.posts.map(toPostMetrics));
    }
    return posts;
  }

  async followers(
    actor: AtIdentifierString,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<Page<AudienceCandidate>> {
    const params: app.bsky.graph.getFollowers.$Params = { actor, limit: 100, sort: "latest" };
    if (cursor) params.cursor = cursor;
    const body = await this.client.call(
      app.bsky.graph.getFollowers,
      params,
      requestOptions(signal),
    );
    const items = body.followers.map((profile) => ({
      did: profile.did,
      handle: profile.handle,
      ...(profile.displayName ? { displayName: stripNul(profile.displayName) } : {}),
      ...(profile.avatar ? { avatar: profile.avatar } : {}),
    }));
    return body.cursor ? { items, cursor: body.cursor } : { items };
  }

  async followerRelationships(
    actor: AtIdentifierString,
    others: DidString[],
    signal?: AbortSignal,
  ): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();
    for (let start = 0; start < others.length; start += 30) {
      const body = await this.client.call(
        app.bsky.graph.getRelationships,
        { actor, others: others.slice(start, start + 30) },
        requestOptions(signal),
      );
      for (const relationship of body.relationships) {
        if (!app.bsky.graph.defs.relationship.$isTypeOf(relationship)) continue;
        result.set(relationship.did, relationship.followedBy !== undefined);
      }
    }
    return result;
  }

  async likes(
    uri: AtUriString,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<Page<Engagement>> {
    const params: app.bsky.feed.getLikes.$Params = { uri, limit: 100 };
    if (cursor) params.cursor = cursor;
    const body = await this.client.call(app.bsky.feed.getLikes, params, requestOptions(signal));
    const items = body.likes.map((like) => ({
      postUri: uri,
      actorDid: like.actor.did,
      kind: "like" as const,
      occurredAt: like.createdAt,
    }));
    return body.cursor ? { items, cursor: body.cursor } : { items };
  }

  async reposts(
    uri: AtUriString,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<Page<Engagement>> {
    const params: app.bsky.feed.getRepostedBy.$Params = { uri, limit: 100 };
    if (cursor) params.cursor = cursor;
    const body = await this.client.call(app.bsky.feed.getRepostedBy, params, requestOptions(signal));
    const items = body.repostedBy.map((actor) => ({
      postUri: uri,
      actorDid: actor.did,
      kind: "repost" as const,
    }));
    return body.cursor ? { items, cursor: body.cursor } : { items };
  }

  async quotes(
    uri: AtUriString,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<Page<Engagement>> {
    const params: app.bsky.feed.getQuotes.$Params = { uri, limit: 100 };
    if (cursor) params.cursor = cursor;
    const body = await this.client.call(app.bsky.feed.getQuotes, params, requestOptions(signal));
    const items = body.posts.map((post) => ({
      postUri: uri,
      actorDid: post.author.did,
      kind: "quote" as const,
      recordUri: post.uri,
      occurredAt: postCreatedAt(post),
    }));
    return body.cursor ? { items, cursor: body.cursor } : { items };
  }

  async replies(uri: AtUriString, signal?: AbortSignal): Promise<Engagement[]> {
    const body = await this.client.call(
      app.bsky.feed.getPostThread,
      { uri, depth: 100, parentHeight: 0 },
      requestOptions(signal),
    );
    if (!app.bsky.feed.defs.threadViewPost.$isTypeOf(body.thread)) return [];
    const output: Engagement[] = [];
    const visit = (node: app.bsky.feed.defs.ThreadViewPost): void => {
      for (const reply of node.replies ?? []) {
        if (!app.bsky.feed.defs.threadViewPost.$isTypeOf(reply)) continue;
        output.push({
          postUri: uri,
          actorDid: reply.post.author.did,
          kind: "reply",
          recordUri: reply.post.uri,
          occurredAt: postCreatedAt(reply.post),
        });
        visit(reply);
      }
    };
    visit(body.thread);
    return output;
  }
}

function requestOptions(signal?: AbortSignal) {
  return {
    ...(signal ? { signal } : {}),
    maxRetries: 3,
    // The default predicate retries fetch failures and retryable HTTP statuses,
    // but a connection that dies while reading a successful response body is
    // surfaced as XrpcInvalidResponseError(status=200). Retry that transport
    // failure here so one truncated author-feed page does not fall through to
    // the durable job queue's minute-scale backoff and visibly pause onboarding.
    retry: (failure: XrpcFailure) =>
      failure.shouldRetry() || isTransientResponseReadFailure(failure),
  };
}

export function isTransientResponseReadFailure(failure: XrpcFailure): boolean {
  return failure instanceof XrpcInvalidResponseError &&
    !(failure instanceof XrpcResponseValidationError) &&
    failure.message.startsWith("Unable to parse response payload") &&
    failure.cause instanceof TypeError;
}

/**
 * Postgres `text` columns cannot store a NUL byte (U+0000): the insert fails with
 * `invalid byte sequence for encoding "UTF8": 0x00` and takes the whole statement
 * — and, in the baseline loop, the page's cursor — with it, wedging any account
 * whose feed contained a single NUL-bearing post (workspace: the worker stalled a
 * handful of accounts in `collecting` for days). NUL carries no meaning in a
 * Bluesky post's text or an actor's display name — it is a paste/junk artifact —
 * so strip it at the protocol boundary before it can reach a column. See
 * docs/lessons.md.
 */
const NUL = String.fromCharCode(0);
export function stripNul(value: string): string {
  return value.includes(NUL) ? value.split(NUL).join("") : value;
}

function toAccountProfile(profile: app.bsky.actor.defs.ProfileViewDetailed): AccountProfile {
  return {
    did: profile.did,
    handle: profile.handle,
    followers: profile.followersCount ?? 0,
    following: profile.followsCount ?? 0,
    posts: profile.postsCount ?? 0,
    ...(profile.displayName ? { displayName: stripNul(profile.displayName) } : {}),
    ...(profile.avatar ? { avatar: profile.avatar } : {}),
    ...(profile.createdAt ? { createdAt: profile.createdAt } : {}),
    ...(profile.indexedAt ? { indexedAt: profile.indexedAt } : {}),
  };
}

function postRecord(post: app.bsky.feed.defs.PostView) {
  const result = app.bsky.feed.post.$safeValidate(post.record, { strict: false });
  if (!result.success) {
    throw new Error(`Invalid post record returned for ${post.uri}`, { cause: result.reason });
  }
  return result.value;
}

function postCreatedAt(post: app.bsky.feed.defs.PostView) {
  return postRecord(post).createdAt;
}

export function toPostMetrics(post: app.bsky.feed.defs.PostView): PostMetrics {
  const record = postRecord(post);
  return {
    uri: post.uri,
    cid: post.cid,
    authorDid: post.author.did,
    createdAt: record.createdAt,
    indexedAt: post.indexedAt,
    text: stripNul(record.text),
    isReply: record.reply !== undefined,
    hasEmbed: record.embed !== undefined,
    likes: post.likeCount ?? 0,
    replies: post.replyCount ?? 0,
    quotes: post.quoteCount ?? 0,
    reposts: post.repostCount ?? 0,
  };
}
