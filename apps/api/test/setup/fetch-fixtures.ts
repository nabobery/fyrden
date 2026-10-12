// Global setup (runs in Node, once per test run): builds repositories with
// real git for the fetch and clone tests and records what git says a client
// should receive. Uses the git on PATH (or FYRDEN_GIT_BINARY).
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestProject } from "vitest/node";
import type { FetchFixtureRepo, FetchFixtures } from "../helpers/fetch-fixtures.js";

const gitBinary = process.env.FYRDEN_GIT_BINARY ?? "git";

function gitIn(home: string) {
  const base = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Fyrden Test",
    GIT_AUTHOR_EMAIL: "test@fyrden.invalid",
    GIT_COMMITTER_NAME: "Fyrden Test",
    GIT_COMMITTER_EMAIL: "test@fyrden.invalid",
  };
  let clock = 1_767_225_600;
  return (cwd: string, args: string[]): string => {
    // Only commands that write dated objects move the clock, so two
    // histories made with the same commands get the same object ids.
    if (args[0] === "commit" || args[0] === "tag") clock += 3_600;
    const date = `${clock} +0000`;
    const result = spawnSync(gitBinary, args, {
      cwd,
      env: {
        ...base,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      } as unknown as NodeJS.ProcessEnv,
    });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
    }
    return result.stdout.toString("utf8");
  };
}

type Git = ReturnType<typeof gitIn>;

function write(dir: string, files: Record<string, string | null>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    if (content === null) rmSync(full, { force: true });
    else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  }
}

function commit(git: Git, dir: string, files: Record<string, string | null>, message: string) {
  write(dir, files);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

const lines = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `${tag} line ${i} ${"x".repeat(i % 40)}`).join("\n");

const sorted = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.slice(0, 40))
    .sort();

/** Packs, newest last, as git wrote them (by modification time, then name). */
function packsOf(dir: string): string[] {
  const packDir = join(dir, ".git/objects/pack");
  return readdirSync(packDir)
    .filter((name) => name.endsWith(".pack"))
    .map((name) => ({ name, mtime: statSync(join(packDir, name)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name))
    .map(({ name }) => readFileSync(join(packDir, name)).toString("hex"));
}

function describeRepo(git: Git, dir: string): FetchFixtureRepo {
  const refs = git(dir, ["for-each-ref", "--format=%(objectname) %(refname)"])
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [oid, name] = line.split(" ", 2) as [string, string];
      return { oid, name };
    });
  const commits = git(dir, ["log", "--all", "--format=%H %T %ct %P"])
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [oid, tree, time, ...parents] = line.trim().split(" ") as [
        string,
        string,
        string,
        ...string[],
      ];
      return { oid, tree, time: Number(time), parents: parents.filter((p) => p.length > 0) };
    });
  return {
    packs: packsOf(dir),
    commits,
    refs,
    head: git(dir, ["symbolic-ref", "HEAD"]).trim(),
    objects: sorted(git(dir, ["rev-list", "--objects", "--all"])),
  };
}

/** The shared history: main with three commits, feature off main~1, tags. */
function history(git: Git, dir: string, split: boolean): void {
  git(dir, ["init", "-q", "-b", "main"]);
  commit(git, dir, { "a.txt": lines(200, "a"), "dir/b.txt": "b\n", "dir/sub/c.txt": "c\n" }, "one");
  git(dir, ["tag", "light"]);
  commit(git, dir, { "a.txt": `${lines(200, "a")}\nmore\n`, "d.txt": "d\n" }, "two");
  if (split) git(dir, ["repack", "-d", "-q"]);
  git(dir, ["tag", "-a", "v1", "-m", "release one"]);
  git(dir, ["checkout", "-q", "-b", "feature"]);
  commit(git, dir, { "dir/b.txt": "b on feature\n" }, "feature");
  git(dir, ["checkout", "-q", "main"]);
  commit(git, dir, { "a.txt": `${lines(200, "a")}\nmore\nand more\n`, "d.txt": null }, "three");
  git(dir, ["repack", split ? "-d" : "-adf", "-q"]);
}

export default function setup(project: TestProject): () => void {
  const root = mkdtempSync(join(tmpdir(), "fyrden-fetch-fixtures-"));
  const git = gitIn(root);
  const gitSplit = gitIn(root);

  const single = join(root, "single");
  const split = join(root, "split");
  mkdirSync(single);
  mkdirSync(split);
  history(git, single, false);
  history(gitSplit, split, true);
  const singleRepo = describeRepo(git, single);
  const splitRepo = describeRepo(gitSplit, split);
  if (singleRepo.packs.length !== 1) throw new Error("the single fixture needs one pack");
  if (splitRepo.packs.length !== 2) throw new Error("the split fixture needs two packs");
  if (splitRepo.objects.join() !== singleRepo.objects.join())
    throw new Error("the two fixtures must hold the same objects");

  const have = git(single, ["rev-parse", "main~1"]).trim();

  // Thin: the newest version of big.txt is smaller than the one before, so
  // git stores it as a delta against the older version, which a client
  // that has `thinHave` holds.
  const thin = join(root, "thin");
  mkdirSync(thin);
  git(thin, ["init", "-q", "-b", "main"]);
  const big = lines(2_000, "big");
  commit(git, thin, { "big.txt": big, "small.txt": "1\n" }, "big");
  const thinHave = commit(git, thin, { "small.txt": "2\n" }, "small change");
  commit(git, thin, { "big.txt": big.split("\n").slice(0, 1_990).join("\n") }, "trim big");
  git(thin, ["repack", "-adf", "-q"]);
  const newBlob = git(thin, ["rev-parse", "main:big.txt"]).trim();
  const oldBlob = git(thin, ["rev-parse", `${thinHave}:big.txt`]).trim();
  const verify = git(thin, [
    "verify-pack",
    "-v",
    join(
      thin,
      ".git/objects/pack",
      readdirSync(join(thin, ".git/objects/pack")).find((n) => n.endsWith(".idx")) as string,
    ),
  ]);
  const line = verify.split("\n").find((l) => l.startsWith(newBlob));
  if (!line?.trim().endsWith(oldBlob)) {
    throw new Error(`the thin fixture's new blob is not a delta against the old one: ${line}`);
  }

  // Large: an incompressible 300 KB file, so the pack spans several
  // side-band packets.
  const large = join(root, "large");
  mkdirSync(large);
  git(large, ["init", "-q", "-b", "main"]);
  let seed = 7;
  const noise = Array.from({ length: 300_000 }, () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return String.fromCharCode(33 + (seed % 90));
  }).join("");
  commit(git, large, { "noise.txt": noise }, "noise");
  git(large, ["repack", "-adf", "-q"]);

  const fixtures: FetchFixtures = {
    large: describeRepo(git, large),
    single: singleRepo,
    split: splitRepo,
    have,
    sinceHave: sorted(git(single, ["rev-list", "--objects", "main", `^${have}`])),
    depthOne: sorted(git(single, ["rev-list", "--objects", "--no-walk", "main"])),
    thin: describeRepo(git, thin),
    thinHave,
    thinSince: sorted(git(thin, ["rev-list", "--objects", "main", `^${thinHave}`])),
  };
  project.provide("fetchFixtures", fixtures);
  return () => rmSync(root, { recursive: true, force: true });
}
