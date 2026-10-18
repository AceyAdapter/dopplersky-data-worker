import { type DidString } from "@atproto/lex";
import { describe, expect, it, vi } from "vitest";
import { AppviewClient, toPostMetrics } from "./appview-client.js";

const actor = "did:plc:ewvi7nxzyoun6zhxrhs64oiz" as DidString;

describe(AppviewClient, () => {
  it("extracts validated public post text and display context", () => {
    const metrics = toPostMetrics({
      uri: `at://${actor}/app.bsky.feed.post/3abc`,
      cid: "bafyreihphrndnt2cvnv3nk442f6kohdnpagk4xip74f2jn36uoal25vhta",
      author: { did: actor, handle: "alice.test" },
      record: {
        $type: "app.bsky.feed.post",
        text: "A real observed post",
        createdAt: "2026-08-27T12:00:00Z",
        embed: {
          $type: "app.bsky.embed.external",
          external: { uri: "https://example.com", title: "Example", description: "" },
        },
      },
      indexedAt: "2026-08-27T12:00:01Z",
      likeCount: 4,
      replyCount: 3,
      quoteCount: 2,
      repostCount: 1,
    } as Parameters<typeof toPostMetrics>[0]);
    expect(metrics).toMatchObject({
      text: "A real observed post", isReply: false, hasEmbed: true,
      likes: 4, replies: 3, quotes: 2, reposts: 1,
    });
  });

  it("strips NUL bytes from post text so a Postgres text insert cannot fail on 0x00", () => {
    // A real Bluesky post occasionally carries a literal NUL (U+0000) — a paste
    // artifact. Postgres text columns reject it (invalid byte sequence 0x00),
    // which failed the whole account.posts slice and wedged the account. Built
    // from fromCharCode(0) so this source file stays NUL-free.
    const nul = String.fromCharCode(0);
    const metrics = toPostMetrics({
      uri: `at://${actor}/app.bsky.feed.post/3nul`,
      cid: "bafyreihphrndnt2cvnv3nk442f6kohdnpagk4xip74f2jn36uoal25vhta",
      author: { did: actor, handle: "alice.test" },
      record: {
        $type: "app.bsky.feed.post",
        text: `before${nul}after`,
        createdAt: "2026-08-27T12:00:00Z",
      },
      indexedAt: "2026-08-27T12:00:01Z",
    } as Parameters<typeof toPostMetrics>[0]);
    expect(metrics.text).toBe("beforeafter");
    expect(metrics.text.includes(nul)).toBe(false);
  });

  it("retries a successful response whose body stream terminates mid-read", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(truncatedJsonResponse())
      .mockResolvedValueOnce(jsonResponse({ feed: [] }));
    const client = new AppviewClient("https://public.api.bsky.app", fetch);

    const page = await client.authorPosts(actor);

    expect(page).toEqual({ items: [] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry a complete response that fails schema validation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ feed: "not-an-array" }));
    const client = new AppviewClient("https://public.api.bsky.app", fetch);

    await expect(client.authorPosts(actor)).rejects.toThrow("Invalid response payload");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reads a page whose video alt text exceeds the pinned lexicon limit", async () => {
    // The AppView serves video alt text over `maxGraphemes: 1000`, which fails
    // the whole page against the pinned lexicons and wedged the durable
    // `account.posts` job in a permanent retry loop. The worker never reads
    // `alt`, so the boundary trims it rather than rejecting the page.
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        jsonResponse({
          feed: [{
            post: {
              uri: `at://${actor}/app.bsky.feed.post/3video`,
              cid: "bafyreihphrndnt2cvnv3nk442f6kohdnpagk4xip74f2jn36uoal25vhta",
              author: { did: actor, handle: "alice.test" },
              record: {
                $type: "app.bsky.feed.post",
                text: "video post",
                createdAt: "2026-09-15T13:22:00.000Z",
              },
              embed: {
                $type: "app.bsky.embed.video#view",
                cid: "bafyreihphrndnt2cvnv3nk442f6kohdnpagk4xip74f2jn36uoal25vhta",
                playlist: "https://video.bsky.app/watch/x/playlist.m3u8",
                thumbnail: "https://video.bsky.app/watch/x/thumbnail.jpg",
                alt: "y".repeat(1901),
              },
              indexedAt: "2026-09-15T13:23:00.000Z",
              likeCount: 7,
              replyCount: 0,
              quoteCount: 0,
              repostCount: 0,
            },
          }],
        }),
      );
      const client = new AppviewClient("https://public.api.bsky.app", fetch);

      const page = await client.authorPosts(actor);

      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.text).toBe("video post");
      expect(page.items[0]?.likes).toBe(7);
    } finally {
      warn.mockRestore();
    }
  });
});

function truncatedJsonResponse(): Response {
  const body = new ReadableStream({
    start(controller) {
      controller.error(new TypeError("terminated"));
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
