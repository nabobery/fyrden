import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { GitEnv, GitRunner, PackFiles, PushDeps } from "./push.ts";

/** `fyrden push`'s dependencies on this machine: the user's git, a temporary pack file, fetch. */

const gitBinary = process.env.FYRDEN_GIT_BINARY ?? "git";

const withEnv = (env: GitEnv | undefined) => (env ? { ...process.env, ...env } : process.env);

function runGit(
  args: string[],
  input: string | undefined,
  env: GitEnv | undefined,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(gitBinary, args, { stdio: ["pipe", "pipe", "pipe"], env: withEnv(env) });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
    child.stdin.end(input ?? "");
  });
}

export const nodeGit: GitRunner = {
  async run(args, input, env) {
    const result = await runGit(args, input, env);
    if (result.code !== 0)
      throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
    return result.stdout;
  },
  async tryRun(args, input, env) {
    const result = await runGit(args, input, env);
    return { ok: result.code === 0, stdout: result.stdout };
  },
  packObjects(args, revs, path) {
    return new Promise((resolve, reject) => {
      const child = spawn(gitBinary, ["pack-objects", ...args], {
        stdio: ["pipe", "pipe", "inherit"],
      });
      const written = pipeline(child.stdout, createWriteStream(path));
      child.on("error", reject);
      child.on("close", (code) => {
        written
          .then(async () => {
            if (code !== 0) throw new Error(`git pack-objects failed (${code})`);
            resolve((await stat(path)).size);
          })
          .catch(reject);
      });
      child.stdin.end(revs);
    });
  },
  passthrough(args, env) {
    return new Promise((resolve, reject) => {
      const child = spawn(gitBinary, args, { stdio: "inherit", env: withEnv(env) });
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });
  },
};

export const nodePackFiles: PackFiles = {
  async tempPath() {
    return join(await mkdtemp(join(tmpdir(), "fyrden-push-")), "pack");
  },
  async read(path, offset, length) {
    const file = await open(path, "r");
    try {
      const buffer = new Uint8Array(length);
      let at = 0;
      while (at < length) {
        const { bytesRead } = await file.read(buffer, at, length - at, offset + at);
        if (bytesRead === 0) throw new Error("the pack file ended early");
        at += bytesRead;
      }
      return buffer;
    } finally {
      await file.close();
    }
  },
  async remove(path) {
    await rm(dirname(path), { recursive: true, force: true });
  },
};

export function nodePushDeps(): PushDeps {
  return {
    git: nodeGit,
    files: nodePackFiles,
    fetch: globalThis.fetch,
    env: process.env,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    randomId: () => randomUUID(),
  };
}
