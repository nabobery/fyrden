// Global setup (runs in Node, once per test run): builds a repository with
// real git (merges, nested directories, non-ASCII names, annotated and
// lightweight tags, an executable and a symlink) and records what git
// answers about it, so the browse tests compare Fyrden's answers with
// git's. Uses the git on PATH (or FYRDEN_GIT_BINARY), with no user or
// system config and a fixed date per commit, so ids are the same on every
// run.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestProject } from "vitest/node";
import {
  BROWSE_LOGS,
  BROWSE_PAIRS,
  type BrowseFixtures,
  type OracleCommit,
} from "../helpers/browse-fixtures.js";
import { toHex } from "../helpers/git-oracle.js";

const gitBinary = process.env.FYRDEN_GIT_BINARY ?? "git";
/** 2026-03-01T00:00:00Z; each commit is a minute later than the one before. */
const START = 1_772_323_200;

export default function setup(project: TestProject): () => void {
  const root = mkdtempSync(join(tmpdir(), "fyrden-browse-fixtures-"));
  const dir = join(root, "work");
  let clock = START;
  const baseEnv = {
    PATH: process.env.PATH ?? "",
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(root, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Fyrden Test",
    GIT_AUTHOR_EMAIL: "test@fyrden.invalid",
    GIT_COMMITTER_NAME: "Fyrden Test",
    GIT_COMMITTER_EMAIL: "test@fyrden.invalid",
  };
  const git = (
    args: string[],
    extra: Record<string, string> = {},
    input?: string | Buffer,
  ): Buffer => {
    const date = `@${clock} +0000`;
    const result = spawnSync(gitBinary, args, {
      cwd: dir,
      env: {
        ...baseEnv,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
        ...extra,
      } as unknown as NodeJS.ProcessEnv,
      maxBuffer: 64 * 1024 * 1024,
      ...(input === undefined ? {} : { input }),
    });
    if (result.status !== 0)
      throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
    return result.stdout;
  };
  const text = (args: string[]) => git(args).toString("utf8").trim();
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  const commit = (message: string, extra: Record<string, string> = {}) => {
    clock += 60;
    git(["add", "-A"]);
    git(["commit", "-q", "-m", message], extra);
    return text(["rev-parse", "HEAD"]);
  };

  mkdirSync(dir);
  git(["init", "-q", "-b", "main"]);
  write("README.md", "# Fixture\n");
  write("src/app.ts", "export const app = 1;\n");
  write("src/lib/util.ts", "export const util = 1;\n");
  commit("Initial commit");
  write("src/lib/util.ts", "export const util = 2;\n");
  commit("Change util\n\nA body line.\nAnd another: ünïcödé.", {
    GIT_AUTHOR_NAME: "Ada Author",
    GIT_AUTHOR_EMAIL: "ada@fyrden.invalid",
  });
  git(["tag", "v1-light"]);
  git(["checkout", "-q", "-b", "feature/ü-slash"]);
  write("docs/ünï.md", "Dokumentation\n");
  commit("Add docs");
  write("src/app.ts", "export const app = 2;\n");
  commit("Change app on the feature branch");
  git(["checkout", "-q", "main"]);
  write("README.md", "# Fixture\n\nMore.\n");
  commit("Expand the readme");
  clock += 60;
  git(["tag", "-a", "v1", "-m", "Release one"]);
  git(["tag", "tree-tag", text(["rev-parse", "HEAD^{tree}"])]);
  clock += 60;
  git(["merge", "-q", "--no-ff", "-m", "Merge the feature", "feature/ü-slash"]);
  unlinkSync(join(dir, "src/lib/util.ts"));
  commit("Remove util");
  write("run.sh", "#!/bin/sh\necho run\n");
  spawnSync("chmod", ["+x", join(dir, "run.sh")]);
  symlinkSync("README.md", join(dir, "link"));
  const last = commit("Add a script and a link");

  // A commit in ISO-8859-1 (its `encoding` header says so), on its own branch.
  clock += 60;
  const latin1 = (value: string) => Buffer.from(value, "latin1");
  const raw = Buffer.concat([
    Buffer.from(`tree ${text(["rev-parse", "HEAD^{tree}"])}\nparent ${last}\nauthor `),
    latin1("André"),
    Buffer.from(` <andre@fyrden.invalid> ${clock} +0000\ncommitter `),
    latin1("André"),
    Buffer.from(` <andre@fyrden.invalid> ${clock} +0000\nencoding ISO-8859-1\n\n`),
    // 0x80 is U+0080 in ISO-8859-1 (the web's windows-1252 would make it a euro sign).
    latin1("Café\x80\n"),
  ]);
  const legacy = git(["hash-object", "-t", "commit", "-w", "--stdin"], {}, raw)
    .toString("utf8")
    .trim();
  git(["update-ref", "refs/heads/latin1", legacy]);
  // A branch named like a commit id the repository does not have.
  git(["branch", "a".repeat(40), "HEAD~1"]);

  const refs = text(["for-each-ref", "--format=%(objectname) %(refname)"])
    .split("\n")
    .map((line) => {
      const [oid, name] = line.split(" ");
      return { name: name as string, oid: oid as string };
    });

  const commits: Record<string, OracleCommit> = {};
  for (const sha of text(["rev-list", "--all"]).split("\n")) {
    const [fields] = git([
      "log",
      "-1",
      "--format=%T%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct",
      sha,
    ])
      .toString("utf8")
      .split("\n");
    const [tree, parents, an, ae, at, cn, ce, ct] = (fields as string).split("\0");
    const raw = git(["cat-file", "commit", sha]).toString("utf8");
    commits[sha] = {
      sha,
      tree: tree as string,
      parents: parents ? parents.split(" ") : [],
      authorName: an as string,
      authorEmail: ae as string,
      authorTime: Number(at),
      committerName: cn as string,
      committerEmail: ce as string,
      committerTime: Number(ct),
      message: raw.slice(raw.indexOf("\n\n") + 2),
    };
  }

  const lines = (args: string[]) => text(args).split("\n").filter(Boolean);
  const logs: Record<string, string[]> = {};
  for (const rev of BROWSE_LOGS.revs) {
    logs[rev] = lines(["log", "--format=%H", rev]);
    for (const path of BROWSE_LOGS.paths)
      logs[`${rev} -- ${path}`] = lines(["log", "--format=%H", rev, "--", path]);
  }
  const counts: Record<string, number> = {};
  const mergeBases: Record<string, string> = {};
  for (const [a, b] of BROWSE_PAIRS) {
    counts[`${a}..${b}`] = Number(text(["rev-list", "--count", `${a}..${b}`]));
    mergeBases[`${a} ${b}`] = text(["merge-base", a, b]);
  }
  const revs: Record<string, string> = {};
  for (const rev of BROWSE_LOGS.revs) revs[rev] = text(["rev-parse", `${rev}^{commit}`]);

  const packHex = toHex(git(["pack-objects", "--all", "--stdout", "-q"], {}, ""));
  // main pushed one first-parent commit at a time: one pack each.
  const firstParents = text(["rev-list", "--reverse", "--first-parent", "main"]).split("\n");
  const mainSteps = firstParents.map((commit, i) => ({
    commit,
    packHex: toHex(
      git(
        ["pack-objects", "--revs", "--stdout", "-q"],
        {},
        i === 0 ? `${commit}\n` : `${commit}\n^${firstParents[i - 1]}\n`,
      ),
    ),
  }));
  // A commit only a fork will have: on a branch made after the pack above.
  git(["checkout", "-q", "-b", "sibling"]);
  write("secret.txt", "only in the fork\n");
  const siblingCommit = commit("Sibling-only commit");
  const siblingPackHex = toHex(
    git(["pack-objects", "--revs", "--stdout", "-q"], {}, "sibling\n^main\n"),
  );

  const fixtures: BrowseFixtures = {
    packHex,
    mainSteps,
    siblingCommit,
    siblingPackHex,
    refs,
    commits,
    logs,
    counts,
    mergeBases,
    revs,
  };
  project.provide("browseFixtures", fixtures);
  return () => rmSync(root, { recursive: true, force: true });
}
