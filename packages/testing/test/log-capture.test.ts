import { generateToken, secureRandomBytes } from "@fyrden/domain";
import { describe, expect, it } from "vitest";
import { installLogCapture, registerSecretValue } from "../src/log-capture.js";

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
  it.fails("fails a test that logs a runner credential", () => {
    console.log(`runner ${generateToken("rnr", secureRandomBytes)}`);
  });
  it.fails("fails a test that logs a percent-encoded token", () => {
    console.log([...token].map((c) => `%${c.charCodeAt(0).toString(16)}`).join(""));
  });
});

describe("registerSecretValue", () => {
  // A secret value has no token shape, so only the registry can catch it.
  const value = registerSecretValue(`secret-${crypto.randomUUID()}`);

  it("returns the value it registers", () => {
    expect(value).toMatch(/^secret-/);
  });

  it("allows lines that do not hold a registered value", () => {
    console.log("masked: ***");
    console.log(value.slice(0, 10));
  });

  it.fails("fails a test that logs a registered value", () => {
    console.log(`env ${value}`);
  });
  it.fails("fails a test that logs a registered value inside an object", () => {
    console.warn({ detail: { text: `x${value}y` } });
  });
  it.fails("fails a test that logs a registered value JSON-escaped", () => {
    const multiline = registerSecretValue(`line-${crypto.randomUUID()}\n"quoted"`);
    console.log(JSON.stringify({ msg: "x", detail: multiline }));
  });
  it.fails("fails a test that logs a registered value escaped twice, as JSON within JSON", () => {
    const multiline = registerSecretValue(`twice-${crypto.randomUUID()}\n"quoted"`);
    console.log(JSON.stringify({ msg: "x", detail: JSON.stringify({ inner: multiline }) }));
  });
  it.fails("fails a test that logs a value registered during the test", () => {
    const late = registerSecretValue(`late-${crypto.randomUUID()}`);
    console.error(new Error(late));
  });
});
