import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";
import { gitPackRows } from "./git-oracle.js";
import { buildPack, gitOid, makeDelta, type PackEntrySpec, text } from "./pack-builder.js";
import { parseBytes, rowsOf } from "./parse-helpers.js";

/*
 * Delta resolution does not depend on entry order: a REF_DELTA whose base
 * comes later in the pack resolves, also when that base is itself a delta.
 * Each hand-built pack is also indexed by `git index-pack`, which must agree.
 */

let sandbox: GitSandbox;
beforeAll(async () => {
  sandbox = await createGitSandbox();
  await sandbox.git(["init", "-q"]);
});
afterAll(() => sandbox.dispose());

const v1 = text("line one\nline two\nline three\n".repeat(20));
const v2 = text(`${"line one\nline two\nline three\n".repeat(20)}line four\n`);
const v3 = text(`${"line one\nline two\nline three\n".repeat(20)}line four\nline five\n`);
const v4 = text(`${"line one\nline two\nline three\n".repeat(20)}line four\nline five\nsix\n`);

async function expectSameAsGit(entries: PackEntrySpec[], expectedOids: string[]) {
  const { bytes } = buildPack(entries);
  const git = await gitPackRows(sandbox, bytes);
  expect(git, "git index-pack accepts the pack").toBeDefined();
  const { pack, objects } = await parseBytes(bytes, { chunkSize: 7 });
  const rows = rowsOf(pack, true);
  expect(rows).toEqual(git?.rows);
  expect(rows.map((r) => r.oid).sort()).toEqual([...expectedOids].sort());
  expect([...objects.keys()].sort()).toEqual([...expectedOids].sort());
  pack.release();
}

describe("pack-parse: REF_DELTA whose base appears later in the pack", () => {
  it("resolves a REF_DELTA that precedes its whole base", async () => {
    await expectSameAsGit(
      [
        { kind: "ref", baseOid: gitOid("blob", v1), delta: makeDelta(v1, v2) },
        { kind: "blob", data: v1 },
      ],
      [gitOid("blob", v1), gitOid("blob", v2)],
    );
  });

  it("resolves a chain in reverse order: each REF_DELTA before its own (delta) base", async () => {
    await expectSameAsGit(
      [
        { kind: "ref", baseOid: gitOid("blob", v3), delta: makeDelta(v3, v4) },
        { kind: "ref", baseOid: gitOid("blob", v2), delta: makeDelta(v2, v3) },
        { kind: "ref", baseOid: gitOid("blob", v1), delta: makeDelta(v1, v2) },
        { kind: "blob", data: v1 },
      ],
      [v1, v2, v3, v4].map((v) => gitOid("blob", v)),
    );
  });

  it("resolves an OFS_DELTA whose base is a REF_DELTA resolved through a later base", async () => {
    await expectSameAsGit(
      [
        { kind: "commit", data: text("tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n\nfirst\n") },
        { kind: "ref", baseOid: gitOid("blob", v1), delta: makeDelta(v1, v2) },
        { kind: "ofs", base: 1, delta: makeDelta(v2, v3) },
        { kind: "blob", data: v1 },
      ],
      [
        gitOid("commit", text("tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n\nfirst\n")),
        ...[v1, v2, v3].map((v) => gitOid("blob", v)),
      ],
    );
  });

  it("resolves several REF_DELTAs sharing one later base, and a tree delta", async () => {
    const tree = (name: string) =>
      new Uint8Array([...text(`100644 ${name}\0`), ...Buffer.from(gitOid("blob", v1), "hex")]);
    await expectSameAsGit(
      [
        { kind: "ref", baseOid: gitOid("blob", v1), delta: makeDelta(v1, v2) },
        { kind: "ref", baseOid: gitOid("blob", v1), delta: makeDelta(v1, v3) },
        {
          kind: "ref",
          baseOid: gitOid("tree", tree("a.txt")),
          delta: makeDelta(tree("a.txt"), tree("ab.txt")),
        },
        { kind: "blob", data: v1 },
        { kind: "tree", data: tree("a.txt") },
      ],
      [
        ...[v1, v2, v3].map((v) => gitOid("blob", v)),
        gitOid("tree", tree("a.txt")),
        gitOid("tree", tree("ab.txt")),
      ],
    );
  });
});
