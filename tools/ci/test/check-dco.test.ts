import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { createGitSandbox, type GitSandbox } from "@fyrden/testing/git-cli";
import { afterEach, describe, expect, it } from "vitest";
import { readCommits, unsignedCommits } from "../src/check-dco.ts";

const run = promisify(execFile);
const script = resolve(import.meta.dirname, "../src/check-dco.ts");

async function repoWith(messages: string[]): Promise<GitSandbox> {
  const sandbox = await createGitSandbox();
  await sandbox.git(["init", "-q", "-b", "main"]);
  await sandbox.git(["commit", "-q", "--allow-empty", "-m", "base"]);
  await sandbox.git(["tag", "base"]);
  for (const message of messages)
    await sandbox.git(["commit", "-q", "--allow-empty", "-m", message]);
  return sandbox;
}

const author = "Fyrden Test <test@fyrden.invalid>";

describe("check-dco", () => {
  let sandbox: GitSandbox | undefined;
  afterEach(() => sandbox?.dispose());

  it("passes when every commit is signed off by its author", async () => {
    sandbox = await repoWith([
      `feat: a\n\nSigned-off-by: ${author}`,
      `fix: b\n\nSigned-off-by: ${author}`,
    ]);
    expect(unsignedCommits(readCommits("base..HEAD", sandbox.dir))).toEqual([]);
    const { stdout } = await run(process.execPath, [script, "base..HEAD"], { cwd: sandbox.dir });
    expect(stdout).toContain("every commit is signed off");
  });

  it("fails the pipeline on a commit without Signed-off-by", async () => {
    sandbox = await repoWith([`feat: a\n\nSigned-off-by: ${author}`, "fix: unsigned"]);
    const missing = unsignedCommits(readCommits("base..HEAD", sandbox.dir));
    expect(missing.map((c) => c.message.trim())).toEqual(["fix: unsigned"]);
    await expect(
      run(process.execPath, [script, "base..HEAD"], { cwd: sandbox.dir }),
    ).rejects.toMatchObject({ code: 1 });
  });

  it("rejects a sign-off by someone other than the author", async () => {
    sandbox = await repoWith(["feat: a\n\nSigned-off-by: Someone Else <else@example.com>"]);
    expect(unsignedCommits(readCommits("base..HEAD", sandbox.dir))).toHaveLength(1);
  });

  it("does not accept a sign-off quoted in the middle of a line", async () => {
    sandbox = await repoWith([`feat: a\n\nsee "Signed-off-by: ${author}" in docs`]);
    expect(unsignedCommits(readCommits("base..HEAD", sandbox.dir))).toHaveLength(1);
  });

  it("checks merge commits too, since a merge can carry its own changes", async () => {
    sandbox = await repoWith([]);
    const git = sandbox.git.bind(sandbox);
    await git(["checkout", "-q", "-b", "side"]);
    await git(["commit", "-q", "--allow-empty", "-m", `side\n\nSigned-off-by: ${author}`]);
    await git(["checkout", "-q", "main"]);
    await git(["commit", "-q", "--allow-empty", "-m", `main\n\nSigned-off-by: ${author}`]);
    await git(["merge", "-q", "--no-ff", "-m", "merge without sign-off", "side"]);
    const missing = unsignedCommits(readCommits("base..HEAD", sandbox.dir));
    expect(missing.map((c) => [c.parents, c.message.trim()])).toEqual([
      [2, "merge without sign-off"],
    ]);
  });

  it("matches the author email case-insensitively", async () => {
    sandbox = await repoWith(["feat: a\n\nSigned-off-by: Fyrden Test <TEST@fyrden.invalid>"]);
    expect(unsignedCommits(readCommits("base..HEAD", sandbox.dir))).toEqual([]);
  });
});
