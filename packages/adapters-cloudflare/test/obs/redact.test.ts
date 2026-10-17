import { describe, expect, it } from "vitest";
import { REDACTED, redact, redactString, secret } from "../../src/obs/redact.js";

const token = `fyrden_pat_${"A1b2C3d4E5".repeat(3)}x9Y8z7`;
const b64 = (s: string) => btoa(s);

describe("redactString", () => {
  it.each([
    ["a bare token", `token is ${token}`],
    ["a token in a URL query", `https://h/x?access_token=${token}&a=1`],
    ["a URL-encoded token", `q=${encodeURIComponent(`Bearer ${token}`)}`],
    ["a bearer header value", `Bearer ${token}`],
    ["a basic-auth header value", `Basic ${b64(`x-access-token:${token}`)}`],
    ["a base64-encoded token in free text", `blob ${b64(`prefix ${token} suffix`)} end`],
    [
      "a base64url-encoded token",
      `x=${b64(token).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`,
    ],
  ])("removes %s", (_, input) => {
    const out = redactString(input);
    expect(out).not.toContain(token);
    expect(out).not.toContain(token.slice(11, 41));
    expect(out).not.toContain(b64(token).slice(0, 40));
  });

  it("removes a webhook secret, plain, percent-encoded or in base64", () => {
    const whsec = `whsec_${b64("0123456789abcdef0123456789abcdef")}`;
    for (const input of [
      `secret ${whsec} here`,
      `q=${encodeURIComponent(whsec)}`,
      `blob ${b64(`x ${whsec} y`)}`,
      new Error(`failed with ${whsec}`).message,
    ]) {
      const out = redactString(input);
      expect(out).not.toContain(whsec.slice(6, 30));
      expect(out).not.toContain(b64(whsec).slice(0, 30));
    }
  });

  it("keeps the token type so logs stay useful", () => {
    expect(redactString(`t=${token}`)).toBe(`t=fyrden_pat_${REDACTED}`);
  });

  it("removes any bearer or basic credential, not only Fyrden tokens", () => {
    expect(redactString("Authorization: Bearer abc.def.ghi")).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
    expect(redactString(`Basic ${b64("user:hunter2")}`)).toBe(`Basic ${REDACTED}`);
  });

  it("leaves ordinary text alone", () => {
    expect(redactString("GET /repos/acme/widgets 200 in 12 ms")).toBe(
      "GET /repos/acme/widgets 200 in 12 ms",
    );
  });
});

describe("redact (structured values)", () => {
  it("redacts sensitive keys at any depth", () => {
    const out = redact({
      headers: { Authorization: "x", Cookie: "y", "set-cookie": "z", "x-api-key": "k" },
      body: { password: "p", client_secret: "s", nested: [{ refresh_token: "r" }] },
    });
    expect(out).toEqual({
      headers: {
        Authorization: REDACTED,
        Cookie: REDACTED,
        "set-cookie": REDACTED,
        "x-api-key": REDACTED,
      },
      body: { password: REDACTED, client_secret: REDACTED, nested: [{ refresh_token: REDACTED }] },
    });
  });

  it("keeps token ids and prefixes, which logs are meant to carry", () => {
    expect(redact({ token_id: "tok_1", tokenId: "tok_2", token_prefix: "fyrden_pat" })).toEqual({
      token_id: "tok_1",
      tokenId: "tok_2",
      token_prefix: "fyrden_pat",
    });
  });

  it("redacts tokens inside string values and JSON bodies", () => {
    const out = JSON.stringify(redact({ msg: `got ${token}`, body: JSON.stringify({ t: token }) }));
    expect(out).not.toContain(token);
  });

  it("redacts values wrapped with secret() under any key", () => {
    expect(redact({ anything: secret("hunter2") })).toEqual({ anything: REDACTED });
    expect(JSON.stringify({ x: secret("hunter2") })).not.toContain("hunter2");
    expect(String(secret("hunter2"))).toBe(REDACTED);
  });

  it("survives cycles and errors", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(redact(a)).toEqual({ name: "a", self: "[Circular]" });
    const err = redact(new Error(`failed with ${token}`)) as { message: string };
    expect(err.message).not.toContain(token);
  });
});

describe("redactString with shifted and malformed encodings", () => {
  const pct = (s: string) =>
    [...s].map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join("");
  it.each([
    ["base64 after a prefix", `trace_${btoa(token)}`],
    ["fully percent-encoded with a malformed neighbour", `${pct(token)}&bad=%FF`],
  ])("removes a token in %s", (_, input) => {
    const out = redactString(input);
    expect(out).not.toContain(btoa(token).slice(0, 20));
    expect(out).not.toContain(token);
  });

  it("redacts tokens used as object keys and error names", () => {
    const err = new Error("x");
    err.name = token;
    expect(JSON.stringify(redact({ [token]: 1, err }))).not.toContain(token);
  });
});
