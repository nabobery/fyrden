import { generateToken, secureRandomBytes } from "@fyrden/domain";
import { describe, expect, it } from "vitest";
import { installLogCapture } from "../src/log-capture.js";

const logs = installLogCapture();

describe("installLogCapture", () => {
  it("captures console output for the current test", () => {
    console.log(JSON.stringify({ msg: "hello", requestId: "r1" }));
    console.error("plain text");
    expect(logs.lines).toHaveLength(2);
    expect(logs.entries()).toEqual([{ msg: "hello", requestId: "r1" }]);
  });

  it("starts each test empty", () => {
    expect(logs.lines).toEqual([]);
  });

  it("allows redacted tokens", () => {
    console.log("token fyrden_pat_[REDACTED]");
  });

  // The leaking cases fail by design, so they are proved with `it.fails`.
  const token = generateToken("pat", secureRandomBytes);
  it.fails("fails a test that logs a plain token", () => {
    console.log(`leak ${token}`);
  });
  it.fails("fails a test that logs a token inside Basic auth", () => {
    console.log(`Authorization: Basic ${btoa(`x:${token}`)}`);
  });
  it.fails("fails a test that logs a base64 token with a suffix", () => {
    console.log(`request id ${btoa(token).replace(/=+$/, "")}AA`);
  });
  it.fails("fails a test that logs an Error object carrying a token", () => {
    console.error(new Error(`lookup failed for ${token}`));
  });
  it.fails("fails a test that logs an Error nested in an object", () => {
    console.error({ error: new Error(token) });
  });
  it.fails("fails a test that logs a token in an Error's cause", () => {
    console.error(new Error("outer", { cause: new Error(token) }));
  });
  it.fails("fails a test that logs a token in an extra Error property", () => {
    console.error(Object.assign(new Error("outer"), { credential: token }));
  });
  it.fails("fails a test that logs a percent-encoded token", () => {
    console.log([...token].map((c) => `%${c.charCodeAt(0).toString(16)}`).join(""));
  });
});
