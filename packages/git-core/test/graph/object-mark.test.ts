import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BitSet } from "../../src/graph/bitset.js";
import { addPendingCommits } from "../../src/graph/commit-graph.js";
import { ObjectMark, type ObjectMarkOptions } from "../../src/graph/object-mark.js";
import { createSha1Hasher } from "../../src/hash/sha1.js";
import { type Oid, oidFromHex } from "../../src/object/oid.js";
import { PackIdx } from "../../src/pack/idx-read.js";
import { writeIdx } from "../../src/pack/idx-write.js";
import { MissingObjectError } from "../../src/reader/errors.js";
import { ObjectReader } from "../../src/reader/object-reader.js";
import { createMemoryBudget } from "../../testing/fakes/memory-budget.js";
import { createMemoryCommitGraph } from "../../testing/fakes/memory-commit-graph.js";
import { createMemoryRepoStore } from "../../testing/fakes/memory-repo-store.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";
import { createNodeZlib } from "../../testing/node-zlib.js";
import { parseBytes } from "../pack/parse-helpers.js";
import { buildRepo } from "../pack/repo-fixture.js";

/*
 * Reachability marking for garbage collection: from the roots (ref tips,
 * reflog entries), every object reachable is marked in a bit set per pack,
 * by its `.idx` position. git is the oracle: `git rev-list --objects` lists
 * exactly what the mark finds, and the objects it leaves unmarked are the
 * ones git calls unreachable.
 */

const zlib = createNodeZlib();
const MiB = 1024 * 1024;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

const sandboxes: GitSandbox[] = [];
afterAll(() => Promise.all(sandboxes.map((s) => s.dispose())));

async function lines(repo: GitSandbox, args: string[], input?: string): Promise<string[]> {
  const { stdout } = await repo.git(args, input === undefined ? {} : { input });
  return stdout.split("\n").filter((l) => l.length > 0);
}

const oidsOf = async (repo: GitSandbox, args: string[]) =>
  new Set((await lines(repo, args)).map((l) => l.slice(0, 40)));

/** Stores packs of exactly these objects (no closure), with engine-written `.idx` files. */
async function load(repo: GitSandbox, groups: readonly string[][], readerPacks?: number[]) {
  const store = createMemoryRepoStore();
  const packs: { packId: never; bytes: number; idx: PackIdx }[] = [];
  for (const group of groups) {
    const bytes = await repo.gitBytes(["pack-objects", "--stdout", "-q"], {
      input: group.map((o) => `${o}\n`).join(""),
    });
    const { pack } = await parseBytes(bytes);
    const idx = await writeIdx(pack.entries, pack.checksum, {
      createHasher: () => createSha1Hasher({ detectCollisions: false }),
    });
    pack.release();
    const writer = store.packStore.beginPack();
    await writer.write(bytes);
    const info = await writer.finish();
    packs.push({
      packId: info.packId as never,
      bytes: bytes.length,
      idx: PackIdx.parse(idx.bytes),
    });
  }
  const memory = createMemoryBudget(256 * MiB);
  const viewPacks = (readerPacks ?? packs.map((_, i) => i)).map(
    (i) => packs[i] as (typeof packs)[0],
  );
  const reader = await ObjectReader.open({
    view: { scope: "test", packs: viewPacks },
    packStore: store.packStore,
    zlib,
    memory,
  });
  const graph = createMemoryCommitGraph();
  const commits = await lines(repo, ["log", "--all", "--reflog", "--format=%H %T %ct %P"]);
  const dangling = await lines(repo, ["fsck", "--unreachable", "--no-reflogs"]).catch(() => []);
  const rows = new Map<string, { oid: Oid; tree: Oid; parents: Oid[]; commitTime: number }>();
  for (const line of [...commits]) {
    const [oid, tree, time, ...parents] = line.split(" ");
    rows.set(oid as string, {
      oid: oidFromHex(oid as string),
      tree: oidFromHex(tree as string),
      parents: parents.filter((p) => p.length > 0).map(oidFromHex),
      commitTime: Number(time),
    });
  }
  for (const line of dangling) {
    const [, kind, oid] = line.split(" ");
    if (kind !== "commit" || rows.has(oid as string)) continue;
    const [info] = await lines(repo, ["log", "-1", "--format=%H %T %ct %P", oid as string]);
    const [o, tree, time, ...parents] = (info as string).split(" ");
    rows.set(o as string, {
      oid: oidFromHex(o as string),
      tree: oidFromHex(tree as string),
      parents: parents.filter((p) => p.length > 0).map(oidFromHex),
      commitTime: Number(time),
    });
  }
  await addPendingCommits(graph, "setup", [...rows.values()]);
  await graph.promote("setup");
  return { packs, reader, graph };
}

