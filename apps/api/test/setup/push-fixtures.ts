// Global setup (runs in Node, once per test run): builds commits with real
// git and the packs `git push` would send for them (`git pack-objects`, as
// send-pack runs it), so the workerd push tests index packs git made. Uses
// the git on PATH (or FYRDEN_GIT_BINARY), with no user or system config and
// fixed identities and dates, so object ids are the same on every run.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { toHex } from "../helpers/git-oracle.js";
import type { PushFixtures } from "../helpers/push-fixtures.js";

const gitBinary = process.env.FYRDEN_GIT_BINARY ?? "git";

function gitIn(dir: string, home: string) {
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Fyrden Test",
    GIT_AUTHOR_EMAIL: "test@fyrden.invalid",
    GIT_COMMITTER_NAME: "Fyrden Test",
    GIT_COMMITTER_EMAIL: "test@fyrden.invalid",
    GIT_AUTHOR_DATE: "2026-02-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-02-01T00:00:00Z",
  };
  return (args: string[], input?: string): Buffer => {
    const result = spawnSync(gitBinary, args, {
      cwd: dir,
      env: env as unknown as NodeJS.ProcessEnv,
      ...(input === undefined ? {} : { input }),
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
    }
    return result.stdout;
  };
}

export default function setup(project: TestProject): () => void {
  const root = mkdtempSync(join(tmpdir(), "fyrden-push-fixtures-"));
  const dir = join(root, "work");
  spawnSync(gitBinary, ["init", "-q", "-b", "main", dir]);
  const git = gitIn(dir, root);
  const text = (args: string[], input?: string) => git(args, input).toString("utf8").trim();
  const commitFile = (file: string, content: string, message: string) => {
    writeFileSync(join(dir, file), content);
    git(["add", file]);
    git(["commit", "-q", "-m", message]);
    return text(["rev-parse", "HEAD"]);
  };
  /** What `git push` sends for `revs` (`git pack-objects --revs`, thin when asked). */
  const pack = (revs: string[], thin = false) =>
    toHex(
      git(
        ["pack-objects", "--stdout", "--revs", "-q", ...(thin ? ["--thin"] : [])],
        `${revs.join("\n")}\n`,
      ),
    );
  /** A pack of exactly these objects (no closure). */
  const objects = (oids: string[]) =>
    toHex(git(["pack-objects", "--stdout", "-q"], oids.map((oid) => `${oid}\n`).join("")));

  // a.txt is large enough that git sends c3's version as a delta against c1's.
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i}\n`).join("");
  const c1 = commitFile("a.txt", lines, "first");
  const c2 = commitFile("b.txt", "two\n", "second");
  const c3 = commitFile("a.txt", `${lines}three\n`, "third");
  git(["tag", "-a", "v1", "-m", "release one", c2]);
  const tag = text(["rev-parse", "v1"]);
  git(["checkout", "-q", "-b", "side", c1]);
  const c4 = commitFile("c.txt", "side\n", "side work");

  // A commit whose tree is never sent, and a child that names it as parent.
  const loneTree = text(
    ["mktree"],
    `100644 blob ${text(["hash-object", "-w", "--stdin"], "lonely\n")}\tlone.txt\n`,
  );
  const lone = text(["commit-tree", loneTree, "-p", c2, "-m", "tree never sent"]);
  const childTree = text(
    ["mktree"],
    `100644 blob ${text(["hash-object", "-w", "--stdin"], "child\n")}\tchild.txt\n`,
  );
  const child = text([
    "commit-tree",
    childTree,
    "-p",
    lone,
    "-m",
    "child of the quarantined commit",
  ]);
  const childBlob = text(["rev-parse", `${childTree}:child.txt`]);

  const fixtures: PushFixtures = {
    c1,
    c2,
    c3,
    c4,
    tag,
    lone,
    child,
    packC2: pack([c2]),
    packC3ThinOnC2: pack([c3, `^${c2}`], true),
    packC4OnC1: pack([c4, `^${c1}`], true),
    packTagOnC2: pack([tag, `^${c2}`]),
    packLoneWithoutTree: objects([lone]),
    packLoneWithTree: pack([lone, `^${c2}`]),
    packChildWithoutParent: objects([child, childTree, childBlob]),
    packEmpty: objects([]),
  };
  project.provide("pushFixtures", fixtures);
  return () => rmSync(root, { recursive: true, force: true });
}
