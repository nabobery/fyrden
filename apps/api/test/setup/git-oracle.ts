// Global setup (runs in Node, once per test run): builds repositories with
// real git and records what git itself writes for the smart HTTP
// advertisements and ls-refs, so the workerd tests compare Fyrden's bytes
// with git's. Uses the git on PATH (or FYRDEN_GIT_BINARY).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import {
  type GitOracle,
  LS_REFS_VARIANTS,
  type LsRefsVariant,
  type OracleRepo,
  toHex,
} from "../helpers/git-oracle.js";

const gitBinary = process.env.FYRDEN_GIT_BINARY ?? "git";

/**
 * Runs git with no user or system config and fixed identities and dates, so
 * object ids are the same on every run. (The git-core CLI harness does the
 * same, but this package's typecheck sees Worker types, under which its
 * `spawn` call does not compile.)
 */
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
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  };
  return (
    cwd: string,
    args: string[],
    options: { env?: Record<string, string>; input?: string | Buffer } = {},
  ): Buffer => {
    const result = spawnSync(gitBinary, args, {
      cwd,
      env: { ...base, ...options.env } as unknown as NodeJS.ProcessEnv,
      ...(options.input === undefined ? {} : { input: options.input }),
    });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
    }
    return result.stdout;
  };
}

type Git = ReturnType<typeof gitIn>;

const pkt = (line: string) => {
  const data = Buffer.from(line, "utf8");
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, "0")), data]);
};

function lsRefsRequest(args: readonly string[]): Buffer {
  return Buffer.concat([
    pkt("command=ls-refs\n"),
    pkt("object-format=sha1\n"),
    Buffer.from("0001"),
    ...args.map((arg) => pkt(`${arg}\n`)),
    Buffer.from("0000"),
  ]);
}

function record(git: Git, dir: string): OracleRepo {
  const text = (args: string[]) => git(dir, args).toString("utf8").trim();

  const lsRefs = {} as Record<LsRefsVariant, string>;
  for (const [variant, args] of Object.entries(LS_REFS_VARIANTS)) {
    lsRefs[variant as LsRefsVariant] = toHex(
      git(dir, ["upload-pack", "--stateless-rpc", "."], {
        env: { GIT_PROTOCOL: "version=2" },
        input: lsRefsRequest(args),
      }),
    );
  }
  const receive = (version: string) =>
    toHex(
      git(
        dir,
        ["-c", "receive.advertisePushOptions=true", "receive-pack", "--advertise-refs", "."],
        {
          env: { GIT_PROTOCOL: `version=${version}` },
        },
      ),
    );

  const refLines = text(["for-each-ref", "--format=%(objectname) %(refname)"]);
  const refs = refLines
    ? refLines.split("\n").map((line) => {
        const [oid, name] = line.split(" ", 2) as [string, string];
        return { oid, name };
      })
    : [];
  const roots = refs.length ? text(["log", "--all", "--max-parents=0", "--format=%H %T %ct"]) : "";
  let packHex = "";
  if (refs.length) {
    git(dir, ["repack", "-adf", "-q"]);
    const packDir = join(dir, ".git/objects/pack");
    const pack = readdirSync(packDir).find((name) => name.endsWith(".pack"));
    if (!pack) throw new Error("git repack wrote no pack");
    packHex = toHex(readFileSync(join(packDir, pack)));
  }
  return {
    packHex,
    refs,
    head: text(["symbolic-ref", "HEAD"]),
    rootCommits: roots
      ? roots.split("\n").map((line) => {
          const [oid, tree, time] = line.split(" ") as [string, string, string];
          return { oid, tree, time: Number(time) };
        })
      : [],
    lsRefs,
    receivePackV0: receive("0"),
    receivePackV1: receive("1"),
  };
}

export default function setup(project: TestProject): () => void {
  const root = mkdtempSync(join(tmpdir(), "fyrden-git-oracle-"));
  const git = gitIn(root);
  const full = join(root, "full");
  const empty = join(root, "empty");
  git(root, ["init", "-q", "-b", "main", "full"]);
  git(root, ["init", "-q", "-b", "main", "empty"]);

  git(full, ["commit", "-q", "--allow-empty", "-m", "root"]);
  git(full, ["tag", "-a", "v1", "-m", "v1"]);
  git(full, ["-c", "advice.nestedTag=false", "tag", "-a", "v1o", "-m", "outer", "v1"]);
  git(full, ["tag", "light"]);
  const blob = git(full, ["hash-object", "-w", "--stdin"], { input: "a blob\n" }).toString().trim();
  git(full, ["tag", "-a", "vblob", "-m", "tags a blob", blob]);
  git(full, ["tag", "-a", "vtree", "-m", "tags a tree", "HEAD^{tree}"]);
  git(full, ["checkout", "-q", "-b", "feature"]);
  git(full, ["commit", "-q", "--allow-empty", "-m", "second"]);
  // Names whose UTF-16 and UTF-8 orders differ: git sorts by bytes.
  git(full, ["branch", "x\u{1F600}"]);
  git(full, ["branch", "x\u{FF01}"]);
  git(full, ["branch", "x_y"]);
  git(full, ["checkout", "-q", "main"]);

  const uploadPackV2 = git(full, ["upload-pack", "--advertise-refs", "--stateless-rpc", "."], {
    env: { GIT_PROTOCOL: "version=2" },
  });
  const agent = /agent=([^\n]+)\n/.exec(uploadPackV2.toString("latin1"));
  const oracle: GitOracle = {
    gitAgent: agent?.[1] ?? "",
    uploadPackV2: toHex(uploadPackV2),
    full: record(git, full),
    empty: record(git, empty),
  };
  project.provide("gitOracle", oracle);
  return () => rmSync(root, { recursive: true, force: true });
}
