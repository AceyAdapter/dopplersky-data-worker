export type ErrorDetail = {
  message: string;
  errorName?: string;
  errorCode?: string;
  status?: number;
  cause?: string;
};

/**
 * Pull the structured, machine-readable fields off an error for a job log line.
 *
 * XRPC failures from `@atproto/lex` carry a `.error` code ("NotFound",
 * "InternalServerError") and, for a server response, an HTTP `.status` — the
 * pieces a bare `.message` ("Internal Server Error") drops. That omission is why
 * a failing-job log line couldn't say *which* upstream call broke: the pulse
 * showed only the human message, propagated verbatim from the AppView, with no
 * code, status, or endpoint (workspace: the @bsky.app audience scan). Combined
 * with the `subject` (and, for the audience skip, the post URI) already on the
 * line, the code + status are enough to localize the failure.
 *
 * Duck-typed on purpose: no coupling to the client's error classes, and an error
 * that was wrapped or rethrown still yields whatever fields it does carry.
 */
export function describeError(error: unknown): ErrorDetail {
  if (!(error instanceof Error)) return { message: String(error) };
  const detail: ErrorDetail = { message: error.message };
  if (error.name && error.name !== "Error") detail.errorName = error.name;
  const code = readString(error, "error");
  if (code && code !== error.message) detail.errorCode = code;
  const status = readNumber(error, "status");
  if (status !== undefined) detail.status = status;
  if (
    error.cause instanceof Error &&
    error.cause.message &&
    error.cause.message !== error.message
  ) {
    detail.cause = error.cause.message;
  }
  return detail;
}

function readString(source: object, key: string): string | undefined {
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(source: object, key: string): number | undefined {
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
