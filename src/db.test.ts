import { EventEmitter } from "node:events";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { isTransientDatabaseError, observePoolErrors } from "./db.js";

describe("database availability failures", () => {
  it.each([
    "timeout exceeded when trying to connect",
    "Connection terminated unexpectedly",
    "Connection terminated due to connection timeout",
  ])("recognizes pg connection error: %s", (message) => {
    expect(isTransientDatabaseError(new Error(message))).toBe(true);
  });

  it.each(["08006", "53300", "57P01", "57P02", "57P03", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT"])(
    "recognizes availability code %s", (code) => {
      expect(isTransientDatabaseError(Object.assign(new Error("unavailable"), { code }))).toBe(true);
    },
  );

  it.each(["23514", "42601", "28P01", "42501"])("does not retry SQL/configuration error %s", (code) => {
    expect(isTransientDatabaseError(Object.assign(new Error("broken"), { code }))).toBe(false);
  });

  it("does not mistake arbitrary timeout or programming errors for DB availability", () => {
    expect(isTransientDatabaseError(new Error("request timed out"))).toBe(false);
    expect(isTransientDatabaseError(new TypeError("bad scheduler code"))).toBe(false);
    expect(isTransientDatabaseError("timeout exceeded when trying to connect")).toBe(false);
  });
});

describe("idle pool errors", () => {
  it("handles idle-client error events without exposing connection/client details", () => {
    const pool = new EventEmitter();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      observePoolErrors(pool as Pool);
      expect(() => pool.emit("error", Object.assign(new Error("sensitive connection details"), {
        code: "ECONNRESET",
      }), { connectionString: "secret" })).not.toThrow();
      expect(log).toHaveBeenCalledOnce();
      expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({
        level: "error", component: "database", errorCode: "ECONNRESET",
        message: "idle database connection failed; pool discarded the connection",
      });
    } finally {
      log.mockRestore();
    }
  });
});
