/**
 * Response-boundary hygiene for AppView reads.
 *
 * `AppviewClient` validates every response against the CID-pinned lexicons, and
 * `app.bsky.embed.video#view.alt` carries `maxGraphemes: 1000`. The live AppView
 * does not enforce that on *output*: a post whose video alt text is over the
 * limit is indexed and served to everyone (indexer writes are not validated
 * against the current lexicon). Because response validation is all-or-nothing,
 * one such post rejects the whole author-feed page — the durable `account.posts`
 * job retries, fails, backs off, and retries again forever, wedging that
 * account's baseline (workspace 2026-09-15: two accounts looping, one at 10
 * attempts).
 *
 * The worker never reads `alt` — `toPostMetrics` keeps counters, text, and
 * timestamps — so oversized alt text is exactly the payload the worker does not
 * need. Trim it at the boundary, the same way `stripNul` trims a NUL byte that
 * Postgres cannot store, instead of relaxing validation for everything.
 *
 * The trim happens on a *clone*: the original body is left untouched, so
 * transport retries and the observability wrapper keep their semantics.
 */

/**
 * Deliberately well under the lexicon's 1000: this is a discard, so the exact
 * boundary does not matter, and a lower cap keeps working if a future lexicon
 * tightens the limit. Real alt text is a sentence or two and never reaches it.
 */
const ALT_GRAPHEME_LIMIT = 512;

/** Property name of the accessibility description on image/video/gallery embeds. */
const ALT_PROPERTY = "alt";

const segmenter = new Intl.Segmenter();

/**
 * Wrap a `fetch` implementation so every AppView response body is sanitized
 * before `@atproto/lex` validates it.
 */
export function sanitizeAppviewResponse(
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetchImplementation(input, init);
    return sanitizeResponse(response);
  }) as typeof globalThis.fetch;
}

async function sanitizeResponse(response: Response): Promise<Response> {
  const type = response.headers.get("content-type");
  if (!response.body || !type || !type.includes("json")) return response;

  let body: unknown;
  const copy = response.clone();
  try {
    body = await copy.json();
  } catch {
    // Not JSON after all (or a truncated body): leave it for the client to
    // report, which keeps that failure on the existing retry path.
    return response;
  }
  const trimmed = trimOversizedAlt(body);
  if (trimmed === 0) return response;

  console.error(
    JSON.stringify({
      level: "warn",
      component: "appview",
      message: "trimmed oversized embed alt text before response validation",
      fields: trimmed,
      maximumGraphemes: ALT_GRAPHEME_LIMIT,
    }),
  );

  return new Response(JSON.stringify(body), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Truncate every `alt` string property beyond the limit, in place. Returns how
 * many were trimmed. Structural walk on purpose: the same oversized alt hides
 * at `post.embed.alt` (a direct video embed) and at
 * `post.embed.record.record.embeds[0].alt` (a quote of a post whose hydrate
 * carries it), and embeddings of embeds are not worth special-casing.
 */
function trimOversizedAlt(value: unknown): number {
  let trimmed = 0;
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const child = record[key];
      if (typeof child === "string") {
        if (key === ALT_PROPERTY && child.length > ALT_GRAPHEME_LIMIT) {
          const cut = truncateGraphemes(child, ALT_GRAPHEME_LIMIT);
          if (cut !== child) {
            record[key] = cut;
            trimmed += 1;
          }
        }
        continue;
      }
      visit(child);
    }
  };
  visit(value);
  return trimmed;
}

/**
 * Cut a string to at most `limit` graphemes, never mid-cluster — a lone emoji
 * modifier or ZWJ would otherwise be re-serialized as text the lexicon rejects
 * for a different reason.
 */
export function truncateGraphemes(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let count = 0;
  for (const { index } of segmenter.segment(value)) {
    count += 1;
    if (count > limit) return value.slice(0, index);
  }
  return value;
}
