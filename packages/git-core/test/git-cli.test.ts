import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitSandbox, type GitSandbox, gitVersion } from "../testing/git-cli.js";

async function headAfterOneCommit(sandbox: GitSandbox): Promise<string> {
  await sandbox.git(["init", "-q", "-b", "main"]);
  await sandbox.git(["commit", "-q", "--allow-empty", "-m", "first"]);
  return (await sandbox.git(["rev-parse", "HEAD"])).stdout.trim();
}

describe("git CLI harness", () => {
  const sandboxes: GitSandbox[] = [];
  afterEach(async () => {
    await Promise.all(sandboxes.splice(0).map((s) => s.dispose()));
  });

  it("reports the git version", async () => {
    expect(await gitVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("creates reproducible commits with an isolated config", async () => {
    const a = await createGitSandbox();
    const b = await createGitSandbox();
    sandboxes.push(a, b);
    // Fixed author, committer and dates give the same commit id in two sandboxes.
    const head = await headAfterOneCommit(a);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(await headAfterOneCommit(b)).toBe(head);
    expect(a.dir).not.toBe(b.dir);
    // The user's global config never leaks in: the sandbox's own is all there is.
    const config = await a.git(["config", "--global", "--list"]);
    expect(config.stdout.trim().split("\n").sort()).toEqual([
      "gc.auto=0",
      "maintenance.auto=false",
    ]);
  });

  it("starts no background maintenance that could repack while a test reads the packs", async () => {
    const sandbox = await createGitSandbox();
    sandboxes.push(sandbox);
    await sandbox.git(["init", "-q", "-b", "main"]);
    const trace = join(await sandbox.tempDir("trace-"), "events.json");
    await sandbox.git(["commit", "-q", "--allow-empty", "-m", "first"], {
      env: { GIT_TRACE2_EVENT: trace },
    });
    const children = (await readFile(trace, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string; argv?: string[] })
      .filter((event) => event.event === "child_start");
    expect(children.map((event) => event.argv?.join(" "))).not.toContainEqual(
      expect.stringContaining("maintenance"),
    );
  });
});
