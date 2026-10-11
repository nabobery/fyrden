// Cache key construction: every response key carries the repository id
// (never only a SHA), every block key carries its network scope, and
// anything that cannot form a key is refused rather than escaped.
import { asPackId } from "@fyrden/git-core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { blockCacheUrl } from "../../src/cache/cache-api-block-cache.js";
import { type ResponseObject, responseCacheUrl } from "../../src/cache/response-key.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const crockford = (n: number) =>
  fc.array(fc.constantFrom(...CROCKFORD), { minLength: n, maxLength: n }).map((c) => c.join(""));
const repoId = crockford(26).map((s) => `rep_${s}`);
const hex40 = fc
  .array(fc.constantFrom(..."0123456789abcdef"), { minLength: 40, maxLength: 40 })
  .map((c) => c.join(""));
const variant = fc.constantFrom("raw", "json", "html-v1", "tar.gz", "zip");
const object: fc.Arbitrary<ResponseObject> = fc.oneof(
  fc.record({ kind: fc.constantFrom("commit", "tree", "blob" as const), oid: hex40 }),
  fc.record({ kind: fc.constant("diff" as const), base: hex40, head: hex40 }),
);

const PACK = asPackId("01J00000000000000000000000");

function attempt(fn: () => string): string | RangeError {
  try {
    return fn();
  } catch (error) {
    if (error instanceof RangeError) return error;
    throw error;
  }
}

describe("response cache keys", () => {
  it("always start with the repository id, then kind and object", () => {
    fc.assert(
      fc.property(repoId, object, variant, (repo, obj, v) => {
        const url = new URL(responseCacheUrl(repo, obj, v));
        const [, version, id, kind, target, last] = url.pathname.split("/");
        expect([version, id, kind, last]).toEqual(["v1", repo, obj.kind, v]);
        expect(target).toBe(obj.kind === "diff" ? `${obj.base}..${obj.head}` : obj.oid);
        expect(url.search).toBe("");
      }),
    );
  });

  it("differ for the same object in two repositories", () => {
    fc.assert(
      fc.property(repoId, repoId, object, variant, (a, b, obj, v) => {
        fc.pre(a !== b);
        expect(responseCacheUrl(a, obj, v)).not.toBe(responseCacheUrl(b, obj, v));
      }),
    );
  });

  it("are never built without a repository id, or from anything but a repository id", () => {
    fc.assert(
      fc.property(fc.string(), object, variant, (repo, obj, v) => {
        fc.pre(!/^rep_[0-9A-HJKMNP-TV-Z]{26}$/.test(repo));
        expect(attempt(() => responseCacheUrl(repo, obj, v))).toBeInstanceOf(RangeError);
      }),
    );
    for (const repo of ["", "net_01J00000000000000000000000", "rep_", "rep_x/../y"]) {
      expect(
        attempt(() => responseCacheUrl(repo, { kind: "blob", oid: "a".repeat(40) }, "raw")),
      ).toBeInstanceOf(RangeError);
    }
  });

  it("refuse object ids and variants that are not exactly what they claim", () => {
    fc.assert(
      fc.property(repoId, fc.string(), fc.string(), (repo, oid, v) => {
        const key = attempt(() => responseCacheUrl(repo, { kind: "blob", oid }, v));
        const valid = /^[0-9a-f]{40}$/.test(oid) && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(v);
        expect(typeof key === "string").toBe(valid);
      }),
    );
    expect(
      attempt(() =>
        responseCacheUrl(
          "rep_01J00000000000000000000000",
          { kind: "packs" } as unknown as ResponseObject,
          "raw",
        ),
      ),
    ).toBeInstanceOf(RangeError);
  });
});

describe("pack block cache keys", () => {
  it("always carry the network scope", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9_-]{1,128}$/),
        fc.nat({ max: 2 ** 31 }),
        (scope, block) => {
          const url = new URL(blockCacheUrl(scope, PACK, block));
          expect(url.pathname).toBe(`/v1/${scope}/${PACK}/${block}`);
        },
      ),
    );
  });

  it("are never built without a scope or with one that could change the key's shape", () => {
    fc.assert(
      fc.property(fc.string(), (scope) => {
        fc.pre(!/^[A-Za-z0-9_-]{1,128}$/.test(scope));
        expect(attempt(() => blockCacheUrl(scope, PACK, 0))).toBeInstanceOf(RangeError);
      }),
    );
  });
});
