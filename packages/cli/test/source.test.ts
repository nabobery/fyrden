import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSource } from "../src/source.ts";

const run = promisify(execFile);
let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fyrden-cli-source-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

async function git(...args: string[]) {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  return (await run("git", args, { cwd: dir, env })).stdout.trim();
}

describe("readSource", () => {
  it("names the checked-out commit, dirty once anything differs from it, new files included", async () => {
    await git("init", "-q");
    await writeFile(join(dir, ".gitignore"), "wrangler.deploy.jsonc\n");
    await git("add", ".");
    await git("-c", "user.name=T", "-c", "user.email=t@fyrden.invalid", "commit", "-q", "-m", "a");
    const head = await git("rev-parse", "HEAD");
    // Ignored files (the generated deploy config) do not count.
    await writeFile(join(dir, "wrangler.deploy.jsonc"), "{}");
    expect(await readSource(dir)).toEqual({ commit: head, dirty: false });
    await writeFile(join(dir, "0006_new.sql"), "CREATE TABLE t (a);");
    expect(await readSource(dir)).toEqual({ commit: head, dirty: true });
  });

  it("has no commit outside a git checkout", async () => {
    expect(await readSource(dir)).toEqual({ commit: undefined, dirty: false });
  });
});
