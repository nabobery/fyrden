import { createLogger } from "@fyrden/adapters-cloudflare/obs";
import { generateToken, mentionsToken, secureRandomBytes } from "@fyrden/domain";
import { installLogCapture } from "@fyrden/testing/log-capture";
import { UNSAFE_ErrorResponseImpl as ErrorResponse } from "react-router";
import { describe, expect, it } from "vitest";
import { logServerError } from "../app/lib/log-error.server.js";

// Fails any test whose console output carries a token in any form.
const logs = installLogCapture();
const token = generateToken("pat", secureRandomBytes);

describe("logServerError", () => {
  it("logs a loader error through the redacting logger", () => {
    logServerError(
      new Error(`api call failed for ${token}`),
      new Request(`https://web.test/repos/${token}`),
    );
    const [entry] = logs.entries();
    expect(entry).toMatchObject({ level: "error", msg: "web server error", method: "GET" });
    expect(mentionsToken(JSON.stringify(entry))).toBe(false);
  });

  it("logs the wrapped error of a route error response (an unmatched URL)", () => {
    const notFound = new ErrorResponse(
      404,
      "Not Found",
      new Error(`No route matches URL "/${token}"`),
      true,
    );
    logServerError(notFound, new Request(`https://web.test/${token}`));
    expect(logs.entries()).toHaveLength(1);
    expect(logs.lines.join("\n")).toContain("No route matches URL");
  });

  it("ignores requests the client aborted", () => {
    const controller = new AbortController();
    controller.abort();
    logServerError(new Error("x"), new Request("https://web.test/", { signal: controller.signal }));
    expect(logs.lines).toEqual([]);
  });

  it("logs without a request (errors outside one)", () => {
    const lines: string[] = [];
    logServerError(
      new Error("boom"),
      undefined,
      createLogger({}, (_, l) => lines.push(l)),
    );
    expect(JSON.parse(lines[0] as string)).toMatchObject({ msg: "web server error" });
  });
});
