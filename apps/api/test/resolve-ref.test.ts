// Ref resolution, taken out of browse so blame resolves a ref through its
// own reader and limits: the same answers at every branch, whoever supplies
// the lookups.
import { type Oid, oidFromHex, oidToHex } from "@fyrden/git-core";
import { describe, expect, it } from "vitest";
import { type RefLookups, resolveRef } from "../src/git/resolve-ref.js";

const oid = (n: number): Oid => oidFromHex(n.toString(16).padStart(40, "0"));

/** Lookups over a small repository: refs by name, verified commits, and objects that peel to one. */
function lookups(
  refs: Record<string, Oid>,
  {
    head,
    verified = [],
    peels = {},
  }: { head?: string; verified?: Oid[]; peels?: Record<string, Oid> } = {},
): RefLookups & { asked: string[] } {
  const isVerified = (o: Oid) => verified.some((v) => oidToHex(v) === oidToHex(o));
  const asked: string[] = [];
  return {
    asked,
    head: () => (head === undefined ? undefined : refs[head]),
    ref: (name) => {
      asked.push(name);
      return refs[name];
    },
    isVerified,
    commitOf: async (o) => {
      if (isVerified(o)) return o;
      const peeled = peels[oidToHex(o)];
      return peeled && isVerified(peeled) ? peeled : undefined;
    },
  };
}

const answer = async (ref: string | undefined, at: ReturnType<typeof lookups>) => {
  const got = await resolveRef(ref, at);
  return got.ok ? { commit: oidToHex(got.commit) } : { refused: got.reason };
};

describe("resolveRef", () => {
  it("takes the default branch's commit with no ref, and says the repository is empty without one", async () => {
    const repo = lookups(
      { "refs/heads/main": oid(1) },
      { head: "refs/heads/main", verified: [oid(1)] },
    );
    expect(await answer(undefined, repo)).toEqual({ commit: oidToHex(oid(1)) });
    expect(await answer("", repo)).toEqual({ commit: oidToHex(oid(1)) });
    expect(await answer(undefined, lookups({}, { head: "refs/heads/main" }))).toEqual({
      refused: "repo_empty",
    });
    expect(await answer(undefined, lookups({ "refs/heads/main": oid(1) }))).toEqual({
      refused: "repo_empty",
    });
  });

  it("takes a commit id this repository has, without reading a ref", async () => {
    const repo = lookups({}, { verified: [oid(5)] });
    expect(await answer(oidToHex(oid(5)), repo)).toEqual({ commit: oidToHex(oid(5)) });
    expect(repo.asked).toEqual([]);
  });

  it("reads a name shaped like a commit id it lacks as a branch or tag", async () => {
    const name = oidToHex(oid(9));
    const repo = lookups({ [`refs/heads/${name}`]: oid(2) }, { verified: [oid(2)] });
    expect(await answer(name, repo)).toEqual({ commit: oidToHex(oid(2)) });
  });

  it("tries a branch, then a tag, then a full ref name, and the first found decides", async () => {
    const both = lookups(
      { "refs/heads/v1": oid(1), "refs/tags/v1": oid(2) },
      { verified: [oid(1), oid(2)] },
    );
    expect(await answer("v1", both)).toEqual({ commit: oidToHex(oid(1)) });
    const tagOnly = lookups({ "refs/tags/v1": oid(2) }, { verified: [oid(2)] });
    expect(await answer("v1", tagOnly)).toEqual({ commit: oidToHex(oid(2)) });
    const full = lookups({ "refs/notes/x": oid(3) }, { verified: [oid(3)] });
    expect(await answer("refs/notes/x", full)).toEqual({ commit: oidToHex(oid(3)) });
    expect(full.asked).toEqual([
      "refs/heads/refs/notes/x",
      "refs/tags/refs/notes/x",
      "refs/notes/x",
    ]);
    const notCommit = lookups(
      { "refs/heads/x": oid(7), "refs/tags/x": oid(2) },
      { verified: [oid(2)] },
    );
    expect(await answer("x", notCommit)).toEqual({ refused: "ref_not_found" });
  });

  it("peels an annotated tag to its commit", async () => {
    const repo = lookups(
      { "refs/tags/v2": oid(8) },
      { verified: [oid(4)], peels: { [oidToHex(oid(8))]: oid(4) } },
    );
    expect(await answer("v2", repo)).toEqual({ commit: oidToHex(oid(4)) });
  });

  it("finds nothing for a name no ref has", async () => {
    expect(await answer("nope", lookups({}))).toEqual({ refused: "ref_not_found" });
  });
});
