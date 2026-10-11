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
    // The user's global config never leaks in.
    const config = await a.git(["config", "--global", "--list"]).catch(() => ({ stdout: "" }));
    expect(config.stdout).toBe("");
  });
});
