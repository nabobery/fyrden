import { readFile } from "node:fs/promises";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addPendingCommits } from "../../src/graph/commit-graph.js";
import { correctedDateOffset, GENERATION_V2_OFFSET_MAX } from "../../src/graph/generation.js";
import { mergeBases } from "../../src/graph/merge-base.js";
import { isAncestor, reachableCommits } from "../../src/graph/reachability.js";
import { parseCommit } from "../../src/object/commit.js";
import { type Oid, oidFromBytes, oidFromHex, oidToHex } from "../../src/object/oid.js";
import { createMemoryCommitGraph } from "../../testing/fakes/memory-commit-graph.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";

/*
 * Differential tests against git. Each case is a random history built for
 * real with `git fast-import` (fixed dates, so ids are reproducible), read
 * back with `git cat-file --batch` and parsed with parseCommit, then loaded
 * into an in-memory commit graph. git answers merge-base, is-ancestor and
 * rev-list on the same commits, and the commit-graph file git writes for
 * them supplies the reference generation numbers. A brute-force ancestor
 * computation checks both against the definitions.
 */

const SEED = 20261011;

interface Spec {
  /** Parents of commit i are indexes below i. */
  parents: number[][];
  dates: number[];
}

let sandbox: GitSandbox;
let repoCount = 0;
beforeAll(async () => {
  sandbox = await createGitSandbox();
});
afterAll(() => sandbox.dispose());

// Dates mix equal values, a root at 0, and large values next to tiny ones, so
// children are often older than their parents (clock skew) and some
// corrected-date offsets exceed 31 bits. All corrected dates stay below 2^32
// so they fit git's 34-bit commit time and its 32-bit max_gen accumulator.
const dateArb = fc.oneof(
  fc.constant(0),
  fc.integer({ min: 1, max: 3 }),
  fc.integer({ min: 1_700_000_000, max: 1_700_000_100 }),
  fc.integer({ min: 4_000_000_000, max: 4_000_000_100 }),
);

const specArb: fc.Arbitrary<Spec> = fc
  .array(
    fc.record({
      count: fc.oneof(
        { weight: 1, arbitrary: fc.constant(0) },
        { weight: 6, arbitrary: fc.constant(1) },
        { weight: 3, arbitrary: fc.constant(2) },
        { weight: 1, arbitrary: fc.integer({ min: 3, max: 5 }) },
      ),
      picks: fc.array(fc.nat(), { minLength: 5, maxLength: 5 }),
      date: dateArb,
    }),
    { minLength: 1, maxLength: 28 },
  )
  .map((rows) => ({
    parents: rows.map(({ count, picks }, i) => {
      const parents: number[] = [];
      // Mostly recent commits, so merges cross between nearby branches.
      for (const pick of picks.slice(0, Math.min(count, i))) {
        const candidate = pick % 3 === 0 ? pick % i : i - 1 - (pick % Math.min(i, 6));
        if (!parents.includes(candidate)) parents.push(candidate);
      }
      return parents;
    }),
    dates: rows.map((r) => r.date),
  }));

// Criss-cross merges, a 5-parent octopus, disconnected roots, equal dates and
// a child dated long before its parent.
const FIXED: Spec = {
  parents: [[], [0], [0], [1, 2], [2, 1], [3], [4], [], [5, 6, 7, 1, 2], [8], [6], [9, 10], []],
  dates: [5, 5, 5, 4_000_000_000, 1, 1, 0, 0, 3, 3, 4_000_000_050, 2, 7],
};

interface Built {
  dir: string;
  oids: Oid[];
}

async function build(spec: Spec): Promise<Built> {
  const dir = join(sandbox.dir, `repo-${repoCount++}`);
  await sandbox.git(["init", "-q", "-b", "main", dir]);
  let stream = "";
  spec.parents.forEach((parents, i) => {
    const message = `c${i}\n`;
    stream += `commit refs/heads/c${i}\nmark :${i + 1}\n`;
    stream += `committer T <t@fyrden.invalid> ${spec.dates[i]} +0000\n`;
    stream += `data ${message.length}\n${message}`;
    parents.forEach((p, k) => {
      stream += `${k === 0 ? "from" : "merge"} :${p + 1}\n`;
    });
    stream += "\n";
  });
  const marks = join(dir, "marks");
  await sandbox.git(["fast-import", "--quiet", `--export-marks=${marks}`], {
    cwd: dir,
    input: stream,
  });
  const byMark = new Map<number, Oid>();
  for (const line of (await readFile(marks, "utf8")).trim().split("\n")) {
    const [mark, hex] = line.split(" ");
    byMark.set(Number(mark?.slice(1)), oidFromHex(hex as string));
  }
  const oids = spec.parents.map((_, i) => byMark.get(i + 1) as Oid);
  return { dir, oids };
}

