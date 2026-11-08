// Global setup (runs in Node, once per test run): builds a history with
// real git's plumbing, so commit bytes are exact, and records what
// `git blame --line-porcelain` says of each path at its tip, so the blame
// source test walks the same history through Fyrden's reader and compares.
// The history has a merge, facts in ISO-8859-1, summaries git treats
// specially, a 17-parent octopus reachable from one path, commit objects of
// exactly 64 KiB and one byte more, a symlink, a directory and a submodule.
// Uses the git on PATH (or FYRDEN_GIT_BINARY), with no user or system
// config and fixed dates, so ids are the same on every run.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { BLAME_PATHS, type BlameFixtures, type GitBlameLine } from "../helpers/blame-fixtures.js";
import { toHex } from "../helpers/git-oracle.js";

const gitBinary = process.env.FYRDEN_GIT_BINARY ?? "git";
/** 2026-04-01T00:00:00Z; each commit is a minute later than the one before. */
const START = 1_775_001_600;
const COMMIT_INFO_BYTES = 64 * 1024;

export default function setup(project: TestProject): () => void {
  const root = mkdtempSync(join(tmpdir(), "fyrden-blame-fixtures-"));
  const dir = join(root, "repo.git");
  mkdirSync(dir);
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(root, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (args: string[], input?: string | Buffer): Buffer => {
    const result = spawnSync(gitBinary, args, {
      cwd: dir,
      env: env as unknown as NodeJS.ProcessEnv,
      maxBuffer: 64 * 1024 * 1024,
      ...(input === undefined ? {} : { input }),
    });
    if (result.status !== 0)
      throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
    return result.stdout;
  };
  const out = (args: string[], input?: string | Buffer) => git(args, input).toString("utf8").trim();
  git(["init", "-q", "--bare"]);

  const blob = (content: string) => out(["hash-object", "-w", "--stdin"], content);
  type Entry = readonly [mode: string, oid: string, name: string];
  const tree = (entries: readonly Entry[]) =>
    out(
      ["mktree"],
      `${entries
        .map(([mode, oid, name]) => {
          const type = mode === "040000" ? "tree" : mode === "160000" ? "commit" : "blob";
          return `${mode} ${type} ${oid}\t${name}`;
        })
        .join("\n")}\n`,
    );

  let clock = START;
  const raw = (
    treeOid: string,
    parents: readonly string[],
    message: Buffer,
    {
      author = Buffer.from("Fyrden Test"),
      headers = "",
    }: { author?: Buffer; headers?: string } = {},
  ) => {
    clock += 60;
    const bytes = Buffer.concat([
      Buffer.from(`tree ${treeOid}\n${parents.map((p) => `parent ${p}\n`).join("")}author `),
      author,
      Buffer.from(
        ` <test@fyrden.invalid> ${clock} +0000\n` +
          `committer Fyrden Test <test@fyrden.invalid> ${clock} +0000\n${headers}\n`,
      ),
      message,
    ]);
    return { bytes, oid: () => out(["hash-object", "-t", "commit", "-w", "--stdin"], bytes) };
  };
  const commit = (
    treeOid: string,
    parents: readonly string[],
    message: string | Buffer,
    options: { author?: Buffer; headers?: string } = {},
  ) =>
    raw(treeOid, parents, Buffer.isBuffer(message) ? message : Buffer.from(message), options).oid();
  /** A commit object of exactly `size` bytes, padded in its message's body. */
  const sized = (treeOid: string, parents: readonly string[], subject: string, size: number) => {
    const bare = raw(treeOid, parents, Buffer.from(`${subject}\n\n\n`)).bytes.length;
    clock -= 60;
    const made = raw(treeOid, parents, Buffer.from(`${subject}\n\n${"p".repeat(size - bare)}\n`));
    if (made.bytes.length !== size) throw new Error(`sized commit is ${made.bytes.length}`);
    return made.oid();
  };

  const lines = (...words: string[]) => `${words.join("\n")}\n`;
  const inner = blob("inner\n");
  const dirTree = tree([["100644", inner, "inner.txt"]]);
  const link = blob("f.txt");
  const base: Entry[] = [
    ["040000", dirTree, "dir"],
    ["120000", link, "link"],
    ["160000", "5".repeat(40), "module"],
  ];
  const withF = (f: string, extra: readonly Entry[] = []) =>
    tree([...base, ["100644", blob(f), "f.txt"], ...extra]);

  const commits: Record<string, string> = {};
  commits.root = commit(withF(lines("one", "two", "three", "four", "five", "six")), [], "Root\n");
  commits.side = commit(
    withF(lines("one", "two side", "three", "four", "five", "six")),
    [commits.root],
    "Side change\n\nWith a body.\n",
  );
  commits.main = commit(
    withF(lines("one", "two", "three", "four", "five main", "six")),
    [commits.root],
    "A subject that\nruns onto a second line\n\nbody\n",
  );
  commits.merge = commit(
    withF(lines("one", "two side", "three", "four", "five main", "six")),
    [commits.main, commits.side],
    "Merge side\n",
  );
  commits.latin1 = commit(
    withF(lines("one", "two side", "three", "four", "five main", "six latin")),
    [commits.merge],
    Buffer.from("café au lait\n", "latin1"),
    { author: Buffer.from("Renée Test", "latin1"), headers: "encoding ISO-8859-1\n" },
  );
  commits.indented = commit(
    withF(lines("one", "two side", "three edited", "four", "five main", "six latin")),
    [commits.latin1],
    "\n \t\n  indented subject\r\nsecond line\n",
  );
  commits.empty = commit(
    withF(lines("one", "two side", "three edited", "four edited", "five main", "six latin")),
    [commits.indented],
    "",
  );
  const mainF = lines("one", "two side", "three edited", "four edited", "five main", "six latin");

  // Seventeen branches off the root, each adding its own file, joined by one octopus.
  const octo: Entry[] = [];
  const branches: string[] = [];
  for (let n = 1; n <= 17; n++) {
    octo.push(["100644", blob(`octo ${n}\n`), `o${n}.txt`]);
    branches.push(
      commit(
        withF(lines("one", "two", "three", "four", "five", "six"), [octo.at(-1) as Entry]),
        [commits.root],
        `Branch ${n}\n`,
      ),
    );
  }
  commits.branch16 = branches[15] as string;
  commits.octopus = commit(
    withF(lines("one", "two", "three", "four", "five", "six"), octo),
    branches,
    "Octopus of seventeen\n",
  );
  commits.joined = commit(withF(mainF, octo), [commits.empty, commits.octopus], "Join octopus\n");

  // Commit objects of exactly 64 KiB and one byte more, each adding a line of big.txt.
  const big = (text: string) => ["100644", blob(text), "big.txt"] as const;
  commits.fits = sized(
    withF(mainF, [...octo, big("a\n")]),
    [commits.joined],
    "Fits",
    COMMIT_INFO_BYTES,
  );
  commits.over = sized(
    withF(mainF, [...octo, big("a\nb\n")]),
    [commits.fits],
    "Over",
    COMMIT_INFO_BYTES + 1,
  );
  const tipF = lines(
    "one tip",
    "two side",
    "three edited",
    "four edited",
    "five main",
    "six latin",
  );
  commits.tip = commit(withF(tipF, [...octo, big("a\nb\n")]), [commits.over], "Tip\n");

  const sizes = Object.fromEntries(
    ["fits", "over"].map((name) => [
      name,
      Number(out(["cat-file", "-s", commits[name] as string])),
    ]),
  );
  const blames = Object.fromEntries(
    BLAME_PATHS.map((path) => [
      path,
      porcelain(
        git(["blame", "--line-porcelain", commits.tip as string, "--", path]).toString("utf8"),
      ),
    ]),
  );
  const pack = toHex(git(["pack-objects", "--stdout", "--revs", "-q"], `${commits.tip}\n`));

  const fixtures: BlameFixtures = { pack, tip: commits.tip as string, commits, sizes, blames };
  project.provide("blameFixtures", fixtures);
  return () => rmSync(root, { recursive: true, force: true });
}

/** Each line of `git blame --line-porcelain` output. */
function porcelain(output: string): GitBlameLine[] {
  const result: GitBlameLine[] = [];
  let current: { -readonly [K in keyof GitBlameLine]?: GitBlameLine[K] } = {};
  for (const line of output.split("\n")) {
    const header = /^([0-9a-f]{40}) (\d+) (\d+)/.exec(line);
    if (header) {
      current = { commit: header[1] as string, line: Number(header[2]) };
    } else if (line.startsWith("\t")) {
      result.push(current as GitBlameLine);
    } else if (line.startsWith("author-mail ")) {
      current.email = line.slice("author-mail ".length).replace(/^<|>$/g, "");
    } else if (line.startsWith("author-time ")) {
      current.time = Number(line.slice("author-time ".length));
    } else if (line.startsWith("author ")) {
      current.name = line.slice("author ".length);
    } else if (line.startsWith("summary ")) {
      current.summary = line.slice("summary ".length);
    }
  }
  return result;
}
