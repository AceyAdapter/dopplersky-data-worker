import { describe, expect, it, vi } from "vitest";
import {
  sanitizeAppviewResponse,
  truncateGraphemes,
} from "./appview-response-sanitizer.js";

const ACTOR = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
const POST_URI = `at://${ACTOR}/app.bsky.feed.post/3abc`;
// A valid CID: the response validator checks the blob reference shape.
const CID = "bafyreihphrndnt2cvnv3nk442f6kohdnpagk4xip74f2jn36uoal25vhta";

describe(sanitizeAppviewResponse, () => {
  it("truncates alt text that the AppView serves over the pinned lexicon limit", async () => {
    const body = feedPage({ videoAlt: "y".repeat(1901) });
    const fetch = jsonFetch(body);
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await sanitizeAppviewResponse(fetch)("https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed");
      const sent = (await response.json()) as ReturnType<typeof feedPage>;
      const alt = sent.feed[0]?.post.embed?.alt;

      expect(typeof alt).toBe("string");
      expect([...(alt as string)].length).toBe(512);
      // Only the alt text is touched: everything the worker reads survives.
      expect(sent.feed[0]?.post.record.text).toBe("a real post");
      expect(sent.feed[0]?.post.likeCount).toBe(7);
      expect(sent.feed[0]?.post.indexedAt).toBe("2026-09-15T13:23:00.000Z");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("leaves a real post's alt text and every other field exactly as served", async () => {
    const body = feedPage({ videoAlt: "a calm sentence of alt text" });
    const fetch = jsonFetch(body);
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await sanitizeAppviewResponse(fetch)("https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed");
      expect(await response.json()).toEqual(body);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("leaves a non-JSON response untouched", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    const response = await sanitizeAppviewResponse(fetch)("https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe(truncateGraphemes, () => {
  it("keeps whole grapheme clusters when the cut lands inside a family emoji", () => {
    // 4000 UTF-16 units, 1000 graphemes: cutting by length would split a ZWJ
    // sequence and re-serialize a lone modifier the lexicon would reject.
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}".repeat(1000);
    const cut = truncateGraphemes(family, 512);

    expect([...new Intl.Segmenter().segment(cut)].length).toBe(512);
    expect(cut.endsWith("\u200D")).toBe(false);
  });

  it("returns a string already within the limit unchanged", () => {
    expect(truncateGraphemes("short alt", 512)).toBe("short alt");
  });
});

function jsonFetch(body: unknown): typeof globalThis.fetch {
  return vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
  );
}

/** One hydrated video post, the shape that rejects a whole author-feed page. */
function feedPage({ videoAlt }: { videoAlt: string }) {
  return {
    cursor: "next-page",
    feed: [
      {
        post: {
          uri: POST_URI,
          cid: CID,
          author: { did: ACTOR, handle: "alice.test" },
          record: { $type: "app.bsky.feed.post", text: "a real post", createdAt: "2026-09-15T13:22:00.000Z" },
          embed: {
            $type: "app.bsky.embed.video#view",
            cid: CID,
            playlist: "https://video.bsky.app/watch/x/playlist.m3u8",
            thumbnail: "https://video.bsky.app/watch/x/thumbnail.jpg",
            alt: videoAlt,
          },
          indexedAt: "2026-09-15T13:23:00.000Z",
          likeCount: 7,
          replyCount: 0,
          quoteCount: 0,
          repostCount: 0,
        },
      },
    ],
  };
}
