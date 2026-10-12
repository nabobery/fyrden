import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";
import { gitAccepts } from "./git-oracle.js";
import { buildPack, encodeDelta, gitOid, makeDelta, text, withTrailer } from "./pack-builder.js";
import { parseCode } from "./parse-helpers.js";
import { buildRepo, packObjects } from "./repo-fixture.js";

/*
 * The pack corpus: small valid packs and corruptions modelled on git's
 * t5303-pack-corruption-resilience, t5313-pack-bounds-checks and
 * t5314-pack-cycle-detection. A file named `ok-*.pack` must parse; a file
 * named `bad-<code>--*.pack` must fail with that PackError code. Each
 * verdict must match `git index-pack`'s. The mutation fuzz test seeds from
 * the valid packs. Regenerate with FYRDEN_WRITE_PACK_CORPUS=1.
 */

const CORPUS = join(import.meta.dirname, "../corpus/packs");
const MiB = 1024 * 1024;

let sandbox: GitSandbox;
beforeAll(async () => {
  sandbox = await createGitSandbox();
  await sandbox.git(["init", "-q"]);
});
afterAll(() => sandbox.dispose());

/** Flips bits at `at` (negative counts from the end) and recomputes the trailer. */
function corrupt(pack: Uint8Array, at: number, xor = 0xff): Uint8Array {
  const body = pack.slice(0, pack.length - 20);
  const index = at < 0 ? body.length + at : at;
  body[index] = (body[index] as number) ^ xor;
  return withTrailer(body);
}

