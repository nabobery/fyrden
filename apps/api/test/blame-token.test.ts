// The continuation token's shape: checked with no reads, before anything
// else. Whether it matches a run is RepoBlame's to check.
import { describe, expect, it } from "vitest";
import {
  type BlameToken,
  decodeBlameToken,
  encodeBlameToken,
  pathDigest,
} from "../src/do/repo/blame-token.js";

const TOKEN: BlameToken = {
  v: 1,
  repo: "rep_01HZZZZZZZZZZZZZZZZZZZZZZZ",
  epoch: 3,
  commit: "a".repeat(40),
  path: "b".repeat(64),
  engine: 1,
  run: "01J9ABCDEFGHJKMNPQRSTVWXYZ",
  offset: 1200,
};

describe("blame continuation tokens", () => {
  it("read back what they were written from, in URL-safe base64 with no padding", () => {
    const text = encodeBlameToken(TOKEN);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeBlameToken(text)).toEqual(TOKEN);
  });

  it("refuse anything without a token's exact shape", () => {
    const shaped = (t: Record<string, unknown>) => encodeBlameToken(t as unknown as BlameToken);
    const bad = [
      "",
      "not base64 !",
      "x".repeat(1025),
      encodeBlameToken({ ...TOKEN, v: 2 } as unknown as BlameToken),
      shaped({ ...TOKEN, extra: 1 }),
      shaped({ ...TOKEN, repo: "net_01HZZZZZZZZZZZZZZZZZZZZZZZ" }),
      shaped({ ...TOKEN, epoch: -1 }),
      shaped({ ...TOKEN, commit: "A".repeat(40) }),
      shaped({ ...TOKEN, path: "src/a.ts" }),
      shaped({ ...TOKEN, run: "run" }),
      shaped({ ...TOKEN, offset: 1.5 }),
      btoa("[1,2,3]"),
    ];
    for (const text of bad)
      expect([text.slice(0, 40), decodeBlameToken(text)]).toEqual([text.slice(0, 40), undefined]);
  });

  it("name a path by its SHA-256, never the path itself", async () => {
    expect(await pathDigest("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
