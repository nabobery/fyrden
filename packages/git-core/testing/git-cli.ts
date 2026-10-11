import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface GitResult {
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Written to git's stdin, which is then closed. */
  input?: Uint8Array | string;
  /** Exit codes that count as success (default: only 0), e.g. for `git fsck`. */
  okExitCodes?: readonly number[];
}

export interface GitSandbox {
  /** Working directory of the sandbox (an empty directory until `init`). */
  dir: string;
  /** Runs the pinned git binary with an isolated HOME and no system or global config. */
  git(args: string[], options?: GitOptions): Promise<GitResult>;
  /** Like `git`, but returns stdout as bytes (object contents are not text). */
  gitBytes(args: string[], options?: GitOptions): Promise<Uint8Array>;
  /** A new empty directory inside the sandbox, removed with it by `dispose`. */
  tempDir(prefix: string): Promise<string>;
  /** Removes the sandbox and every directory made with `tempDir`. */
  dispose(): Promise<void>;
}

/**
 * The git binary the tests run against: `git` on PATH unless
 * FYRDEN_GIT_BINARY names another. CI's interoperability jobs set it to git
 * built from a release pinned in `tools/ci/interop/git-versions.txt`
 * (by version and tarball SHA-256); the unit test jobs use the runner's git.
 */
export const gitBinary = process.env.FYRDEN_GIT_BINARY ?? "git";

/** Returns the version string of the git binary, e.g. "2.53.0". */
export async function gitVersion(): Promise<string> {
  const { stdout } = await run(gitBinary, ["--version"]);
  const match = /git version (\d+\.\d+\.\d+)/.exec(stdout);
  if (!match?.[1]) throw new Error(`unrecognised git version output: ${stdout}`);
  return match[1];
}

export async function createGitSandbox(): Promise<GitSandbox> {
  const root = await mkdtemp(join(tmpdir(), "fyrden-git-"));
  const home = join(root, "home");
  const dir = join(root, "work");
  await run("mkdir", ["-p", home, dir]);
  const baseEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Fyrden Test",
    GIT_AUTHOR_EMAIL: "test@fyrden.invalid",
    GIT_COMMITTER_NAME: "Fyrden Test",
    GIT_COMMITTER_EMAIL: "test@fyrden.invalid",
    // Fixed dates make object ids reproducible across runs.
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  };
  const exec = (args: string[], options: GitOptions) =>
    spawnGit(args, { ...options, cwd: options.cwd ?? dir, env: { ...baseEnv, ...options.env } });
  return {
    dir,
    async git(args, options = {}) {
      const { stdout, stderr } = await exec(args, options);
      return { stdout: stdout.toString("utf8"), stderr };
    },
    async gitBytes(args, options = {}) {
      return new Uint8Array((await exec(args, options)).stdout);
    },
    tempDir: (prefix) => mkdtemp(join(root, prefix)),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

function spawnGit(
  args: string[],
  options: GitOptions & { cwd: string; env: Record<string, string> },
): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(gitBinary, args, { cwd: options.cwd, env: options.env });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    // git may exit without reading its input; the exit code reports that.
    child.stdin.on("error", () => {});
    child.on("close", (code, signal) => {
      const stdout = Buffer.concat(out);
      const stderr = Buffer.concat(err).toString("utf8");
      if (code !== null && (options.okExitCodes ?? [0]).includes(code)) {
        return resolve({ stdout, stderr });
      }
      reject(
        Object.assign(new Error(`git ${args.join(" ")} failed (${signal ?? code}): ${stderr}`), {
          code,
          stdout: stdout.toString("utf8"),
          stderr,
        }),
      );
    });
    child.stdin.end(options.input);
  });
}
