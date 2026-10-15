import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addPendingCommits } from "../../src/graph/commit-graph.js";
import { WalkLimitError } from "../../src/graph/errors.js";
import { parseCommit } from "../../src/object/commit.js";
import { type Oid, oidFromHex, oidToHex } from "../../src/object/oid.js";
import { logPage, type PathEntryLookup } from "../../src/read/log.js";
import { createMemoryCommitGraph } from "../../testing/fakes/memory-commit-graph.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";

/*
 * Differential tests against `git log [-- <path>]`: random histories with
 * merges, built with `git fast-import`, each commit setting a few files to
 * one of a few contents (so merges are often TREESAME to one parent on a
 * path). Commit dates rise with each commit, so git's date order is the
 * walk's generation order. Pages are small, so most logs span several.
 */

const SEED = 20261013;
const FILES = ["a.txt", "d/x.txt", "d/y.txt", "e/f/z.txt"];
const PATHS = ["", "a.txt", "d", "d/x.txt", "e", "e/f/z.txt", "nope", "d/x.txt/deeper"];

interface Spec {
  /** Parents of commit i are indexes below i. */
  parents: number[][];
  /** Per commit: file index → content index (0 deletes it). */
  edits: [number, number][][];
  /** Commit dates; rising by ten seconds per commit when absent. */
  dates?: number[];
}

let sandbox: GitSandbox;
let repoCount = 0;
beforeAll(async () => {
  sandbox = await createGitSandbox();
});
afterAll(() => sandbox.dispose());

const specArb: fc.Arbitrary<Spec> = fc
  .array(
    fc.record({
      count: fc.oneof(
        { weight: 1, arbitrary: fc.constant(0) },
        { weight: 6, arbitrary: fc.constant(1) },
        { weight: 3, arbitrary: fc.constant(2) },
        { weight: 1, arbitrary: fc.constant(3) },
      ),
      picks: fc.array(fc.nat(), { minLength: 3, maxLength: 3 }),
      edits: fc.array(fc.tuple(fc.nat(FILES.length - 1), fc.nat(3)), { maxLength: 3 }),
    }),
    { minLength: 1, maxLength: 24 },
  )
  .map((rows) => ({
    parents: rows.map(({ count, picks }, i) => {
      const parents: number[] = [];
      for (const pick of picks.slice(0, Math.min(count, i))) {
        const candidate = pick % 3 === 0 ? pick % i : i - 1 - (pick % Math.min(i, 5));
        if (!parents.includes(candidate)) parents.push(candidate);
      }
      return parents;
    }),
    edits: rows.map((r) => r.edits),
  }));

interface Built {
  dir: string;
  oids: Oid[];
}

async function build(spec: Spec): Promise<Built> {
  const dir = join(sandbox.dir, `log-${repoCount++}`);
  await sandbox.git(["init", "-q", "-b", "main", dir]);
  let stream = "";
  spec.parents.forEach((parents, i) => {
    const message = `c${i}\n`;
    stream += `commit refs/heads/c${i}\nmark :${i + 1}\n`;
    stream += `committer T <t@fyrden.invalid> ${spec.dates?.[i] ?? 1_700_000_000 + i * 10} +0000\n`;
    stream += `data ${message.length}\n${message}`;
    parents.forEach((p, k) => {
      stream += `${k === 0 ? "from" : "merge"} :${p + 1}\n`;
    });
    for (const [file, content] of spec.edits[i] ?? []) {
      const path = FILES[file] as string;
      if (content === 0) stream += `D ${path}\n`;
      else {
        const data = `v${content}\n`;
        stream += `M 100644 inline ${path}\ndata ${data.length}\n${data}`;
      }
    }
    stream += "\n";
  });
  const marks = join(dir, "marks");
  await sandbox.git(["fast-import", "--quiet", `--export-marks=${marks}`], {
    cwd: dir,
    input: stream,
  });
  const { stdout } = await sandbox.git(["cat-file", "--batch-check=%(objectname)"], {
    cwd: dir,
    input: spec.parents.map((_, i) => `refs/heads/c${i}\n`).join(""),
  });
  return { dir, oids: stdout.trim().split("\n").map(oidFromHex) };
}

/** The commit graph of every commit, and each root tree's entries by path (`git ls-tree -r -t`). */
async function load(built: Built) {
  const out = await sandbox.gitBytes(["cat-file", "--batch"], {
    cwd: built.dir,
    input: `${built.oids.map(oidToHex).join("\n")}\n`,
  });
  const commits = [];
  let p = 0;
  for (const oid of built.oids) {
    const nl = out.indexOf(0x0a, p);
    const size = Number(new TextDecoder().decode(out.subarray(p, nl)).split(" ")[2]);
    const { value } = parseCommit(out.subarray(nl + 1, nl + 1 + size));
    p = nl + 1 + size + 1;
    commits.push({
      oid,
      tree: value.tree,
      parents: value.parents,
      commitTime: value.committer.timestamp,
    });
  }
  const graph = createMemoryCommitGraph();
  await addPendingCommits(graph, "u", commits);
  await graph.promote("u");

  const entries = new Map<string, Map<string, string>>();
  for (const { tree } of commits) {
    const hex = oidToHex(tree);
    if (entries.has(hex)) continue;
    const { stdout } = await sandbox.git(["ls-tree", "-r", "-t", "-z", hex], { cwd: built.dir });
    const byPath = new Map<string, string>();
    for (const line of stdout.split("\0").filter(Boolean)) {
      const [meta, path] = line.split("\t");
      const [mode, , oid] = (meta as string).split(" ");
      byPath.set(path as string, `${mode} ${oid}`);
    }
    entries.set(hex, byPath);
  }
  const lookup =
    (path: string): PathEntryLookup =>
    async (tree) =>
      entries.get(oidToHex(tree))?.get(path) ?? null;
  return { graph, lookup };
}