/** Reads commits with `git cat-file --batch` and parses them with parseCommit. */
async function loadIntoGraph(built: Built) {
  const out = await sandbox.gitBytes(["cat-file", "--batch"], {
    cwd: built.dir,
    input: `${built.oids.map(oidToHex).join("\n")}\n`,
  });
  const graph = createMemoryCommitGraph();
  const commits = [];
  let p = 0;
  for (const oid of built.oids) {
    const nl = out.indexOf(0x0a, p);
    const [hex, type, size] = new TextDecoder().decode(out.subarray(p, nl)).split(" ");
    expect([hex, type]).toEqual([oidToHex(oid), "commit"]);
    const body = out.subarray(nl + 1, nl + 1 + Number(size));
    p = nl + 1 + Number(size) + 1;
    const { value } = parseCommit(body);
    commits.push({
      oid,
      tree: value.tree,
      parents: value.parents,
      commitTime: value.committer.timestamp,
    });
  }
  await addPendingCommits(graph, "u", commits);
  await graph.promote("u");
  return graph;
}

interface GitGraphEntry {
  level: number;
  generation: number;
  overflow: boolean;
}

/** Reads topological levels and corrected dates from a commit-graph file. */
function parseGitCommitGraph(file: Uint8Array): Map<string, GitGraphEntry> {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  expect(new TextDecoder().decode(file.subarray(0, 4))).toBe("CGPH");
  const chunkCount = file[6] as number;
  const chunks = new Map<string, number>();
  for (let i = 0; i < chunkCount; i++) {
    const at = 8 + 12 * i;
    chunks.set(
      new TextDecoder().decode(file.subarray(at, at + 4)),
      Number(view.getBigUint64(at + 4)),
    );
  }
  const oidl = chunks.get("OIDL") as number;
  const cdat = chunks.get("CDAT") as number;
  const gda2 = chunks.get("GDA2");
  const gdo2 = chunks.get("GDO2");
  expect(gda2).toBeDefined();
  const count = view.getUint32((chunks.get("OIDF") as number) + 255 * 4);
  const result = new Map<string, GitGraphEntry>();
  for (let i = 0; i < count; i++) {
    const oid = oidFromBytes(file, oidl + 20 * i);
    const data = cdat + 36 * i + 28;
    const level = view.getUint32(data) >>> 2;
    const date = (view.getUint32(data) & 3) * 2 ** 32 + view.getUint32(data + 4);
    const raw = view.getUint32((gda2 as number) + 4 * i);
    const overflow = raw >= 2 ** 31;
    const offset = overflow
      ? Number(view.getBigUint64((gdo2 as number) + 8 * (raw - 2 ** 31)))
      : raw;
    result.set(oidToHex(oid), { level, generation: date + offset, overflow });
  }
  return result;
}

/** Ancestor sets (each commit includes itself) as bitmasks. */
function ancestors(spec: Spec): bigint[] {
  const sets: bigint[] = [];
  spec.parents.forEach((parents, i) => {
    sets[i] = parents.reduce((acc, p) => acc | (sets[p] as bigint), 1n << BigInt(i));
  });
  return sets;
}

function members(mask: bigint, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) if ((mask >> BigInt(i)) & 1n) out.push(i);
  return out;
}

/** Best common ancestors of `one` and the hypothetical merge of `twos`, by definition. */
function bruteMergeBases(anc: bigint[], one: number, twos: number[]): number[] {
  const n = anc.length;
  const common = (anc[one] as bigint) & twos.reduce((acc, t) => acc | (anc[t] as bigint), 0n);
  const candidates = members(common, n);
  return candidates.filter(
    (c) => !candidates.some((d) => d !== c && ((anc[d] as bigint) >> BigInt(c)) & 1n),
  );
}

const hexes = (oids: Iterable<Oid>) => [...oids].map(oidToHex).sort();
const lines = (text: string) => text.split("\n").filter(Boolean).sort();

/** What the cases exercised, so the suite can prove its inputs cover the hard shapes. */
const seen = {
  cases: 0,
  severalBases: 0,
  noBase: 0,
  octopus: 0,
  disconnected: 0,
  clockSkew: 0,
  overflow: 0,
};

