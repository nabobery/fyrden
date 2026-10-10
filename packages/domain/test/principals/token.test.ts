import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  crc32,
  generateToken,
  hashToken,
  parseToken,
  secureRandomBytes,
  TOKEN_TYPES,
  type TokenType,
} from "../../src/principals/token.js";

const fixedBytes = (byte: number) => (n: number) => new Uint8Array(n).fill(byte);

describe("crc32", () => {
  it("matches the IEEE reference value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe("generateToken", () => {
  it("produces fyrden_<type>_<30 base62><6 base62 checksum>", () => {
    const token = generateToken("git", secureRandomBytes);
    expect(token).toMatch(/^fyrden_git_[0-9A-Za-z]{36}$/);
    expect(parseToken(token)).toEqual({ ok: true, type: "git" });
  });

  it("rejects random bytes outside the uniform range instead of biasing", () => {
    // 0xff is >= 248, so it must be rejected; the source never yields an
    // acceptable byte, so generation has to give up rather than loop forever.
    expect(() => generateToken("pat", fixedBytes(0xff))).toThrow(/random source/);
  });

  it("is deterministic for a fixed random source", () => {
    expect(generateToken("job", fixedBytes(0))).toBe(generateToken("job", fixedBytes(0)));
  });
});

describe("parseToken", () => {
  it("round-trips every token type", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...TOKEN_TYPES),
        fc.uint8Array({ minLength: 64, maxLength: 64 }),
        (type: TokenType, seed) => {
          let offset = 0;
          const source = (n: number) => {
            const out = new Uint8Array(n);
            for (let i = 0; i < n; i++) out[i] = (seed[(offset + i) % seed.length] ?? 0) % 248;
            offset += n;
            return out;
          };
          const token = generateToken(type, source);
          expect(parseToken(token)).toEqual({ ok: true, type });
        },
      ),
    );
  });

  it("detects any single-character change in the random part", () => {
    const token = generateToken("pat", secureRandomBytes);
    fc.assert(
      fc.property(
        fc.integer({ min: "fyrden_pat_".length, max: token.length - 1 }),
        fc.constantFrom(..."0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"),
        (index, ch) => {
          fc.pre(token[index] !== ch);
          const mutated = token.slice(0, index) + ch + token.slice(index + 1);
          expect(parseToken(mutated)).toEqual({ ok: false, reason: "bad_checksum" });
        },
      ),
    );
  });

  it.each([
    ["", "malformed"],
    [`fyrden_xyz_${"a".repeat(36)}`, "malformed"],
    [`fyrden_git_${"a".repeat(35)}`, "malformed"],
    [`fyrden_git_${"a".repeat(37)}`, "malformed"],
    [`fyrden_git_${"a".repeat(35)}-`, "malformed"],
    [`ghp_${"a".repeat(36)}`, "malformed"],
    [` fyrden_git_${"a".repeat(36)}`, "malformed"],
  ])("rejects %j as %s", (input, reason) => {
    expect(parseToken(input)).toEqual({ ok: false, reason });
  });
});

describe("hashToken", () => {
  it("returns the lowercase hex SHA-256 of the token", async () => {
    // sha256("abc")
    expect(await hashToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