/** Every page of the log from `tip`, `limit` at a time. */
async function fullLog(
  graph: Awaited<ReturnType<typeof load>>["graph"],
  tip: Oid,
  limit: number,
  path?: PathEntryLookup,
): Promise<string[]> {
  const shown: string[] = [];
  let from: Oid[] = [tip];
  for (let pages = 0; from.length > 0; pages++) {
    if (pages > 1000) throw new Error("the log does not end");
    const page = await logPage(graph, "verified", {
      from,
      limit,
      maxExamined: limit + 1,
      ...(path && { path }),
    });
    shown.push(...page.commits.map(oidToHex));
    from = page.frontier;
  }
  return shown;
}

async function gitLog(dir: string, tip: Oid, path: string): Promise<string[]> {
  const args = ["log", "--format=%H", oidToHex(tip)];
  if (path) args.push("--", path);
  const { stdout } = await sandbox.git(args, { cwd: dir });
  return stdout.split("\n").filter(Boolean);
}

describe("logPage", () => {
  it("lists what git log lists, in its order, for every path and page size", async () => {
    await fc.assert(
      fc.asyncProperty(specArb, fc.integer({ min: 1, max: 4 }), async (spec, limit) => {
        const built = await build(spec);
        const { graph, lookup } = await load(built);
        const tip = built.oids.at(-1) as Oid;
        for (const path of PATHS) {
          const ours = await fullLog(graph, tip, limit, path ? lookup(path) : undefined);
          expect(ours, `path ${path || "(none)"}`).toEqual(await gitLog(built.dir, tip, path));
        }
      }),
      { seed: SEED, numRuns: 25 },
    );
  }, 120_000);

  it("ends a page after the commits it may examine, and resumes from its frontier", async () => {
    const built = await build({
      parents: [[], [0], [1], [2], [3]],
      edits: [[[0, 1]], [[1, 1]], [[1, 2]], [[1, 3]], [[0, 2]]],
    });
    const { graph, lookup } = await load(built);
    const tip = built.oids[4] as Oid;
    // a.txt changes in c4 and c0 only: the first page stops after two commits examined.
    const first = await logPage(graph, "verified", {
      from: [tip],
      limit: 10,
      maxExamined: 2,
      path: lookup("a.txt"),
    });
    expect(first.commits.map(oidToHex)).toEqual([oidToHex(built.oids[4] as Oid)]);
    expect(first.frontier.map(oidToHex)).toEqual([oidToHex(built.oids[2] as Oid)]);
    const rest = await logPage(graph, "verified", {
      from: first.frontier,
      limit: 10,
      path: lookup("a.txt"),
    });
    expect(rest).toEqual({ commits: [built.oids[0]], frontier: [] });
  });

  it("orders commits with equal dates the same way whatever the page size", async () => {
    // Three roots with one date, merged by an octopus: ties git breaks by
    // the order it met them, which a walk resumed from a cursor cannot know.
    const built = await build({
      parents: [[], [], [], [0, 1, 2], [3]],
      edits: [[[0, 1]], [[1, 1]], [[2, 1]], [], [[0, 2]]],
      dates: [1_700_000_000, 1_700_000_000, 1_700_000_000, 1_700_000_100, 1_700_000_200],
    });
    const { graph, lookup } = await load(built);
    const tip = built.oids[4] as Oid;
    const whole = await fullLog(graph, tip, 100);
    for (const limit of [1, 2, 3]) expect(await fullLog(graph, tip, limit)).toEqual(whole);
    const roots = built.oids.slice(0, 3).map(oidToHex).sort();
    expect(whole.slice(2)).toEqual(roots);
    expect(await fullLog(graph, tip, 1, lookup("a.txt"))).toEqual(
      await fullLog(graph, tip, 100, lookup("a.txt")),
    );
  });

  it("ends a page early when the caller's budget runs out, after one commit at least", async () => {
    const built = await build({ parents: [[], [0], [1]], edits: [[], [], []] });
    const { graph } = await load(built);
    const page = await logPage(graph, "verified", {
      from: [built.oids[2] as Oid],
      limit: 10,
      stop: () => true,
    });
    expect(page).toEqual({ commits: [built.oids[2]], frontier: [built.oids[1]] });
  });

  it("ends a page before its commits and queue together reach the frontier limit", async () => {
    const built = await build({ parents: [[], [0], [1], [2]], edits: [[], [], [], []] });
    const { graph } = await load(built);
    const page = await logPage(graph, "verified", {
      from: [built.oids[3] as Oid],
      limit: 10,
      maxFrontier: 2,
    });
    // A caller showing none of the page's commits hands back both: still two.
    expect(page.commits.length + page.frontier.length).toBe(2);
    expect(page.commits).toEqual([built.oids[3]]);
  });

  it("refuses a frontier wider than allowed", async () => {
    const built = await build({ parents: [[], [], [], [0, 1, 2]], edits: [[], [], [], []] });
    const { graph } = await load(built);
    await expect(
      logPage(graph, "verified", { from: [built.oids[3] as Oid], limit: 1, maxFrontier: 2 }),
    ).rejects.toThrow(WalkLimitError);
    // A cursor handed back wider than any page could have made it.
    await expect(
      logPage(graph, "verified", { from: built.oids.slice(0, 3), limit: 1, maxFrontier: 2 }),
    ).rejects.toThrow(WalkLimitError);
  });
});
