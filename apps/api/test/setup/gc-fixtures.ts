// Global setup (runs in Node, once per test run): a repository built with
// real git for the garbage-collection tests, and what git says is
// reachable after each step of their scenario (git is the oracle). Uses the
// git on PATH (or FYRDEN_GIT_BINARY), no user or system config, fixed dates.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestProject } from "vitest/node";
import type { FetchFixtureRepo } from "../helpers/fetch-fixtures.js";
import type { GcFixtures } from "../helpers/gc-fixtures.js";

const gitBinary = process.env.FYRDEN_GIT_BINARY ?? "git";

export default function setup(project: TestProject): () => void {
  const root = mkdtempSync(join(tmpdir(), "fyrden-gc-fixtures-"));
  const dir = join(root, "repo");
  mkdirSync(dir);
  let clock = 1_767_225_600;
  const git = (args: string[], input?: string): Buffer => {
    if (args[0] === "commit" || args[0] === "tag" || args[0] === "commit-tree") clock += 3_600;
    const date = `${clock} +0000`;
    const result = spawnSync(gitBinary, args, {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(root, ".gitconfig"),
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: "Fyrden Test",
        GIT_AUTHOR_EMAIL: "test@fyrden.invalid",
        GIT_COMMITTER_NAME: "Fyrden Test",
        GIT_COMMITTER_EMAIL: "test@fyrden.invalid",
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      } as unknown as NodeJS.ProcessEnv,
      ...(input === undefined ? {} : { input }),
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0)
      throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
    return result.stdout;
  };
  const text = (args: string[], input?: string) => git(args, input).toString("utf8").trim();
  const list = (args: string[]) =>
    text(args)
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => l.slice(0, 40))
      .sort();
  const commit = (files: Record<string, string>, message: string) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    git(["add", "-A"]);
    git(["commit", "-q", "-m", message]);
    return text(["rev-parse", "HEAD"]);
  };
  const body = (n: number, tag: string) =>
    Array.from({ length: n }, (_, i) => `${tag} ${i} ${"y".repeat(i % 30)}`).join("\n");

  git(["init", "-q", "-b", "main"]);
  for (let i = 0; i < 5; i++) {
    commit(
      { "a.txt": `${body(120, "a")}\nedit ${i}\n`, [`dir/f${i}.txt`]: `file ${i}\n` },
      `main ${i}`,
    );
  }
  git(["tag", "-a", "v1", "-m", "release one", "main~1"]);
  git(["checkout", "-q", "-b", "side", "main~2"]);
  commit({ "side.txt": body(80, "side") }, "side one");
  const side = commit(
    { "side.txt": `${body(80, "side")}\nsecond\n`, "only-side.txt": "s\n" },
    "side two",
  );
  git(["checkout", "-q", "-b", "feature", "main"]);
  const f1 = commit({ "feature.txt": body(60, "feature") }, "feature one");
  const f2 = commit({ "feature.txt": `${body(60, "feature")}\nmore\n` }, "feature two");
  // f1 rewritten (amended): what a force push of feature replaces f2 with.
  git(["checkout", "-q", "--detach", f1]);
  git(["commit", "-q", "--amend", "-m", "feature one, rewritten"]);
  const rewritten = text(["rev-parse", "HEAD"]);
  git(["checkout", "-q", "main"]);

  const all = list(["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"]);
  const packOf = (oids: readonly string[]) =>
    git(["pack-objects", "--stdout", "-q"], oids.map((o) => `${o}\n`).join("")).toString("hex");
  const refs = text(["for-each-ref", "--format=%(objectname) %(refname)"])
    .split("\n")
    .map((line) => {
      const [oid, name] = line.split(" ", 2) as [string, string];
      return { oid, name };
    });
  const commits = text(["log", "--all", "--format=%H %T %ct %P"])
    .split("\n")
    .concat(text(["log", "-1", "--format=%H %T %ct %P", rewritten]))
    .map((line) => {
      const [oid, tree, time, ...parents] = line.trim().split(" ") as [
        string,
        string,
        string,
        ...string[],
      ];
      return { oid, tree, time: Number(time), parents: parents.filter((p) => p.length > 0) };
    });
  const repo: FetchFixtureRepo = {
    packs: [packOf(all)],
    commits,
    refs,
    head: "refs/heads/main",
    objects: list(["rev-list", "--objects", "--all"]),
  };
  const old = list(["rev-list", "--objects", "main~3"]);
  const newer = list(["rev-list", "--objects", "main", "side", "^main~3"]);
  const rest = all.filter((o) => !old.includes(o) && !newer.includes(o));
  const fixtures: GcFixtures = {
    repo,
    packs: [packOf(old), packOf(newer), packOf(rest)],
    side,
    f2,
    rewritten,
    all,
    withoutSide: list(["rev-list", "--objects", "main", "feature", "v1"]),
    afterForce: list(["rev-list", "--objects", "main", rewritten, "v1"]),
  };
  project.provide("gcFixtures", fixtures);
  return () => rmSync(root, { recursive: true, force: true });
}
