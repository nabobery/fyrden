// What an interoperability case gets: a git binary run with an isolated HOME
// and no system config, fixed dates one day apart, the Fyrden server, and an
// oracle (a bare repository served by the same git's own upload-pack and
// receive-pack over file://, configured like Fyrden) to compare against.
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gitBinary } from "@fyrden/testing/git-cli";
import type { Server } from "./server.ts";

export interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  input?: string | undefined;
}

/** Runs a command to completion, collecting its output. */
export function run(command: string, args: string[], options: RunOptions = {}): Promise<Run> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d;
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d;
    });
    child.on("error", fail);
    child.on("close", (code) => done({ code, stdout, stderr }));
    // The command may exit without reading its input; the exit code reports that.
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });
}

/** Both ends of a case: the Fyrden repository and the oracle with the same name. */
export interface Remotes {
  readonly fyrden: string;
  readonly oracle: string;
}

export interface Interop {
  /** The scratch directory of this case; relative paths in `cwd` resolve against it. */
  readonly scratch: string;
  /** The Fyrden server (shared by every case of the run). */
  readonly server: Server;
  /** This case's own token (git gets it from a credential helper). */
  readonly token: string;
  /** The version of the git under test, e.g. "2.43.7". */
  readonly gitVersion: string;
  git(args: string[], options?: RunOptions): Promise<Run>;
  /** Runs git and fails the case unless it exits 0; returns stdout. */
  ok(args: string[], cwd?: string): Promise<string>;
  /** Creates an empty Fyrden repository and an empty oracle. */
  remotes(name: string): Promise<Remotes>;
  /** The Fyrden repository name `remotes(name)` created. */
  repoName(name: string): string;
  /** `git init -b main` at `name` in the scratch directory, with one commit. */
  work(name: string): Promise<string>;
  /** Writes files (null deletes) and commits them one day after the previous commit. */
  commit(cwd: string, files: Record<string, string | null>, message?: string): Promise<string>;
  /** `git ls-remote` as `{ ref: oid }`. */
  lsRemote(url: string): Promise<Record<string, string>>;
  /** Every object reachable from any ref, sorted. */
  objects(cwd: string): Promise<string[]>;
  /** The `refs/` namespace as `{ ref: oid }` (for-each-ref). */
  refs(cwd: string): Promise<Record<string, string>>;
  /** The commits in `.git/shallow` (or `shallow` in a bare repository), sorted. */
  shallow(cwd: string): Promise<string[]>;
  /** `git fsck --full --strict`; fails the case on any finding. */
  fsck(cwd: string): Promise<void>;
}

const ORACLE_CONFIG: [string, string][] = [
  // Fyrden advertises push options and refuses pushes to pull request refs.
  ["receive.advertisePushOptions", "true"],
  ["receive.hideRefs", "refs/pull/"],
  // It applies fsck checks to every pushed object.
  ["receive.fsckObjects", "true"],
];

/**
 * An interop context for one case: its own scratch directory, and Fyrden
 * repository names prefixed with `prefix` so cases never share a repository.
 */
export async function createInterop(
  server: Server,
  scratch: string,
  gitVersion: string,
  prefix: string,
): Promise<Interop> {
  const home = join(scratch, "home");
  await mkdir(home, { recursive: true });
  const token = await server.mintToken();
  // The token reaches git through a credential helper, never a URL or argv.
  await writeFile(
    join(home, ".gitconfig"),
    [
      "[credential]",
      `\thelper = "!f() { test \\"$1\\" = get && echo username=x-access-token && echo password=$FYRDEN_INTEROP_TOKEN; }; f"`,
      "[init]",
      "\tdefaultBranch = main",
      "[protocol]",
      // Older releases default to v2 too (since 2.26); stated so a changed default shows.
      "\tversion = 2",
      "",
    ].join("\n"),
  );
  let clock = 1_767_225_600;

  const git = (args: string[], options: RunOptions = {}) => {
    const date = `${clock} +0000`;
    return run(gitBinary, args, {
      cwd: options.cwd ? join(scratch, options.cwd) : scratch,
      input: options.input,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        GIT_AUTHOR_NAME: "Fyrden Interop",
        GIT_AUTHOR_EMAIL: "interop@fyrden.invalid",
        GIT_COMMITTER_NAME: "Fyrden Interop",
        GIT_COMMITTER_EMAIL: "interop@fyrden.invalid",
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
        FYRDEN_INTEROP_TOKEN: token,
        ...options.env,
      },
    });
  };
  const ok = async (args: string[], cwd?: string) => {
    const result = await git(args, { cwd });
    if (result.code !== 0) {
      throw new Error(`git ${args.join(" ")} exited ${result.code}\n${result.stderr}`);
    }
    return result.stdout;
  };
  const lines = (text: string) => text.split("\n").filter((line) => line.length > 0);

  const repoName = (name: string) => `${prefix}-${name}`;

  const interop: Interop = {
    scratch,
    server,
    token,
    gitVersion,
    git,
    ok,
    repoName,
    async remotes(name) {
      await server.createRepo(repoName(name), token);
      const oracle = join("oracle", `${name}.git`);
      await ok(["init", "-q", "--bare", oracle]);
      for (const [key, value] of ORACLE_CONFIG) await ok(["config", key, value], oracle);
      return { fyrden: server.repoUrl(repoName(name)), oracle: `file://${join(scratch, oracle)}` };
    },
    async work(name) {
      await ok(["init", "-q", name]);
      await interop.commit(name, { "README.md": `${name}\n` }, "first");
      return name;
    },
    async commit(cwd, files, message = "change") {
      clock += 86_400;
      for (const [path, content] of Object.entries(files)) {
        const full = join(scratch, cwd, path);
        if (content === null) await rm(full, { force: true });
        else {
          await mkdir(dirname(full), { recursive: true });
          await writeFile(full, content);
        }
      }
      await ok(["add", "-A"], cwd);
      await ok(["commit", "-q", "--allow-empty", "-m", message], cwd);
      return (await ok(["rev-parse", "HEAD"], cwd)).trim();
    },
    async lsRemote(url) {
      const out: Record<string, string> = {};
      for (const line of lines(await ok(["ls-remote", url]))) {
        const [oid, ref] = line.split("\t") as [string, string];
        out[ref] = oid;
      }
      return out;
    },
    async objects(cwd) {
      return lines(await ok(["rev-list", "--objects", "--all"], cwd))
        .map((line) => line.slice(0, 40))
        .sort();
    },
    async refs(cwd) {
      const out: Record<string, string> = {};
      for (const line of lines(
        await ok(["for-each-ref", "--format=%(objectname) %(refname)", "refs/"], cwd),
      )) {
        const [oid, ref] = line.split(" ") as [string, string];
        out[ref] = oid;
      }
      return out;
    },
    async shallow(cwd) {
      const gitDir = (await ok(["rev-parse", "--git-dir"], cwd)).trim();
      const path = gitDir.startsWith("/") ? gitDir : join(scratch, cwd, gitDir);
      return lines(await readFile(join(path, "shallow"), "utf8").catch(() => "")).sort();
    },
    async fsck(cwd) {
      await ok(["fsck", "--full", "--strict", "--no-dangling"], cwd);
    },
  };
  return interop;
}

/** Compares dotted versions: negative when a < b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
