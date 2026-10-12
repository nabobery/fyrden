import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { gitAuth } from "../src/commands/push.ts";
import { nodeGit, nodePackFiles } from "../src/commands/push-node.ts";

// The real git behind `fyrden push`: the pack it writes is what git index-pack accepts.

const root = mkdtempSync(join(tmpdir(), "fyrden-cli-push-"));
const repo = join(root, "repo");
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@fyrden.invalid",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@fyrden.invalid",
};
const git = (args: string[], cwd = repo) =>
  execFileSync("git", args, { cwd, env }).toString("utf8").trim();

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("node git runner", () => {
  it("writes the pack git pack-objects makes to a temporary file and reads it by range", async () => {
    execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
    writeFileSync(join(repo, "a.txt"), "hello\n");
    git(["add", "a.txt"]);
    git(["commit", "-q", "-m", "one"]);
    const head = git(["rev-parse", "HEAD"]);

    const path = await nodePackFiles.tempPath();
    const cwd = process.cwd();
    process.chdir(repo);
    let size: number;
    try {
      size = await nodeGit.packObjects(["--stdout", "--revs", "-q"], `${head}\n`, path);
      expect(
        (await nodeGit.tryRun(["rev-parse", "--verify", "--quiet", "main"])).stdout.trim(),
      ).toBe(head);
    } finally {
      process.chdir(cwd);
    }
    const pack = await nodePackFiles.read(path, 0, size);
    expect(new TextDecoder().decode(pack.subarray(0, 4))).toBe("PACK");
    expect(await nodePackFiles.read(path, 4, 4)).toEqual(pack.subarray(4, 8));

    const bare = join(root, "check.git");
    execFileSync("git", ["init", "-q", "--bare", bare], { env });
    execFileSync("git", ["index-pack", "--stdin", "--strict"], { cwd: bare, env, input: pack });
    expect(git(["cat-file", "-t", head], bare)).toBe("commit");

    await nodePackFiles.remove(path);
    await expect(nodePackFiles.read(path, 0, 1)).rejects.toThrow();
  });

  it("answers git's credential requests for the push URL's origin only, ahead of configured helpers", async () => {
    // A configured helper that would answer with the wrong password.
    writeFileSync(
      join(root, "gitconfig"),
      '[credential]\n\thelper = "!f() { echo username=other; echo password=WRONG; }; f"\n',
    );
    const saved = { ...process.env };
    Object.assign(process.env, {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
      GIT_TERMINAL_PROMPT: "0",
    });
    try {
      const token = "t$k 'n\\x";
      const auth = gitAuth(new URL("https://fyrden.example:8443/alice/proj.git"), token);
      const fill = (host: string) =>
        nodeGit.tryRun(
          [...auth.config, "credential", "fill"],
          `protocol=https\nhost=${host}\npath=alice/proj.git\n\n`,
          auth.env,
        );
      const ours = await fill("fyrden.example:8443");
      expect(ours.ok).toBe(true);
      expect(ours.stdout).toContain("username=fyrden\n");
      expect(ours.stdout).toContain(`password=${token}\n`);
      // Another host (a redirect, say) gets nothing: no helper answers it.
      expect((await fill("elsewhere.example")).ok).toBe(false);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});
