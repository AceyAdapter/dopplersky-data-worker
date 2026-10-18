import { describe, expect, it } from "vitest";
import { describeError } from "./error-detail.js";

describe(describeError, () => {
  it("extracts the XRPC code and HTTP status from a server error response", () => {
    // Shape of an @atproto/lex XrpcResponseError: `.error` is the machine code,
    // `.status` the upstream HTTP status, `.message` the human string.
    class XrpcResponseErrorLike extends Error {
      readonly error = "InternalServerError";
      readonly status = 500;
      constructor() {
        super("Internal Server Error");
        this.name = "XrpcResponseError";
      }
    }
    expect(describeError(new XrpcResponseErrorLike())).toEqual({
      message: "Internal Server Error",
      errorName: "XrpcResponseError",
      errorCode: "InternalServerError",
      status: 500,
    });
  });

  it("captures a NotFound the same way", () => {
    class NotFoundLike extends Error {
      readonly error = "NotFound";
      readonly status = 400;
      constructor() {
        super("Post not found: at://did:plc:x/app.bsky.feed.post/3abc");
        this.name = "XrpcResponseError";
      }
    }
    const detail = describeError(new NotFoundLike());
    expect(detail.errorCode).toBe("NotFound");
    expect(detail.status).toBe(400);
  });

  it("carries a wrapped cause when it differs from the message", () => {
    const detail = describeError(new Error("outer", { cause: new Error("inner reason") }));
    expect(detail).toEqual({ message: "outer", cause: "inner reason" });
  });

  it("degrades to just the message for a plain error, dropping the generic name", () => {
    expect(describeError(new Error("boom"))).toEqual({ message: "boom" });
  });

  it("stringifies a non-Error throw", () => {
    expect(describeError("nope")).toEqual({ message: "nope" });
  });
});
