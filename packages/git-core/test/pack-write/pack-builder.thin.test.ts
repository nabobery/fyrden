import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { oidToHex } from "../../src/object/oid.js";
import { PackBuilder } from "../../src/pack-write/pack-builder.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";
import { parseBytes } from "../pack/parse-helpers.js";
import { buildRepo, packObjects } from "../pack/repo-fixture.js";
import { budget, hex, memorySink, zlib } from "./support.js";

/*
 * Thin packs (gitformat-pack, "thin pack"): with `externalBases`, a copied
 * REF_DELTA may name a base that is not in the pack when the receiver is
 * known to hold it. git is the judge: `git index-pack --fix-thin` in a
 * repository that has the bases completes the pack. Without the option a
 * missing base is still refused (the default the other suites prove).
 */

const sandboxes: GitSandbox[] = [];
afterAll(() => Promise.all(sandboxes.map((s) => s.dispose())));

let repo: GitSandbox;
let source: Uint8Array;

beforeAll(async () => {
  repo = await createGitSandbox();
  sandboxes.push(repo);
  await buildRepo(repo, { seed: 5, commits: 8, files: 2, binaryBytes: 2000 });
  source = await packObjects(repo, { ofsDelta: false, depth: 10 });
});

/** The pack's REF_DELTA entries: each entry's bytes and its base. */
async function refDeltas() {
  const { pack } = await parseBytes(source);
  const e = pack.entries;
  const out: {
    entry: { oid: Uint8Array; bytes: Uint8Array; offset: number; crc32: number };
    base: Uint8Array;
  }[] = [];
  for (let i = 0; i < e.count; i++) {
    if (e.kind(i) !== "ref-delta") continue;
    out.push({
      entry: {
        oid: e.oid(i),
        bytes: source.subarray(e.offset(i), e.offset(i) + e.entryLength(i)),
        offset: e.offset(i),
        crc32: e.crc32(i),
      },
      base: e.baseOid(i) as Uint8Array,
    });
  }
  pack.release();
  return out;
}

const holding = (oids: Uint8Array[]) => {
  const set = new Set(oids.map(hex));
  return { has: (oid: Uint8Array) => set.has(hex(oid)) };
};

describe("PackBuilder externalBases (thin packs)", () => {
  it("writes REF_DELTAs against bases the receiver holds, and git completes the pack", async () => {
    const deltas = (await refDeltas()).slice(0, 3);
    expect(deltas.length).toBeGreaterThan(0);
    const inPack = new Set(deltas.map((d) => hex(d.entry.oid)));
    const external = deltas.map((d) => d.base).filter((b) => !inPack.has(hex(b)));
    expect(external.length).toBeGreaterThan(0);

    const sink = memorySink();
    const builder = await PackBuilder.start(deltas.length, {
      sink,
      zlib,
      memory: budget(),
      externalBases: holding(external),
    });
    for (const d of deltas) await builder.copyEntry(d.entry, { oid: d.base });
    const done = await builder.finish();
    expect(done.externalBases.map(oidToHex).sort()).toEqual([...new Set(external.map(hex))].sort());
    done.release();

    // git, in a repository holding every base, completes the thin pack.
    const fixed = await repo.git(["index-pack", "--stdin", "--fix-thin", "--strict"], {
      input: sink.bytes(),
    });
    expect(fixed.stdout).toMatch(/^pack\t[0-9a-f]{40}\n$/);
    for (const d of deltas) {
      const { stdout } = await repo.git(["cat-file", "-t", hex(d.entry.oid)]);
      expect(stdout.trim()).not.toBe("");
    }
  });

  it("still refuses a missing base the receiver is not known to hold", async () => {
    const [delta] = await refDeltas();
    if (!delta) throw new Error("fixture has no REF_DELTA");
    const builder = await PackBuilder.start(1, {
      sink: memorySink(),
      zlib,
      memory: budget(),
      externalBases: holding([]),
    });
    await builder.copyEntry(delta.entry, { oid: delta.base });
    await expect(builder.finish()).rejects.toMatchObject({ code: "missing-base" });
  });

  it("reports no external bases for a self-contained pack", async () => {
    const builder = await PackBuilder.start(1, {
      sink: memorySink(),
      zlib,
      memory: budget(),
      externalBases: holding([]),
    });
    await builder.addObject("blob", new TextEncoder().encode("whole\n"));
    const done = await builder.finish();
    expect(done.externalBases).toEqual([]);
    done.release();
  });

  it("keeps allowing the receiver's bases after a checkpoint and resume", async () => {
    const deltas = (await refDeltas()).slice(0, 2);
    const external = deltas.map((d) => d.base);
    const sink = memorySink();
    const first = await PackBuilder.start(deltas.length, { sink, zlib, memory: budget() });
    await first.copyEntry((deltas[0] as (typeof deltas)[number]).entry, {
      oid: (deltas[0] as (typeof deltas)[number]).base,
    });
    const saved = await first.checkpoint();
    first.release();
    const resumed = await PackBuilder.resume(saved, {
      sink,
      zlib,
      memory: budget(),
      externalBases: holding(external),
    });
    for (const d of deltas.slice(1)) await resumed.copyEntry(d.entry, { oid: d.base });
    const done = await resumed.finish();
    done.release();
    await repo.git(["index-pack", "--stdin", "--fix-thin"], { input: sink.bytes() });
  });
});
