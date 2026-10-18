import type { Pool } from "pg";

/** Only connection/availability failures: schema, permission and SQL bugs stay fatal. */
export function isTransientDatabaseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? error.code : undefined;
  if (typeof code === "string" && (
    /^08[0-9A-Z]{3}$/.test(code) ||
    ["53300", "57P01", "57P02", "57P03", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN"].includes(code)
  )) return true;
  // pg-pool's acquisition timeout has no SQLSTATE or system error code.
  return /^(timeout exceeded when trying to connect|Connection terminated(?: unexpectedly| due to connection timeout)?|Connection ended unexpectedly)$/i.test(error.message);
}

/** pg removes the broken idle client itself; an unhandled pool 'error' kills Node. */
export function observePoolErrors(pool: Pool): void {
  pool.on("error", (error: Error & { code?: string }) => {
    // Never serialize the client/pool (or raw connection errors with connection details).
    console.error(JSON.stringify({
      level: "error",
      component: "database",
      message: "idle database connection failed; pool discarded the connection",
      ...(error.code ? { errorCode: error.code } : {}),
    }));
  });
}
