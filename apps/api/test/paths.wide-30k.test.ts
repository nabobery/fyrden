// The path list's declared workload (tools/bench/path-finder) on real packs:
// its first open asserted as work, never as time: slices, trees read, R2 reads
// and rows written; its later opens read no tree and write nothing.

import { createClockBlockCache } from "@fyrden/adapters-cloudflare";
import {
  compareTreeEntries,
  encodeTree,
  type Oid,
  oidToHex,
  type TreeEntry,
} from "@fyrden/git-core";
import { beforeAll, describe, expect, it } from "vitest";
import { WIDE_30K_ROOT, wide30kDirectories } from "../../../tools/bench/path-finder/wide-30k.js";
import { RepoBrowse } from "../src/do/repo/browse.js";
import { type PathCursor, PathLists, type PathsPage } from "../src/do/repo/path-lists.js";
import { type BuiltObject, commit, concat, object, packOf } from "./helpers/pack-build.js";
import { type PushTarget, postPush, pushTarget } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const enc = new TextEncoder();
const FILE = 0o100644;
const TREE = 0o40000;

/** Recorded from the frozen generator: each resume rereads its cursor's path. */
const TREES_READ = 611;
/** Stated bound: a slice stops at about 400, and the reader's block cache may do far better. */
const MAX_R2_READS = 1200;

let target: PushTarget;
let expected: string[];

async function pack(): Promise<{ head: Oid; bytes: Uint8Array }> {
  const directories = wide30kDirectories();
  const objects: BuiltObject[] = [];
  const treeOf = async (entries: TreeEntry[]) => {
    const tree = await object("tree", encodeTree(entries.sort(compareTreeEntries)));
    objects.push(tree);
    return tree.oid;
  };
  const oids = new Map<string, Oid>();
  // Children first.
  for (const directory of [...directories].reverse()) {
    const blob = await object("blob", enc.encode(`${directory.path}\n`));
    objects.push(blob);
    oids.set(
      directory.path,
      await treeOf([
        ...directory.files.map(
          (name): TreeEntry => ({ name: enc.encode(name), mode: FILE, oid: blob.oid }),
        ),
        ...directory.directories.map(
          (name): TreeEntry => ({
            name: enc.encode(name),
            mode: TREE,
            oid: oids.get(`${directory.path}/${name}`) as Oid,
          }),
        ),
      ]),
    );
  }
  const root = await treeOf(
    WIDE_30K_ROOT.map(
      (name): TreeEntry => ({ name: enc.encode(name), mode: TREE, oid: oids.get(name) as Oid }),
    ),
  );
  const head = await commit(root, [], 1_700_000_000, "wide-30k");
  return { head: head.oid, bytes: await packOf([head, ...objects]) };
}

/** Every page from the start, with what its requests cost. */
async function open() {
  return inRepo(target.repo.stub, async (r) => {
    const work = { rowsRead: 0, rowsWritten: 0, r2Reads: 0, pages: 0, slices: 0, trees: 0 };
    const paths: string[] = [];
    const lists = new PathLists({
      git: r.git,
      epochGen: () => r.events.epochGen(),
      policy: () => r.pathsPolicy,
      log: () => ({ warn() {} }),
      hooks: {
        rows: (read, written) => {
          work.rowsRead += read;
          work.rowsWritten += written;
        },
        sliced: (trees) => {
          work.slices++;
          work.trees += trees;
        },
      },
    });
    let cursor: PathCursor | undefined;
    let last: PathsPage | undefined;
    for (let i = 0; i < 20; i++) {
      const browse = new RepoBrowse({
        git: r.git,
        memoryBlocks: createClockBlockCache(),
      });
      try {
        const page = await lists.page(browse, { perPage: 10_000, ...(cursor && { cursor }) });
        if (!page.ok) throw new Error(page.code);
        last = page.value;
        work.r2Reads += browse.reads;
      } finally {
        browse.close();
      }
      work.pages++;
      paths.push(...last.paths);
      if (last.next === null) break;
      cursor = last.next;
    }
    const rows = r.git.context.storage.sql
      .exec("SELECT state, slices, visited, bytes FROM path_lists")
      .toArray();
    return { work, paths, last: last as PathsPage, lists: rows };
  });
}

beforeAll(async () => {
  target = await pushTarget();
  const { head, bytes } = await pack();
  const reply = await postPush(
    target,
    concat([pushBody([{ old: ZERO, new: oidToHex(head), ref: "refs/heads/main" }]), bytes]),
  );
  expect(reply.report.filter((line) => line.startsWith("ng"))).toEqual([]);
  // All ASCII, files only: git's order is the paths' own.
  expected = wide30kDirectories()
    .flatMap((d) => d.files.map((f) => `${d.path}/${f}`))
    .sort();
});

describe("the wide-30k workload", () => {
  it("is what it says it is", () => {
    expect(wide30kDirectories()).toHaveLength(600);
    expect(expected).toHaveLength(30_000);
    const average = expected.reduce((n, p) => n + p.length, 0) / expected.length;
    expect(Math.round(average)).toBe(30);
  });

  it("first opens in three slices and six rows written; later opens read and write nothing", async () => {
    const first = await open();
    expect(first.last).toMatchObject({ state: "complete", visited: 30_000, totalPaths: 30_000 });
    expect(first.paths).toEqual(expected);
    expect(first.work.pages).toBe(3);
    expect(first.lists).toMatchObject([{ state: "complete", slices: 3, visited: 30_000 }]);
    expect(first.work.rowsWritten).toBe(6);
    expect(first.work.r2Reads).toBeLessThanOrEqual(MAX_R2_READS);
    expect(first.work.slices).toBe(3);
    expect(first.work.trees).toBe(TREES_READ);

    const again = await open();
    expect(again.paths).toEqual(expected);
    expect(again.work.pages).toBe(3);
    expect(again.work.slices).toBe(0);
    expect(again.work.rowsWritten).toBe(0);
    expect(again.work.r2Reads).toBe(0);
    // The list row and a segment, for each of three pages.
    expect(again.work.rowsRead).toBe(6);
  });
});
