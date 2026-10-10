import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface GitResult {
  stdout: string;
  stderr: string;
}

export interface GitSandbox {
  /** Working directory of the sandbox (an empty directory until `init`). */
  dir: string;
  /** Runs the pinned git binary with an isolated HOME and no system or global config. */
  git(args: string[], options?: { cwd?: string; env?: Record<string, string> }): Promise<GitResult>;
  dispose(): Promise<void>;
}

/**
 * The git binary the interop tests run against: `git` on PATH unless
 * FYRDEN_GIT_BINARY names another. CI does not pin an exact git build yet;
 * that comes with the git interoperability suite.
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
  return {
    dir,
    async git(args, options = {}) {
      const { stdout, stderr } = await run(gitBinary, args, {
        cwd: options.cwd ?? dir,
        env: { ...baseEnv, ...options.env },
        maxBuffer: 64 * 1024 * 1024,
      });
      return { stdout, stderr };
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