function markedOids(sources: readonly { idx: PackIdx }[], bits: readonly BitSet[]): Set<string> {
  const out = new Set<string>();
  sources.forEach((s, i) => {
    for (const p of (bits[i] as BitSet).indices()) out.add(hex(s.idx.oidAt(p)));
  });
  return out;
}

async function markAll(options: ObjectMarkOptions, roots: Oid[], slice = Number.POSITIVE_INFINITY) {
  let mark = ObjectMark.start(options);
  mark.push(roots);
  while (!(await mark.run(slice))) mark = ObjectMark.resume(options, mark.checkpoint());
  return mark;
}

describe("reachability mark", () => {
  let repo: GitSandbox;
  let all: string[];
  let reachable: Set<string>;
  let tips: Oid[];
  let loaded: Awaited<ReturnType<typeof load>>;

  beforeAll(async () => {
    repo = await createGitSandbox();
    sandboxes.push(repo);
    await buildRepo(repo, { seed: 5, commits: 25, files: 6, binaryBytes: 800 });
    // A side branch, then objects nothing reaches: a deleted branch's commit,
    // a lone blob and a lone tree.
    await repo.git(["branch", "side", "main~7"]);
    await repo.git(["checkout", "-q", "-b", "gone", "main~3"]);
    await repo.git(["commit", "-q", "--allow-empty", "-m", "gone"]);
    await repo.git(["checkout", "-q", "main"]);
    await repo.git(["branch", "-D", "gone"]);
    const lone = (
      await repo.git(["hash-object", "-w", "--stdin"], { input: "lonely\n" })
    ).stdout.trim();
    await repo.git(["mktree"], { input: `100644 blob ${lone}\tlone.txt\n` });
    // A gitlink in a reachable tree: its commit is in another repository.
    const head = (await repo.git(["rev-parse", "main^{tree}"])).stdout.trim();
    const entries = await lines(repo, ["ls-tree", head]);
    const withLink = (
      await repo.git(["mktree"], {
        input: `${entries.join("\n")}\n160000 commit ${"ab".repeat(20)}\tsubmodule\n`,
      })
    ).stdout.trim();
    const linked = (
      await repo.git(["commit-tree", withLink, "-p", "main", "-m", "add a submodule"])
    ).stdout.trim();
    await repo.git(["update-ref", "refs/heads/linked", linked]);

    all = (
      await lines(repo, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"])
    ).sort();
    reachable = await oidsOf(repo, ["rev-list", "--objects", "--all"]);
    tips = (await lines(repo, ["for-each-ref", "--format=%(objectname)"])).map(oidFromHex);
    // Two packs splitting the objects at random.
    const half = all.filter((_, i) => i % 3 === 0);
    loaded = await load(repo, [half, all.filter((_, i) => i % 3 !== 0)]);
  });

  it("marks exactly what git rev-list --objects --all lists, with and without the commit graph", async () => {
    expect(reachable.size).toBeLessThan(all.length);
    for (const commits of [loaded.graph, undefined]) {
      const mark = await markAll(
        { sources: loaded.packs, reader: loaded.reader, ...(commits ? { commits } : {}) },
        tips,
      );
      expect(markedOids(loaded.packs, mark.bits)).toEqual(reachable);
      expect(mark.marked).toBe(reachable.size);
    }
  });

  it("leaves unmarked exactly what git fsck calls unreachable", async () => {
    const mark = await markAll(
      { sources: loaded.packs, reader: loaded.reader, commits: loaded.graph },
      tips,
    );
    const unreachable = new Set(
      (await lines(repo, ["fsck", "--unreachable", "--no-reflogs"])).map((l) => l.split(" ")[2]),
    );
    const unmarked = new Set(all.filter((o) => !markedOids(loaded.packs, mark.bits).has(o)));
    expect(unmarked).toEqual(unreachable);
  });

  it("gives the same marks when cut into slices and resumed from checkpoints", async () => {
    const whole = await markAll({ sources: loaded.packs, reader: loaded.reader }, tips);
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 40 }), async (slice) => {
        const sliced = await markAll(
          { sources: loaded.packs, reader: loaded.reader, commits: loaded.graph },
          tips,
          slice,
        );
        expect(sliced.bits.map((b) => hex(b.toBytes()))).toEqual(
          whole.bits.map((b) => hex(b.toBytes())),
        );
      }),
      { numRuns: 8 },
    );
  });

  it("marks an object stored in two packs in both", async () => {
    const twice = await load(repo, [all, all]);
    const mark = await markAll({ sources: twice.packs, reader: twice.reader }, tips);
    expect(mark.bits[0]?.count()).toBe(reachable.size);
    expect(mark.bits[1]?.count()).toBe(reachable.size);
  });

  it("adds roots between slices: refs first, then reflog entries", async () => {
    const options = { sources: loaded.packs, reader: loaded.reader, commits: loaded.graph };
    const mark = ObjectMark.start(options);
    const main = oidFromHex((await repo.git(["rev-parse", "main"])).stdout.trim());
    mark.push([main]);
    await mark.run();
    const fromMain = markedOids(loaded.packs, mark.bits);
    expect(fromMain).toEqual(await oidsOf(repo, ["rev-list", "--objects", "main"]));
    mark.push(tips);
    await mark.run();
    expect(markedOids(loaded.packs, mark.bits)).toEqual(reachable);
  });

  it("fails rather than finish incomplete when a reachable object is in no pack", async () => {
    const first = loaded.packs.slice(0, 1);
    await expect(markAll({ sources: first, reader: loaded.reader }, tips)).rejects.toBeInstanceOf(
      MissingObjectError,
    );
  });

  it("with outside 'stop', marks only objects reached through the packs it marks (never more than reachable)", async () => {
    const second = loaded.packs.slice(1);
    const mark = await markAll({ sources: second, reader: loaded.reader, outside: "stop" }, tips);
    const marked = markedOids(second, mark.bits);
    for (const o of marked) expect(reachable.has(o)).toBe(true);
    expect(marked.size).toBeGreaterThan(0);
  });

  it("with outside 'descend', walks through other packs and marks every reachable object of its packs", async () => {
    const second = loaded.packs.slice(1);
    const mark = await markAll(
      { sources: second, reader: loaded.reader, outside: "descend" },
      tips,
    );
    const inSecond = new Set<string>();
    const idx = (second[0] as { idx: PackIdx }).idx;
    for (let p = 0; p < idx.count; p++) inSecond.add(hex(idx.oidAt(p)));
    expect(markedOids(second, mark.bits)).toEqual(
      new Set([...reachable].filter((o) => inSecond.has(o))),
    );
  });

  it("refuses a checkpoint for other sources", async () => {
    const mark = ObjectMark.start({ sources: loaded.packs, reader: loaded.reader });
    mark.push(tips);
    await mark.run(3);
    const saved = mark.checkpoint();
    expect(() =>
      ObjectMark.resume({ sources: loaded.packs.slice(1), reader: loaded.reader }, saved),
    ).toThrow(RangeError);
    const damaged = saved.slice(0, saved.length - 3);
    expect(() =>
      ObjectMark.resume({ sources: loaded.packs, reader: loaded.reader }, damaged),
    ).toThrow(RangeError);
  });
});
