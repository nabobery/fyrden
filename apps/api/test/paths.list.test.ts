// A tree's file paths in pages: the walk resumed from a cursor alone, stored
// lists that only save work, the caps and their reasons, and what a forged
// cursor, a lost list, a restore, a failed write or busy memory can and
// cannot change. Most cases run `PathLists` in a real repository object's
// SQLite over hand-built trees; the REST cases run a pushed repository and
// compare with `git ls-tree -r`.

import { exports } from "cloudflare:workers";
import { MemoryWaitTimeoutError } from "@fyrden/adapters-cloudflare/git";
import {
  compareTreeEntries,
  encodeTree,
  type MemoryBudget,
  type Oid,
  oidFromHex,
  oidToHex,
  ReaderWorkSpent,
  type TreeEntry,
} from "@fyrden/git-core";
import fc from "fast-check";
import { beforeAll, describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { fail } from "../src/do/repo/browse.js";
import {
  PATHS_POLICY,
  type PathBrowse,
  type PathCursor,
  type PathListHooks,
  PathLists,
  type PathsPage,
  type PathsPolicy,
} from "../src/do/repo/path-lists.js";
import { ORIGIN } from "./helpers/git-http.js";
import { commit, concat, object, packOf } from "./helpers/pack-build.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush, pushTarget } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo, newRepo } from "./helpers/repo-git.js";

const fx = inject("browseFixtures");

const enc = new TextEncoder();
const FILE = 0o100644;
const TREE = 0o40000;
const LINK = 0o120000;
const GITLINK = 0o160000;

type Stub = DurableObjectStub<RepoDO>;
type Name = string | Uint8Array;
const nameBytes = (name: Name) => (typeof name === "string" ? enc.encode(name) : name);

/** Hand-built trees behind a reader: no pack, any names, and hooks on each read. */
class Trees {
  readonly bodies = new Map<string, Uint8Array>();
  #next = 1;
  headers = 0;
  /** Thrown instead of reading a tree, by hex id. */
  failing = new Map<string, Error>();

  add(entries: readonly TreeEntry[], sorted = true): Oid {
    const oid = new Uint8Array(20) as Oid;
    new DataView(oid.buffer).setUint32(0, this.#next++);
    const list = sorted ? [...entries].sort(compareTreeEntries) : [...entries];
    // By hand: `encodeTree` refuses a duplicate name, which a tree may still hold.
    this.bodies.set(
      oidToHex(oid),
      concat(
        list.flatMap((e) => [
          enc.encode(`${e.mode.toString(8)} `),
          e.name,
          Uint8Array.of(0),
          e.oid,
        ]),
      ),
    );
    return oid;
  }

  /** The tree holding `paths`; a name ending in `@` is a symlink, `#` a submodule. */
  of(paths: readonly Name[]): Oid {
    const dirs = new Map<string, Uint8Array[]>();
    const files: Uint8Array[] = [];
    for (const path of paths) {
      const bytes = nameBytes(path);
      const slash = bytes.indexOf(0x2f);
      if (slash < 0) files.push(bytes);
      else {
        const dir = String.fromCharCode(...bytes.subarray(0, slash));
        dirs.set(dir, [...(dirs.get(dir) ?? []), bytes.subarray(slash + 1)]);
      }
    }
    const blob = new Uint8Array(20).fill(0xbb) as Oid;
    return this.add([
      ...files.map((name): TreeEntry => ({ name, mode: FILE, oid: blob })),
      ...[...dirs].map(
        ([dir, below]): TreeEntry => ({
          name: Uint8Array.from(dir, (c) => c.charCodeAt(0)),
          mode: TREE,
          oid: this.of(below),
        }),
      ),
    ]);
  }

  reader() {
    const self = this;
    return {
      async readHeader(oid: Uint8Array) {
        self.headers++;
        const hex = oidToHex(oid as Oid);
        const failure = self.failing.get(hex);
        if (failure) throw failure;
        const body = self.bodies.get(hex);
        return body && { type: "tree" as const, size: body.length };
      },
      async readObject(oid: Uint8Array) {
        const body = self.bodies.get(oidToHex(oid as Oid));
        return body && { type: "tree" as const, bytes: body };
      },
      async prefetch() {},
    };
  }
}

const COMMIT = "c".repeat(40);

/** The browse request a `PathLists` page needs, over `trees`. */
function browseOf(trees: Trees, root: Oid, options: { tip?: boolean; reads?: () => number } = {}) {
  return {
    resolveTree: async (ref: string | undefined) =>
      ref === undefined || ref === COMMIT
        ? { ok: true as const, value: { commit: oidFromHex(COMMIT), tree: root } }
        : fail(404, "ref_not_found", "gone"),
    isDefaultTip: () => options.tip ?? true,
    reader: async () => trees.reader(),
    get reads() {
      return options.reads?.() ?? 0;
    },
  } as unknown as PathBrowse;
}

/** A repository object and the lists of one test, with its policy, epoch, memory and hooks. */
class Bench {
  policy: PathsPolicy = PATHS_POLICY;
  epoch = 1;
  memory: MemoryBudget | undefined;
  hooks: PathListHooks = {};
  logged: string[] = [];
  /** The object, while a page runs in it. */
  current: RepoDO | undefined;
  constructor(readonly stub: Stub) {}

  static async open(policy: Partial<PathsPolicy> = {}): Promise<Bench> {
    const bench = new Bench((await newRepo()).stub);
    bench.policy = { ...PATHS_POLICY, ...policy };
    return bench;
  }

  lists(r: RepoDO) {
    return new PathLists({
      git: { context: r.git.context, memory: this.memory ?? r.git.memory },
      epochGen: () => this.epoch,
      policy: () => this.policy,
      log: () => ({ warn: (message: string) => this.logged.push(message) }),
      hooks: this.hooks,
    });
  }

  page(browse: PathBrowse, input: { cursor?: PathCursor; perPage?: number } = {}) {
    return inRepo(this.stub, async (r) => {
      this.current = r;
      const page = await this.lists(r).page(browse, { perPage: 1000, ...input });
      if (!page.ok) throw new Error(`${page.status} ${page.code}`);
      return page.value;
    });
  }

  /** Every page from the start, `between` run after each. */
  async all(
    browse: PathBrowse,
    perPage: number,
    between?: (page: PathsPage) => Promise<void> | void,
  ) {
    const pages: PathsPage[] = [];
    let cursor: PathCursor | undefined;
    for (let i = 0; i < 100_000; i++) {
      const page = await this.page(browse, { perPage, ...(cursor && { cursor }) });
      pages.push(page);
      await between?.(page);
      if (page.next === null) break;
      cursor = page.next;
    }
    const last = pages.at(-1) as PathsPage;
    return {
      pages,
      last,
      paths: pages.flatMap((p) => p.paths),
      unlisted: pages.reduce((n, p) => n + p.unlistedNames, 0),
    };
  }

  rows() {
    return inRepo(this.stub, (r) => {
      const { sql } = r.git.context.storage;
      return {
        lists: sql
          .exec(
            "SELECT tree_sha, state, reason, cursor, visited, bytes, slices FROM path_lists ORDER BY seq",
          )
          .toArray(),
        segments: sql
          .exec(
            `SELECT tree_sha, first, count, length(body) AS size, hex(body) AS body
             FROM path_list_segments ORDER BY tree_sha, first`,
          )
          .toArray(),
      };
    });
  }

  forget() {
    return inRepo(this.stub, (r) => {
      r.git.context.storage.sql.exec("DELETE FROM path_lists");
      r.git.context.storage.sql.exec("DELETE FROM path_list_segments");
    });
  }
}

const numbered = (count: number, prefix = "f") =>
  Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(5, "0")}`);

/** `count` directories of one file each: at least `count + 1` trees, enough for a list to be kept. */
const dirs = (count: number) => numbered(count, "d").map((d) => `${d}/x`);

describe("a walk resumed from its cursor", () => {
  it("lists every path once, in git's order, at any page size and with the list lost between pages", async () => {
    const paths = [...dirs(40), ...numbered(30)];
    const trees = new Trees();
    const root = trees.of(paths);
    const bench = await Bench.open({ sliceEntries: 11 });
    const order = [...numbered(40, "d").map((d) => `${d}/x`), ...numbered(30)].sort(gitOrder);
    const kept = await bench.all(browseOf(trees, root), 1000);
    expect(kept.paths).toEqual(order);
    expect(kept.last).toMatchObject({ state: "complete", reason: null, visited: 70 });
    expect(kept.last.totalPaths).toBe(70);

    for (const perPage of [1, 2, 7, 11, 12, 69, 70, 71]) {
      const stored = await bench.all(browseOf(trees, root), perPage);
      expect(stored.paths, `stored ${perPage}`).toEqual(order);
      await bench.forget();
      const lost = await bench.all(browseOf(trees, root), perPage, () => bench.forget());
      expect(lost.paths, `lost ${perPage}`).toEqual(order);
      expect(lost.last).toMatchObject({ state: "complete", reason: null, visited: 70 });
    }
  });

  it("answers the same for random trees, page sizes and losses, against a plain walk", async () => {
    const bench = await Bench.open({ sliceEntries: 5 });
    const name = fc.stringMatching(/^[a-c.-]{1,3}$/);
    const spec: fc.Arbitrary<string[]> = fc
      .array(fc.array(name, { minLength: 1, maxLength: 4 }), { maxLength: 40 })
      .map((list) => [...new Set(list.map((parts) => parts.join("/")))]);
    await fc.assert(
      fc.asyncProperty(
        spec,
        fc.integer({ min: 1, max: 12 }),
        fc.boolean(),
        async (paths, perPage, lose) => {
          const usable = paths.filter((p) => !paths.some((q) => q !== p && q.startsWith(`${p}/`)));
          await bench.forget();
          const trees = new Trees();
          const root = trees.of(usable);
          const got = await bench.all(browseOf(trees, root), perPage, () =>
            lose ? bench.forget() : undefined,
          );
          expect(got.paths).toEqual(walkAll(trees, root));
          expect(got.last.state).toBe("complete");
        },
      ),
      { numRuns: 40 },
    );
  });

  it("lists symlinks and submodules, and no directories", async () => {
    const blob = new Uint8Array(20).fill(1) as Oid;
    const trees = new Trees();
    const sub = trees.add([{ name: enc.encode("x"), mode: FILE, oid: blob }]);
    const root = trees.add([
      { name: enc.encode("link"), mode: LINK, oid: blob },
      { name: enc.encode("mod"), mode: GITLINK, oid: blob },
      { name: enc.encode("dir"), mode: TREE, oid: sub },
    ]);
    const bench = await Bench.open();
    expect((await bench.all(browseOf(trees, root), 10)).paths).toEqual(["dir/x", "link", "mod"]);
  });

  it("answers a commit with an empty tree as complete, its object stored or not", async () => {
    const bench = await Bench.open();
    const trees = new Trees();
    const stored = await bench.page(browseOf(trees, trees.add([])));
    expect(stored).toMatchObject({ state: "complete", reason: null, paths: [], next: null });
    const magic = oidFromHex("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    const absent = await bench.page(browseOf(new Trees(), magic));
    expect(absent).toMatchObject({ state: "complete", reason: null, paths: [], next: null });
  });

  describe("over a malformed tree", () => {
    const blob = new Uint8Array(20).fill(1) as Oid;
    const entry = (name: string): TreeEntry => ({ name: enc.encode(name), mode: FILE, oid: blob });
    const cases: [string, string[]][] = [
      ["a duplicate name", ["a", "b", "b", "c"]],
      ["names out of order", ["a", "c", "b", "d"]],
      ["a name holding a slash", ["a", "b/x", "c"]],
    ];

    for (const [what, names] of cases)
      it(`ends at ${what}, at any page size, kept or walked`, async () => {
        for (const perPage of [1, 2, 1000]) {
          for (const tip of [true, false]) {
            const trees = new Trees();
            const inner = trees.add(names.map(entry), false);
            const root = trees.add(
              [entry("0"), { name: enc.encode("m"), mode: TREE, oid: inner }, entry("z")],
              false,
            );
            const bench = await Bench.open({ keepMinTrees: 0 });
            const got = await bench.all(browseOf(trees, root, { tip }), perPage);
            expect(got.paths, `${what} ${perPage} ${tip}`).toEqual(["0"]);
            expect(got.last).toMatchObject({
              state: "incomplete",
              reason: "malformed_tree",
              next: null,
            });
          }
        }
      });

    it("ends where directories out of order would make a cursor go round for ever", async () => {
      for (const tip of [true, false]) {
        const trees = new Trees();
        const empty = trees.add([]);
        const wide = (prefix: string) =>
          trees.add(
            numbered(1000, prefix).map(
              (name): TreeEntry => ({ name: enc.encode(name), mode: TREE, oid: empty }),
            ),
          );
        const dir = (name: string): TreeEntry => ({
          name: enc.encode(name),
          mode: TREE,
          oid: wide(name),
        });
        const root = trees.add(["a", "b", "d", "e", "c", "f"].map(dir), false);
        // Each directory's tree takes a slice's whole budget, so a slice moves one place on.
        const bodies = trees.bodies.get(oidToHex(root)) as Uint8Array;
        const size = (trees.bodies.get(oidToHex(wide("a"))) as Uint8Array).length;
        const bench = await Bench.open({ sliceTreeBytes: bodies.length + size + 1 });
        let cursor: PathCursor | undefined;
        let page: PathsPage | undefined;
        for (let i = 0; i < 40; i++) {
          page = await bench.page(browseOf(trees, root, { tip }), { ...(cursor && { cursor }) });
          if (page.next === null) break;
          cursor = page.next;
        }
        expect(page?.next, `tip ${tip}`).toBeNull();
        expect(page).toMatchObject({ state: "incomplete", reason: "malformed_tree", paths: [] });
      }
    });

    it("stores its answer as final, and answers it again without a read", async () => {
      const trees = new Trees();
      const root = trees.add([entry("b"), entry("a")], false);
      const bench = await Bench.open({ keepMinTrees: 0 });
      await bench.all(browseOf(trees, root), 10);
      expect((await bench.rows()).lists).toMatchObject([
        { state: "capped", reason: "malformed_tree", cursor: null },
      ]);
      const before = trees.headers;
      expect(await bench.page(browseOf(trees, root))).toMatchObject({
        state: "incomplete",
        reason: "malformed_tree",
      });
      expect(trees.headers).toBe(before);
    });

    it("takes a file and a directory of one name, which git's order tells apart", async () => {
      const trees = new Trees();
      const inner = trees.add([entry("x")]);
      const root = trees.add([
        entry("a"),
        { name: enc.encode("a"), mode: TREE, oid: inner },
        entry("b"),
      ]);
      const bench = await Bench.open();
      for (const perPage of [1, 10])
        expect((await bench.all(browseOf(trees, root), perPage)).paths).toEqual(["a", "a/x", "b"]);
    });
  });
});

describe("stored lists", () => {
  it("are kept only for the default branch's tip, and not when small", async () => {
    const trees = new Trees();
    const small = trees.of(numbered(30));
    const large = trees.of(dirs(20));
    const bench = await Bench.open();
    await bench.all(browseOf(trees, small), 10);
    expect((await bench.rows()).lists).toEqual([]);
    await bench.all(browseOf(trees, large, { tip: false }), 100);
    expect((await bench.rows()).lists).toEqual([]);
    await bench.all(browseOf(trees, large), 100);
    expect((await bench.rows()).lists).toMatchObject([{ state: "complete", visited: 20 }]);
  });

  it("keep a long list of few trees, since it does not finish in its first slice", async () => {
    const trees = new Trees();
    const root = trees.of(numbered(30));
    const bench = await Bench.open({ sliceEntries: 10 });
    await bench.all(browseOf(trees, root), 1000);
    const { lists, segments } = await bench.rows();
    expect(lists).toMatchObject([{ state: "complete", visited: 30, slices: 3 }]);
    expect(segments.map((s) => [s.first, s.count])).toEqual([
      [0, 10],
      [10, 10],
      [20, 10],
    ]);
  });

  it("answer from a segment without reading a tree, and writing nothing", async () => {
    const trees = new Trees();
    const root = trees.of(numbered(30));
    const bench = await Bench.open({ sliceEntries: 10 });
    await bench.all(browseOf(trees, root), 1000);
    const before = trees.headers;
    let read = 0;
    let written = 0;
    bench.hooks = {
      rows: (r, w) => {
        read += r;
        written += w;
      },
    };
    const again = await bench.all(browseOf(trees, root), 1000);
    expect(again.paths).toHaveLength(30);
    expect(again.pages).toHaveLength(3);
    expect(trees.headers).toBe(before);
    expect(written).toBe(0);
    expect(read).toBe(6);
  });

  it("write a segment and the list row per slice", async () => {
    const trees = new Trees();
    const root = trees.of(numbered(30));
    const bench = await Bench.open({ sliceEntries: 10 });
    let written = 0;
    bench.hooks = {
      rows: (_, w) => {
        written += w;
      },
    };
    await bench.all(browseOf(trees, root), 1000);
    expect(written).toBe(6);
  });

  it("answer `more_pages` from an earlier segment of a complete and of a capped list", async () => {
    const trees = new Trees();
    const root = trees.of(numbered(30));
    for (const [policy, state] of [
      [{ sliceEntries: 10 }, "complete"],
      [{ sliceEntries: 10, maxPaths: 25 }, "capped"],
    ] as const) {
      const bench = await Bench.open(policy);
      await bench.all(browseOf(trees, root), 1000);
      expect((await bench.rows()).lists).toMatchObject([{ state }]);
      const first = await bench.page(browseOf(trees, root));
      expect(first).toMatchObject({ state: "incomplete", reason: "more_pages", visited: 10 });
      expect(first.next).not.toBeNull();
      const second = await bench.page(browseOf(trees, root), {
        cursor: first.next as PathCursor,
      });
      expect(second).toMatchObject({ state: "incomplete", reason: "more_pages", visited: 20 });
    }
  });

  it("answer a page ending at an unfinished build's frontier with only its stored paths", async () => {
    const trees = new Trees();
    const root = trees.of(numbered(30));
    const bench = await Bench.open({ sliceEntries: 10 });
    await bench.page(browseOf(trees, root));
    expect((await bench.rows()).lists).toMatchObject([{ state: "building", visited: 10 }]);
    const before = trees.headers;
    const stored = await bench.page(browseOf(trees, root));
    expect(stored.paths).toHaveLength(10);
    expect(stored).toMatchObject({ state: "incomplete", reason: "more_pages", visited: 10 });
    expect(trees.headers).toBe(before);
    // Only the next request, at the frontier, walks.
    const next = await bench.page(browseOf(trees, root), { cursor: stored.next as PathCursor });
    expect(next.paths).toEqual(numbered(30).slice(10, 20));
    expect((await bench.rows()).lists).toMatchObject([{ state: "building", visited: 20 }]);
  });

  it("stop being written past their build's slices, and answers go on by walking", async () => {
    const trees = new Trees();
    const root = trees.of(numbered(30));
    const bench = await Bench.open({ sliceEntries: 10, maxBuildSlices: 2 });
    const got = await bench.all(browseOf(trees, root), 1000);
    expect(got.paths).toEqual(numbered(30));
    expect(got.last).toMatchObject({ state: "complete", totalPaths: null });
    const { lists, segments } = await bench.rows();
    expect(lists).toMatchObject([{ state: "walk_only", visited: 20, slices: 2, cursor: null }]);
    expect(segments).toHaveLength(2);
    // Read again: its segments, then the walk from where they end.
    const stored = await bench.page(browseOf(trees, root));
    expect(stored).toMatchObject({ state: "incomplete", reason: "more_pages", visited: 10 });
    expect((await bench.all(browseOf(trees, root), 7)).paths).toEqual(numbered(30));
    expect((await bench.rows()).segments).toHaveLength(2);
  });

  it("evict the oldest past two lists, or past the bytes, never the current one", async () => {
    const trees = new Trees();
    const roots = ["a", "b", "c"].map((p) => trees.of(numbered(20, p).map((f) => `${f}/x`)));
    const bench = await Bench.open();
    for (const root of roots) await bench.all(browseOf(trees, root), 100);
    let { lists, segments } = await bench.rows();
    expect(lists.map((l) => l.tree_sha)).toEqual(roots.slice(1).map(oidToHex));
    expect(new Set(segments.map((s) => s.tree_sha))).toEqual(new Set(roots.slice(1).map(oidToHex)));
    bench.policy = { ...bench.policy, maxKeptBytes: 200 };
    const fresh = trees.of(numbered(20, "e").map((f) => `${f}/x`));
    await bench.all(browseOf(trees, fresh), 100);
    ({ lists, segments } = await bench.rows());
    expect(lists.map((l) => l.tree_sha)).toEqual([oidToHex(fresh)]);
    expect(new Set(segments.map((s) => s.tree_sha))).toEqual(new Set([oidToHex(fresh)]));
  });

  it("are retired when a cap changes: the limits are part of their key", async () => {
    const trees = new Trees();
    const root = trees.of(dirs(20));
    const bench = await Bench.open();
    await bench.all(browseOf(trees, root), 100);
    bench.policy = { ...bench.policy, maxPaths: 10 };
    const capped = await bench.all(browseOf(trees, root), 100);
    expect(capped.paths).toHaveLength(10);
    expect(capped.last).toMatchObject({ state: "incomplete", reason: "too_many_paths" });
  });

  it("let one of two concurrent readers keep a slice; both answers are right", async () => {
    const trees = new Trees();
    const root = trees.of(numbered(30));
    const bench = await Bench.open({ sliceEntries: 10 });
    let inner: PathsPage | undefined;
    const pending = { used: false };
    bench.hooks = {
      beforeKeep: async () => {
        if (pending.used) return;
        pending.used = true;
        // Another request walks the same slice and keeps it first.
        const page = await bench
          .lists(bench.current as RepoDO)
          .page(browseOf(trees, root), { perPage: 1000 });
        if (page.ok) inner = page.value;
      },
    };
    const outer = await bench.page(browseOf(trees, root));
    expect(outer.paths).toEqual(numbered(30).slice(0, 10));
    expect(inner?.paths).toEqual(numbered(30).slice(0, 10));
    const { lists, segments } = await bench.rows();
    expect(lists).toMatchObject([{ state: "building", visited: 10, slices: 1 }]);
    expect(segments).toHaveLength(1);
  });

  it("answer even when keeping fails, counted and logged", async () => {
    const trees = new Trees();
    const root = trees.of(numbered(30));
    const bench = await Bench.open({ sliceEntries: 10 });
    bench.hooks = {
      beforeKeep: () => {
        throw new Error("the day's writes are spent");
      },
    };
    const got = await bench.all(browseOf(trees, root), 1000);
    expect(got.paths).toEqual(numbered(30));
    expect(got.last.state).toBe("complete");
    expect((await bench.rows()).lists).toEqual([]);
    expect(bench.logged).toContain("keeping a path list failed");
  });

  it("across a restore: drop a build of an old epoch, serve a complete list, 404 a gone commit", async () => {
    const trees = new Trees();
    const root = trees.of(numbered(30));
    const bench = await Bench.open({ sliceEntries: 10 });
    const first = await bench.page(browseOf(trees, root));
    expect((await bench.rows()).lists).toMatchObject([{ state: "building" }]);
    bench.epoch = 2;
    // The client's own cursor still works; the old build is gone when found.
    const next = await bench.page(browseOf(trees, root), { cursor: first.next as PathCursor });
    expect(next.paths).toEqual(numbered(30).slice(10, 20));
    expect((await bench.rows()).lists).toEqual([]);
    const whole = await bench.all(browseOf(trees, root), 1000);
    expect(whole.paths).toEqual(numbered(30));
    expect((await bench.rows()).lists).toMatchObject([{ state: "complete" }]);
    bench.epoch = 3;
    const before = trees.headers;
    await bench.all(browseOf(trees, root), 1000);
    expect(trees.headers).toBe(before);
    await expect(
      bench.page(browseOf(trees, root), {
        cursor: { c: "d".repeat(40), n: 0, b: 0, w: null },
      }),
    ).rejects.toThrow("404 ref_not_found");
  });
});

describe("caps and limits", () => {
  const paths = numbered(30);

  it("end a list at the same path for any page size, kept or walked", async () => {
    for (const [policy, reason, count] of [
      [{ maxPaths: 12 }, "too_many_paths", 12],
      [{ maxListBytes: 12 * 7 + 3 }, "too_many_bytes", 12],
    ] as const) {
      for (const perPage of [1, 5, 1000]) {
        for (const tip of [true, false]) {
          const trees = new Trees();
          const root = trees.of(paths);
          const bench = await Bench.open({ sliceEntries: 5, ...policy });
          const got = await bench.all(browseOf(trees, root, { tip }), perPage);
          expect(got.paths, `${reason} ${perPage} ${tip}`).toEqual(paths.slice(0, count));
          expect(got.last).toMatchObject({ state: "incomplete", reason, next: null });
        }
      }
    }
  });

  it("do not fire on a tree of exactly the cap", async () => {
    const trees = new Trees();
    const root = trees.of(paths);
    const bench = await Bench.open({ sliceEntries: 10, maxPaths: 30, maxListBytes: 30 * 7 });
    const got = await bench.all(browseOf(trees, root), 7);
    expect(got.paths).toEqual(paths);
    expect(got.last).toMatchObject({ state: "complete", reason: null });
  });

  it("never let a segment pass a slice's bytes, nor a list its bytes", async () => {
    const trees = new Trees();
    const root = trees.of(numbered(100));
    const bench = await Bench.open({ sliceBytes: 50, maxListBytes: 500 });
    const got = await bench.all(browseOf(trees, root), 1000);
    expect(got.last.reason).toBe("too_many_bytes");
    const { lists, segments } = await bench.rows();
    for (const segment of segments) expect((segment.size as number) + 1).toBeLessThanOrEqual(50);
    expect(lists[0]?.bytes as number).toBeLessThanOrEqual(500);
    // The separators between paths and the charge per path agree.
    expect(segments.reduce((n, s) => n + (s.size as number) + 1, 0)).toBe(lists[0]?.bytes);
  });

  it("name a tree too large, too deep or a path too long, keeping what came before", async () => {
    const blob = new Uint8Array(20).fill(1) as Oid;
    const file = (name: string): TreeEntry => ({ name: enc.encode(name), mode: FILE, oid: blob });
    const treeOf = (name: string, oid: Oid): TreeEntry => ({
      name: enc.encode(name),
      mode: TREE,
      oid,
    });

    const wide = new Trees();
    const large = wide.add(numbered(100).map(file));
    const root = wide.add([file("a"), treeOf("m", large), file("z")]);
    const one = await Bench.open({ maxTreeBytes: 500 });
    const tooLarge = await one.all(browseOf(wide, root), 10);
    expect(tooLarge.paths).toEqual(["a"]);
    expect(tooLarge.last).toMatchObject({ state: "incomplete", reason: "tree_too_large" });

    const deep = new Trees();
    let at = deep.add([file("x")]);
    for (let i = 0; i < 4; i++) at = deep.add([treeOf("d", at)]);
    const top = deep.add([file("a"), treeOf("d", at)]);
    const two = await Bench.open({ maxDepth: 3 });
    const tooDeep = await two.all(browseOf(deep, top), 10);
    expect(tooDeep.paths).toEqual(["a"]);
    expect(tooDeep.last).toMatchObject({ state: "incomplete", reason: "too_deep" });

    const long = new Trees();
    const longRoot = long.add([file("a"), file(`b${"x".repeat(50)}`)]);
    const three = await Bench.open({ maxPathBytes: 20 });
    const tooLong = await three.all(browseOf(long, longRoot), 10);
    expect(tooLong.paths).toEqual(["a"]);
    expect(tooLong.last).toMatchObject({ state: "incomplete", reason: "path_too_long" });
  });

  it("say too_much_work when a slice cannot pass its cursor's own path", async () => {
    const trees = new Trees();
    const root = trees.of(dirs(5));
    const bench = await Bench.open({ walkReads: 0 });
    const page = await bench.page(browseOf(trees, root));
    expect(page).toMatchObject({
      state: "incomplete",
      reason: "too_much_work",
      paths: [],
      next: null,
    });
    expect((await bench.rows()).lists).toEqual([]);
  });

  it("carry on through slices spent on directories with no file, kept or walked", async () => {
    const blob = new Uint8Array(20).fill(1) as Oid;
    for (const tip of [true, false]) {
      const trees = new Trees();
      const root = trees.add([
        ...numbered(10, "d").map(
          (name): TreeEntry => ({ name: enc.encode(name), mode: TREE, oid: trees.add([]) }),
        ),
        { name: enc.encode("z"), mode: FILE, oid: blob },
      ]);
      let reads = 0;
      const reader = trees.reader();
      const header = reader.readHeader;
      reader.readHeader = (oid) => {
        reads++;
        return header(oid);
      };
      const counting = browseOf(trees, root, { tip, reads: () => reads });
      (counting as { reader: unknown }).reader = async () => reader;
      const bench = await Bench.open({ walkReads: 3 });
      const pages: PathsPage[] = [];
      let cursor: PathCursor | undefined;
      for (let i = 0; i < 20; i++) {
        reads = 0;
        const page = await bench.page(counting, { ...(cursor && { cursor }) });
        pages.push(page);
        if (page.next === null) break;
        cursor = page.next;
      }
      expect(pages[0]).toMatchObject({ paths: [], state: "incomplete", reason: "more_pages" });
      expect(pages[0]?.visited).toBe(0);
      expect(pages.flatMap((p) => p.paths)).toEqual(["z"]);
      expect(pages.at(-1)).toMatchObject({ state: "complete", visited: 1 });
      expect(pages.length).toBeGreaterThan(2);
      expect((await bench.rows()).lists).toHaveLength(tip ? 1 : 0);
    }
  });

  it("bound a page's JSON, whatever its names escape to, holding one path at least", async () => {
    const control = (i: number) =>
      Uint8Array.from({ length: 200 }, (_, k) => (k < 5 ? 0x61 + ((i >> (k * 4)) & 15) : 1));
    const names = Array.from({ length: 2500 }, (_, i) => control(i));
    const trees = new Trees();
    const root = trees.of(names);
    const bench = await Bench.open({ maxPageJsonBytes: 64 * 1024 });
    const got = await bench.all(browseOf(trees, root), 10_000);
    for (const page of got.pages)
      expect(JSON.stringify(page.paths).length).toBeLessThanOrEqual(64 * 1024);
    expect(got.paths).toHaveLength(2500);
    expect(new Set(got.paths).size).toBe(2500);
    const tiny = await Bench.open({ maxPageJsonBytes: 1 });
    const one = await tiny.page(browseOf(trees, root), { perPage: 10_000 });
    expect(one.paths).toHaveLength(1);
  });
});

describe("names that are not valid UTF-8", () => {
  const bad = (i: number) => Uint8Array.from([0xff, 0x61 + i]);

  it("are left out and counted on the page that consumed them, however it is cut", async () => {
    const names: Name[] = [...numbered(5, "a"), bad(0), bad(1), ...numbered(5, "z")];
    const good = [...numbered(5, "a"), ...numbered(5, "z")];
    for (const perPage of [1, 3, 100]) {
      for (const sliceEntries of [2, 4, 100]) {
        const trees = new Trees();
        const root = trees.of(names);
        const bench = await Bench.open({ sliceEntries, keepMinTrees: 0 });
        const got = await bench.all(browseOf(trees, root), perPage);
        expect(got.paths).toEqual(good);
        expect(got.unlisted).toBe(2);
        expect(got.last.visited).toBe(12);
        expect(got.last.state).toBe("complete");
        // From the stored list, the same.
        const again = await bench.all(browseOf(trees, root), perPage);
        expect(again.paths).toEqual(good);
        expect(again.unlisted).toBe(2);
      }
    }
  });

  it("count in whole slices of them, with exact totals", async () => {
    const names = Array.from({ length: 12 }, (_, i) => bad(i));
    const trees = new Trees();
    const root = trees.of(names);
    const bench = await Bench.open({ sliceEntries: 5 });
    const got = await bench.all(browseOf(trees, root), 100);
    expect(got.paths).toEqual([]);
    expect(got.unlisted).toBe(12);
    expect(got.last).toMatchObject({ state: "complete", visited: 12, totalPaths: 12 });
    const stored = await bench.all(browseOf(trees, root), 100);
    expect(stored.unlisted).toBe(12);
    expect(stored.last.totalPaths).toBe(12);
    expect((await bench.rows()).segments).toHaveLength(3);
  });
});

describe("forged cursors", () => {
  it("never change kept rows", async () => {
    const trees = new Trees();
    const root = trees.of(numbered(30));
    const bench = await Bench.open({ sliceEntries: 10 });
    await bench.page(browseOf(trees, root));
    const before = await bench.rows();
    const forged: PathCursor[] = [
      { c: COMMIT, n: 10, b: 0, w: [btoa("f00025"), 0] },
      { c: COMMIT, n: 10, b: 999_999, w: null },
      { c: COMMIT, n: 3, b: 0, w: [btoa("zzz"), 0] },
      { c: COMMIT, n: 500, b: 0, w: [btoa("f00001"), 0] },
    ];
    for (const cursor of forged.slice(2)) {
      await bench.page(browseOf(trees, root), { cursor });
      expect(await bench.rows(), JSON.stringify(cursor)).toEqual(before);
    }
    // At the frontier a build goes on from its own position, whatever the cursor says.
    for (const cursor of forged.slice(0, 2)) {
      await bench.page(browseOf(trees, root), { cursor });
      const { segments } = await bench.rows();
      expect(segments.map((s) => s.first)).toEqual([0, 10]);
      const stored = await bench.page(browseOf(trees, root), {
        cursor: { c: COMMIT, n: 10, b: 0, w: null },
      });
      expect(stored.paths).toEqual(numbered(30).slice(10, 20));
      await bench.forget();
      await bench.page(browseOf(trees, root));
    }
  });

  it("past a finished list's end are refused", async () => {
    const trees = new Trees();
    const root = trees.of(dirs(20));
    const bench = await Bench.open();
    await bench.all(browseOf(trees, root), 100);
    await expect(
      bench.page(browseOf(trees, root), { cursor: { c: COMMIT, n: 21, b: 0, w: null } }),
    ).rejects.toThrow("422 invalid_cursor");
    // Exactly at the end: the list's answer, nothing read.
    const before = trees.headers;
    const end = await bench.page(browseOf(trees, root), {
      cursor: { c: COMMIT, n: 20, b: 0, w: null },
    });
    expect(end).toMatchObject({ state: "complete", paths: [], next: null, totalPaths: 20 });
    expect(trees.headers).toBe(before);
  });
});

describe("memory and unreadable objects", () => {
  const noMemory: MemoryBudget = {
    reserve: async () => {
      throw new MemoryWaitTimeoutError(0, 0);
    },
    tryReserve: () => undefined,
  };

  it("busy memory answers `busy`, repeating the position, and stores nothing", async () => {
    const trees = new Trees();
    const root = trees.of(numbered(30));
    const bench = await Bench.open({ sliceEntries: 10 });
    const first = await bench.page(browseOf(trees, root));
    const before = await bench.rows();
    bench.memory = noMemory;
    const busy = await bench.page(browseOf(trees, root), { cursor: first.next as PathCursor });
    expect(busy).toMatchObject({ state: "unavailable", reason: "busy", paths: [], visited: 10 });
    expect(busy.next).toEqual(first.next);
    expect(busy.retryAfterMs).toBeGreaterThan(0);
    expect(await bench.rows()).toEqual(before);
    bench.memory = undefined;
    const after = await bench.page(browseOf(trees, root), { cursor: busy.next as PathCursor });
    expect(after.paths).toEqual(numbered(30).slice(10, 20));
  });

  it("busy memory at the start of a walk answers `busy`, with no position to repeat", async () => {
    const trees = new Trees();
    const root = trees.of(["a"]);
    const bench = await Bench.open();
    bench.memory = noMemory;
    const before = trees.headers;
    const start = await bench.page(browseOf(trees, root, { tip: false }));
    expect(start).toMatchObject({ state: "unavailable", reason: "busy", paths: [], next: null });
    // It got as far as the tree: no stored list answered.
    expect(trees.headers).toBe(before + 1);
    expect((await bench.rows()).lists).toEqual([]);
  });

  it("a stored page holds its memory too", async () => {
    const trees = new Trees();
    const root = trees.of(numbered(30));
    const bench = await Bench.open({ sliceEntries: 10 });
    await bench.all(browseOf(trees, root), 1000);
    bench.memory = noMemory;
    const busy = await bench.page(browseOf(trees, root));
    expect(busy).toMatchObject({ state: "unavailable", reason: "busy", paths: [] });
  });

  it("memory running out in a slice ends it with what it has", async () => {
    const trees = new Trees();
    const root = trees.of(numbered(9000));
    const bench = await Bench.open();
    let free = 1;
    let held = 0;
    bench.memory = {
      reserve: async (bytes) => ({ bytes, release() {} }),
      tryReserve(bytes) {
        // The tree's read, then one block of paths.
        if (bytes === 1024 * 1024 && free-- <= 0) return undefined;
        held += bytes;
        return {
          bytes,
          release() {
            held -= bytes;
          },
        };
      },
    };
    const page = await bench.page(browseOf(trees, root), { perPage: 10_000 });
    expect(page).toMatchObject({ state: "incomplete", reason: "more_pages" });
    // One block holds this many paths of 6 bytes at 2 x 6 + 1200 + 100 x 1 bytes each.
    expect(page.paths).toHaveLength(Math.floor((1024 * 1024) / 1312));
    expect(held).toBe(0);
  });

  it("charges each path to the memory budget and releases it all when the slice ends", async () => {
    const trees = new Trees();
    const root = trees.of(numbered(30_000));
    const bench = await Bench.open({ sliceEntries: 20_000, maxPageJsonBytes: 10_000_000 });
    let blocks = 0;
    let held = 0;
    bench.memory = {
      reserve: async (bytes) => ({ bytes, release() {} }),
      tryReserve(bytes) {
        if (bytes === 1024 * 1024) blocks++;
        held += bytes;
        return {
          bytes,
          release() {
            held -= bytes;
          },
        };
      },
    };
    await bench.page(browseOf(trees, root), { perPage: 10_000 });
    // 20,000 paths at 2 x 6 + 1200 + 100 bytes each: just over 25 MiB.
    expect(blocks).toBe(26);
    expect(held).toBe(0);
  });

  it("a tree that cannot be read answers `unreadable`, and nothing is stored as final", async () => {
    const trees = new Trees();
    const root = trees.of(["a/x", "b/x"]);
    const blob = new Uint8Array(20).fill(1) as Oid;
    const missing = new Uint8Array(20).fill(0xee) as Oid;
    const broken = trees.add([
      { name: enc.encode("a"), mode: FILE, oid: blob },
      { name: enc.encode("b"), mode: TREE, oid: missing },
    ]);
    const bench = await Bench.open();
    const page = await bench.page(browseOf(trees, broken));
    expect(page).toMatchObject({ state: "unavailable", reason: "unreadable", paths: [] });
    expect(page.next).toBeNull();
    expect((await bench.rows()).lists).toEqual([]);
    expect((await bench.all(browseOf(trees, root), 10)).paths).toEqual(["a/x", "b/x"]);
  });

  it("the reader's own budgets defer the slice, its memory wait answers `busy`", async () => {
    const trees = new Trees();
    const root = trees.of(dirs(4));
    const bench = await Bench.open();
    trees.failing.set(oidToHex(root), new ReaderWorkSpent(1));
    expect(await bench.page(browseOf(trees, root))).toMatchObject({
      state: "incomplete",
      reason: "too_much_work",
    });
    trees.failing.set(oidToHex(root), new MemoryWaitTimeoutError(0, 0));
    expect(await bench.page(browseOf(trees, root))).toMatchObject({
      state: "unavailable",
      reason: "busy",
    });
  });
});

/** `paths` in git's order: a directory sorts as if named with its slash, which a plain sort gives. */
function gitOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A plain recursive walk of `root`. */
function walkAll(trees: Trees, root: Oid): string[] {
  const text = new TextDecoder();
  const out: string[] = [];
  const walk = (oid: Oid, prefix: string) => {
    const body = trees.bodies.get(oidToHex(oid)) as Uint8Array;
    let at = 0;
    while (at < body.length) {
      const space = body.indexOf(0x20, at);
      const nul = body.indexOf(0, space);
      const mode = Number.parseInt(text.decode(body.subarray(at, space)), 8);
      const name = text.decode(body.subarray(space + 1, nul));
      const child = body.slice(nul + 1, nul + 21) as Oid;
      at = nul + 21;
      if (mode === TREE) walk(child, `${prefix}${name}/`);
      else out.push(`${prefix}${name}`);
    }
  };
  walk(root, "");
  return out;
}

describe("repos.paths.list", () => {
  let target: PushTarget;
  let pat: string;
  let base: string;
  const order = () => fx.trees.files.map((f) => f.path);

  async function get(query: string, token = pat) {
    const res = await exports.default.fetch(`${ORIGIN}/api${base}/paths${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { status: res.status, body: await res.json<Record<string, unknown>>() };
  }

  type Answer = {
    commit: string;
    tree: string;
    state: string;
    reason: string | null;
    paths: string[];
    visited: number;
    total_paths: number | null;
    unlisted_names: number;
    next_cursor: string | null;
    retry_after_ms: number | null;
  };

  async function all(query: string, perPage: number, cursor?: string) {
    const paths: string[] = [];
    const cursors: string[] = [];
    let last: Answer | undefined;
    let next = cursor;
    for (let i = 0; i < 1000; i++) {
      const q = new URLSearchParams(query);
      q.set("per_page", String(perPage));
      if (next !== undefined) q.set("cursor", next);
      const { status, body } = await get(`?${q}`);
      expect(status).toBe(200);
      last = body as unknown as Answer;
      paths.push(...last.paths);
      if (last.next_cursor === null) break;
      next = last.next_cursor;
      cursors.push(next);
    }
    return { paths, cursors, last: last as Answer };
  }

  beforeAll(async () => {
    target = await pushTarget();
    pat = await scopedToken(target.owner.principalId, [], "pat");
    const reply = await postPush(
      target,
      pushBody(
        fx.refs.map((r) => ({ old: ZERO, new: r.oid, ref: r.name })),
        { pack: fx.packHex },
      ),
    );
    expect(reply.report.filter((line) => line.startsWith("ng"))).toEqual([]);
    base = `/repos/${target.owner.principalId.toLowerCase().replace("_", "-")}/${target.repo.name}`;
  });

  it("lists what `git ls-tree -r` lists, and each cursor resumes to the same list", async () => {
    const expected = order();
    const whole = await all("", 1000);
    expect(whole.paths).toEqual(expected);
    expect(whole.last).toMatchObject({
      state: "complete",
      reason: null,
      unlisted_names: 0,
      next_cursor: null,
      retry_after_ms: null,
      visited: expected.length,
      commit: fx.revs.main,
      tree: fx.commits[fx.revs.main as string]?.tree,
    });
    const single = await all("", 1);
    expect(single.paths).toEqual(expected);
    for (const [i, cursor] of single.cursors.entries()) {
      const rest = await all("", 11, cursor);
      expect(rest.paths, `after ${i + 1}`).toEqual(expected.slice(i + 1));
    }
  });

  it("takes a branch, a tag or a commit; a cursor pins its commit, whatever `ref` says", async () => {
    const tagged = await all("ref=v1", 1000);
    expect(tagged.last.commit).toBe(fx.revs.v1);
    expect(tagged.paths).toContain("src/lib/util.ts");
    expect((await all(`ref=${fx.revs.main}`, 1000)).paths).toEqual(order());
    const first = await get(`?ref=v1&per_page=1`);
    const q = new URLSearchParams({
      ref: "main",
      per_page: "1000",
      cursor: (first.body as unknown as Answer).next_cursor as string,
    });
    const next = (await get(`?${q}`)).body as unknown as Answer;
    expect(next.commit).toBe(fx.revs.v1);
    expect(next.paths).toEqual(tagged.paths.slice(1));
  });

  it("answers 404 for a ref or a cursor's commit it does not have, a sibling's too", async () => {
    expect(await get("?ref=missing")).toMatchObject({
      status: 404,
      body: { code: "ref_not_found" },
    });
    const cursor = cursorText({ c: fx.siblingCommit, n: 0, b: 0, w: null });
    expect(await get(`?cursor=${cursor}`)).toMatchObject({
      status: 404,
      body: { code: "ref_not_found" },
    });
  });

  it("refuses a cursor it could not have returned", async () => {
    const c = fx.revs.main as string;
    for (const cursor of [
      "not base64!",
      btoa("not json"),
      cursorText({ c: "short", n: 0, b: 0, w: null }),
      cursorText({ c: c.toUpperCase(), n: 0, b: 0, w: null }),
      cursorText({ c, n: -1, b: 0, w: null }),
      cursorText({ c, n: 1.5, b: 0, w: null }),
      cursorText({ c, n: 0, b: 2 ** 60, w: null }),
      cursorText({ c, n: 0, b: 0 }),
      cursorText({ c, n: 0, b: 0, w: ["***", 0] }),
      cursorText({ c, n: 0, b: 0, w: [btoa("a"), 3] }),
      cursorText({ c, n: 0, b: 0, w: [btoa("a//b"), 0] }),
      cursorText({ c, n: 0, b: 0, w: [btoa(""), 0] }),
      cursorText({ c, n: 0, b: 0, w: [btoa("x".repeat(4097)), 0] }),
      cursorText({ c, n: 0, b: 0, w: [btoa("a"), 0], extra: 1 }),
      cursorText([c, 0, 0, null]),
    ])
      expect(await get(`?cursor=${encodeURIComponent(cursor)}`), cursor).toMatchObject({
        status: 422,
        body: { code: "invalid_cursor" },
      });
    expect((await get("?per_page=0")).status).toBeGreaterThanOrEqual(400);
    expect((await get("?per_page=10001")).status).toBeGreaterThanOrEqual(400);
  });

  it("needs contents:read on every page", async () => {
    const other = await scopedToken((await pushTarget()).owner.principalId, [], "pat");
    expect((await get("", other)).status).toBe(404);
    const first = (await get("?per_page=1")).body as unknown as Answer;
    const q = new URLSearchParams({ cursor: first.next_cursor as string });
    expect((await get(`?${q}`, other)).status).toBe(404);
    const restricted = await scopedToken(target.owner.principalId, ["issues:read"], "pat");
    expect((await get("", restricted)).status).toBe(403);
    expect((await get(`?${q}`, restricted)).status).toBe(403);
  });

  it("spends the built-bytes budget on real objects as work, not as a failure", async () => {
    await inRepo(target.repo.stub, (r) => {
      r.pathsPolicy = { ...r.pathsPolicy, maxBuiltBytes: 1 };
    });
    try {
      expect((await get("?ref=main")).body).toMatchObject({
        state: "incomplete",
        reason: "too_much_work",
      });
      // Peeling an annotated tag spends it before any tree: an error, there being no commit to name.
      expect(await get("?ref=v1")).toMatchObject({
        status: 422,
        body: { code: "too_expensive" },
      });
    } finally {
      await inRepo(target.repo.stub, (r) => {
        r.pathsPolicy = PATHS_POLICY;
      });
    }
  });

  it("lists a pushed tree with names not valid UTF-8", async () => {
    const pushed = await pushTarget();
    const token = await scopedToken(pushed.owner.principalId, [], "pat");
    const blob = await object("blob", enc.encode("x\n"));
    const tree = await object(
      "tree",
      encodeTree(
        [Uint8Array.from([0xff, 0x61]), enc.encode("ok.txt")]
          .map((name): TreeEntry => ({ name, mode: FILE, oid: blob.oid }))
          .sort(compareTreeEntries),
      ),
    );
    const c = await commit(tree.oid, [], 1_700_000_000, "names");
    const reply = await postPush(
      pushed,
      concat([
        pushBody([{ old: ZERO, new: oidToHex(c.oid), ref: "refs/heads/main" }]),
        await packOf([c, tree, blob]),
      ]),
    );
    expect(reply.report.filter((line) => line.startsWith("ng"))).toEqual([]);
    const owner = pushed.owner.principalId.toLowerCase().replace("_", "-");
    const res = await exports.default.fetch(
      `${ORIGIN}/api/repos/${owner}/${pushed.repo.name}/paths`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(await res.json()).toMatchObject({
      state: "complete",
      paths: ["ok.txt"],
      unlisted_names: 1,
      visited: 2,
    });
  });

  it("is the MCP tool list_paths", async () => {
    const res = await exports.default.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pat}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "list_paths",
          arguments: {
            owner: base.split("/")[2],
            repo: base.split("/")[3],
            per_page: 3,
          },
        },
      }),
    });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain(order()[0]);
    expect(text).toContain("more_pages");
  });
});

/** A cursor's text, of any shape. */
function cursorText(value: unknown): string {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