async function generate(): Promise<Record<string, Uint8Array>> {
  const repo = await createGitSandbox();
  try {
    await buildRepo(repo, { seed: 5303, commits: 6, files: 3, binaryBytes: 300 });
    const ofs = await packObjects(repo, { ofsDelta: true, window: 10 });
    const ref = await packObjects(repo, { window: 10 });
    const v1 = text("line one\nline two\nline three\n".repeat(4));
    const v2 = text(`${"line one\nline two\nline three\n".repeat(4)}line four\n`);
    const v3 = text(`${"line one\nline two\nline three\n".repeat(4)}line four\nline five\n`);
    const other = text("unrelated object\n");
    const whole = buildPack([{ kind: "blob", data: v1 }]);
    const v3Pack = whole.bytes.slice(0, -20);
    v3Pack[7] = 3;
    const files: Record<string, Uint8Array> = {
      "ok-git-ofs-deltas.pack": ofs,
      "ok-git-ref-deltas.pack": ref,
      "ok-empty.pack": buildPack([]).bytes,
      "ok-version-3.pack": withTrailer(v3Pack),
      "ok-ref-delta-before-base.pack": buildPack([
        { kind: "ref", baseOid: gitOid("blob", v2), delta: makeDelta(v2, v3) },
        { kind: "ref", baseOid: gitOid("blob", v1), delta: makeDelta(v1, v2) },
        { kind: "blob", data: v1 },
      ]).bytes,
      "ok-three-sizes-differ.pack": buildPack([
        { kind: "blob", data: v1 },
        {
          kind: "ofs",
          base: 0,
          delta: encodeDelta(v1.length, 40, [{ copy: [0, 20] }, { insert: text("x".repeat(20)) }]),
        },
      ]).bytes,
      // git index-pack accepts one object twice unless --strict; so does the parser.
      "ok-duplicate-object.pack": buildPack([
        { kind: "blob", data: v1 },
        { kind: "blob", data: v1 },
      ]).bytes,
      "bad-bad-header--signature.pack": buildPack([{ kind: "blob", data: v1 }], {
        signature: "PACX",
      }).bytes,
      "bad-bad-header--version-4.pack": buildPack([{ kind: "blob", data: v1 }], { version: 4 })
        .bytes,
      "bad-truncated--in-header.pack": ofs.subarray(0, 8),
      "bad-truncated--in-entry.pack": ofs.subarray(0, Math.floor(ofs.length / 2)),
      "bad-truncated--in-trailer.pack": ofs.subarray(0, ofs.length - 5),
      "bad-truncated--count-too-high.pack": buildPack([{ kind: "blob", data: v1 }], { count: 2 })
        .bytes,
      "bad-bad-checksum--count-too-low.pack": buildPack(
        [
          { kind: "blob", data: v1 },
          { kind: "blob", data: v2 },
        ],
        { count: 1 },
      ).bytes,
      "bad-bad-checksum--trailer.pack": ofs.map((b, i) => (i === ofs.length - 1 ? b ^ 1 : b)),
      "bad-trailing-bytes--junk-after-trailer.pack": new Uint8Array([...whole.bytes, 0]),
      // t5303: "corrupt a pack header" (the type bits of an entry).
      "bad-bad-entry-header--type-5.pack": buildPack([{ kind: "blob", data: v1, typeCode: 5 }])
        .bytes,
      "bad-bad-entry-header--type-0.pack": buildPack([{ kind: "blob", data: v1, typeCode: 0 }])
        .bytes,
      // t5303: "corrupt packed object data".
      "bad-bad-zlib--corrupt-data.pack": corrupt(whole.bytes, 12 + 2 + 4, 0x55),
      "bad-bad-zlib--adler.pack": corrupt(whole.bytes, -1, 0x01),
      "bad-inflate-bomb--longer-than-header.pack": buildPack([
        { kind: "blob", data: v1, compressed: deflateSync(new Uint8Array(MiB)) },
      ]).bytes,
      "bad-size-mismatch--shorter-than-header.pack": buildPack([
        { kind: "blob", data: v1, compressed: deflateSync(v1.subarray(1)) },
      ]).bytes,
      "bad-object-too-large--declared-33mib.pack": buildPack([
        { kind: "blob", data: v1, declaredSize: 33 * MiB },
      ]).bytes,
      // t5303: "corrupt delta base offset"; t5313-style bounds.
      "bad-bad-delta-base-offset--not-an-entry.pack": buildPack([
        { kind: "blob", data: v1 },
        { kind: "ofs-raw", distance: v1.length, delta: makeDelta(v1, v2) },
      ]).bytes,
      "bad-bad-delta-base-offset--before-pack.pack": buildPack([
        { kind: "blob", data: v1 },
        { kind: "ofs-raw", distance: 10_000, delta: makeDelta(v1, v2) },
      ]).bytes,
      // t5303: "corruption of delta base reference pointing to wrong object".
      "bad-delta-base-size-mismatch--wrong-base.pack": buildPack([
        { kind: "blob", data: other },
        { kind: "ref", baseOid: gitOid("blob", other), delta: makeDelta(v1, v2) },
      ]).bytes,
      "bad-delta-result-size-mismatch--short-result.pack": buildPack([
        { kind: "blob", data: v1 },
        { kind: "ofs", base: 0, delta: encodeDelta(v1.length, 30, [{ copy: [0, 20] }]) },
      ]).bytes,
      "bad-bad-delta--opcode-0.pack": buildPack([
        { kind: "blob", data: v1 },
        { kind: "ofs", base: 0, delta: new Uint8Array([...encodeDelta(v1.length, 1, []), 0]) },
      ]).bytes,
      "bad-bad-delta--copy-outside-base.pack": buildPack([
        { kind: "blob", data: v1 },
        {
          kind: "ofs",
          base: 0,
          delta: encodeDelta(v1.length, 10, [{ copy: [v1.length - 5, 10] }]),
        },
      ]).bytes,
      "bad-missing-base--ref-delta.pack": buildPack([
        { kind: "ref", baseOid: gitOid("blob", other), delta: makeDelta(other, v1) },
      ]).bytes,
      // t5314: deltas that are each other's base.
      "bad-missing-base--delta-cycle.pack": buildPack([
        { kind: "ref", baseOid: gitOid("blob", v2), delta: makeDelta(v2, v1) },
        { kind: "ref", baseOid: gitOid("blob", v1), delta: makeDelta(v1, v2) },
      ]).bytes,
    };
    return files;
  } finally {
    await repo.dispose();
  }
}

describe("pack corpus", () => {
  it.runIf(process.env.FYRDEN_WRITE_PACK_CORPUS === "1")(
    "regenerates the corpus",
    async () => {
      await rm(CORPUS, { recursive: true, force: true });
      await mkdir(CORPUS, { recursive: true });
      for (const [name, bytes] of Object.entries(await generate())) {
        await writeFile(join(CORPUS, name), bytes);
      }
    },
    60_000,
  );

  it("gives each corpus pack its expected verdict, and git agrees on accept or reject", async () => {
    const names = (await readdir(CORPUS)).filter((n) => n.endsWith(".pack")).sort();
    expect(names.length).toBeGreaterThan(20);
    for (const name of names) {
      const bytes = new Uint8Array(await readFile(join(CORPUS, name)));
      const expected = name.startsWith("ok-") ? "ok" : (/^bad-(.+?)--/.exec(name)?.[1] ?? "?");
      expect(`${name}: ${await parseCode(bytes, { chunkSize: 13 })}`).toBe(`${name}: ${expected}`);
      expect(`${name}: ${await gitAccepts(sandbox, bytes)}`).toBe(`${name}: ${expected === "ok"}`);
    }
  }, 60_000);
});