async function check(spec: Spec, queries: number[][]): Promise<void> {
  seen.cases++;
  if (spec.parents.some((p) => p.length > 2)) seen.octopus++;
  if (spec.parents.filter((p) => p.length === 0).length > 1) seen.disconnected++;
  if (
    spec.parents.some((p, i) =>
      p.some((q) => (spec.dates[q] as number) > (spec.dates[i] as number)),
    )
  ) {
    seen.clockSkew++;
  }
  const n = spec.parents.length;
  const built = await build(spec);
  const graph = await loadIntoGraph(built);
  const { oids, dir } = built;
  const git = (args: string[], okExitCodes = [0]) => sandbox.git(args, { cwd: dir, okExitCodes });
  const hex = (i: number) => oidToHex(oids[i] as Oid);
  const anc = ancestors(spec);

  // Generation numbers: compare every commit with the commit-graph git writes.
  await git(["-c", "commitGraph.generationVersion=2", "commit-graph", "write", "--reachable"]);
  const reference = parseGitCommitGraph(
    new Uint8Array(await readFile(join(dir, ".git/objects/info/commit-graph"))),
  );
  if ([...reference.values()].some((entry) => entry.overflow)) seen.overflow++;
  const rows = await graph.read(oids, "verified");
  rows.forEach((row, i) => {
    const expected = reference.get(hex(i));
    expect(row, `commit ${i}`).toBeDefined();
    expect(
      {
        level: row?.level,
        generation: row?.generation,
        overflow:
          correctedDateOffset(row?.commitTime ?? 0, row?.generation ?? 0) >
          GENERATION_V2_OFFSET_MAX,
      },
      `commit ${i}`,
    ).toEqual(expected);
  });

  for (const query of queries) {
    const [one, ...rest] = query.map((q) => q % n) as [number, ...number[]];
    const twos = rest.slice(0, 2);
    const label = `one ${one}, twos ${twos.join(",")}`;

    // merge-base --all
    const ours = hexes(
      await mergeBases(
        graph,
        "verified",
        oids[one] as Oid,
        twos.map((t) => oids[t] as Oid),
      ),
    );
    if (twos.length > 0) {
      const theirs = await git(["merge-base", "--all", hex(one), ...twos.map(hex)], [0, 1]);
      expect(ours, `merge-base ${label}`).toEqual(lines(theirs.stdout));
      if (ours.length > 1) seen.severalBases++;
      if (ours.length === 0) seen.noBase++;
      expect(ours, `merge-base by definition ${label}`).toEqual(
        bruteMergeBases(anc, one, twos).map(hex).sort(),
      );
    }

    // merge-base --is-ancestor
    const target = twos[0] ?? one;
    // Exit 0 means "is an ancestor", 1 "is not"; the harness rejects on 1.
    const code = await git(["merge-base", "--is-ancestor", hex(one), hex(target)]).then(
      () => 0,
      (error: { code: number }) => error.code,
    );
    const isAnc = await isAncestor(graph, "verified", oids[one] as Oid, oids[target] as Oid);
    expect(isAnc, `is-ancestor ${label}`).toBe(
      (((anc[target] as bigint) >> BigInt(one)) & 1n) === 1n,
    );
    expect(isAnc ? 0 : 1, `git is-ancestor ${label}`).toBe(code);

    // rev-list <one> <twos[1]> ^<twos[0]>
    const include = [one, ...twos.slice(1)];
    const exclude = twos.slice(0, 1);
    const reachable = await reachableCommits(
      graph,
      "verified",
      include.map((i) => oids[i] as Oid),
      exclude.map((i) => oids[i] as Oid),
    );
    const revArgs = [...include.map(hex), ...exclude.map((i) => `^${hex(i)}`)];
    const listed = lines((await git(["rev-list", ...revArgs])).stdout);
    const counted = Number((await git(["rev-list", "--count", ...revArgs])).stdout.trim());
    expect(hexes(reachable), `rev-list ${label}`).toEqual(listed);
    expect(reachable.size, `rev-list --count ${label}`).toBe(counted);
  }
}

describe("commit graph walks match git", () => {
  it("on random histories: merge-base --all, --is-ancestor, rev-list and generation numbers", async () => {
    await fc.assert(
      fc.asyncProperty(
        specArb,
        fc.array(fc.array(fc.nat(), { minLength: 1, maxLength: 3 }), {
          minLength: 1,
          maxLength: 6,
        }),
        (spec, queries) => check(spec, queries),
      ),
      {
        seed: SEED,
        numRuns: 100,
        examples: [
          [
            FIXED,
            [
              [5, 6],
              [6, 5],
              [8, 11],
              [11, 12],
              [3, 4, 9],
              [8, 0, 7],
              [10, 3],
            ],
          ],
        ],
      },
    );
    // Every hard shape occurred at least once.
    for (const [shape, count] of Object.entries(seen)) expect(count, shape).toBeGreaterThan(0);
    console.info("git differential coverage:", seen);
  }, 180_000);
});
