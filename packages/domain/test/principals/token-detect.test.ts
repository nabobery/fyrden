import { describe, expect, it } from "vitest";
import {
  base64RunHasToken,
  decodeAsciiPercent,
  generateToken,
  mentionsToken,
  secureRandomBytes,
  TOKEN_IN_TEXT,
  TOKEN_TYPES,
} from "../../src/principals/token.js";

const token = generateToken("pat", secureRandomBytes);
const pct = (s: string) =>
  [...s].map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join("");
const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("mentionsToken", () => {
  it.each([
    ["plain", `x ${token} y`],
    ["fully percent-encoded", pct(token)],
    ["percent-encoded next to a malformed escape", `${pct(token)}&bad=%FF`],
    ["base64", btoa(token)],
    ["base64 after a prefix that shifts alignment (1)", `trace_${btoa(token)}`],
    ["base64 after a prefix that shifts alignment (2)", `ab${btoa(`:${token}`)}`],
    ["base64url", b64url(`user:${token}`)],
    ["base64 followed by extra characters", `${btoa(token).replace(/=+$/, "")}AA`],
    ["base64 with characters on both sides", `trace_${btoa(`x${token}`).replace(/=+$/, "")}Zq9`],
    ["base64 inside percent-encoding", encodeURIComponent(`Basic ${btoa(`x:${token}`)}`)],
  ])("finds a %s token", (_, text) => {
    expect(mentionsToken(text)).toBe(true);
  });

  it.each(TOKEN_TYPES)("detects every token type: %s", (type) => {
    const typed = generateToken(type, secureRandomBytes);
    expect(mentionsToken(typed)).toBe(true);
    expect(mentionsToken(btoa(`x:${typed}`))).toBe(true);
    expect(typed.match(new RegExp(TOKEN_IN_TEXT.source))?.[0]).toBe(typed);
  });

  it("does not flag ordinary text or redacted tokens", () => {
    expect(mentionsToken("GET /api/user 200 req-1 a8f3b2c9d0e1f2a3b4c5d6e7f8091a2b")).toBe(false);
    expect(mentionsToken("fyrden_pat_[REDACTED]")).toBe(false);
  });
});

describe("helpers", () => {
  it("decodes ASCII escapes leniently", () => {
    expect(decodeAsciiPercent("a%41b%FF%zz")).toBe("aAb%FF%zz");
  });

  it("checks every base64 alignment", () => {
    expect(base64RunHasToken(`Q${btoa(token)}`)).toBe(true);
  });
});
