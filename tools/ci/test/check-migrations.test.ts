import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { createGitSandbox, type GitSandbox } from "@fyrden/testing/git-cli";
import { afterEach, describe, expect, it } from "vitest";
import { changedMigrations } from "../src/check-migrations.ts";

const run = promisify(execFile);
const script = resolve(import.meta.dirname, "../src/check-migrations.ts");
const author = ["-c", "user.name=Fyrden Test", "-c", "user.email=test@fyrden.invalid"];

const RELEASED = "apps/api/migrations/org/0001_read_models.sql";

describe("check-migrations", () => {
  let sandbox: GitSandbox | undefined;
  afterEach(() => sandbox?.dispose());

  async function write(path: string, content: string) {
    const file = join((sandbox as GitSandbox).dir, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }

  async function commit(message: string) {
    const git = (sandbox as GitSandbox).git.bind(sandbox);
    await git(["add", "-A"]);
    await git([...author, "commit", "-q", "-m", message]);
  }

  /** A main branch with released migrations, and a pull request branch off it. */
  async function repo() {
    sandbox = await createGitSandbox();
    await sandbox.git(["init", "-q", "-b", "main"]);
    await write(RELEASED, "CREATE TABLE a (x);\n");
    await write("apps/api/migrations/directory/0001_init.sql", "CREATE TABLE b (x);\n");
    await write("apps/api/migrations/org.expected.sql", "-- table a\nCREATE TABLE a (x);\n");
    await commit("base");
    await sandbox.git(["checkout", "-q", "-b", "pr"]);
  }

  const check = () => changedMigrations("main", "pr", (sandbox as GitSandbox).dir);

  it("passes a pull request that only adds migrations and updates the expected schemas", async () => {
    await repo();
    await write("apps/api/migrations/org/0002_more.sql", "CREATE TABLE c (x);\n");
    await write(
      "apps/api/migrations/org.expected.sql",
      "-- table a\nCREATE TABLE a (x);\n\n-- table c\nCREATE TABLE c (x);\n",
    );
    await commit("add a migration");
    expect(await check()).toEqual([]);
    const { stdout } = await run(process.execPath, [script, "main", "pr"], {
      cwd: (sandbox as GitSandbox).dir,
    });
    expect(stdout).toContain("no released migration changed");
  });

  it.each([
    ["modified", () => write(RELEASED, "CREATE TABLE a (x, y);\n"), "modified"],
    ["deleted", () => rm(join((sandbox as GitSandbox).dir, RELEASED)), "deleted"],
    [
      "renamed",
      () =>
        (sandbox as GitSandbox).git(["mv", RELEASED, "apps/api/migrations/org/0001_renamed.sql"]),
      "deleted",
    ],
  ])("fails a pull request in which a released migration is %s", async (_, change, status) => {
    await repo();
    await change();
    await commit("change a released migration");
    expect(await check()).toEqual([{ path: RELEASED, status }]);
    await expect(
      run(process.execPath, [script, "main", "pr"], { cwd: (sandbox as GitSandbox).dir }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(`${RELEASED} was ${status}`),
    });
  });

  it("judges the whole pull request, not only its last commit", async () => {
    await repo();
    await write(RELEASED, "CREATE TABLE a (x, y);\n");
    await commit("edit");
    await write("apps/api/migrations/org/0002_more.sql", "CREATE TABLE c (x);\n");
    await commit("add");
    expect(await check()).toEqual([{ path: RELEASED, status: "modified" }]);
  });

  it("judges only what the pull request changed, not what main gained since it branched", async () => {
    await repo();
    await write("apps/api/migrations/org/0002_on_pr.sql", "CREATE TABLE c (x);\n");
    await commit("pr migration");
    const git = (sandbox as GitSandbox).git.bind(sandbox);
    await git(["checkout", "-q", "main"]);
    await write("apps/api/migrations/org/0002_on_main.sql", "CREATE TABLE d (x);\n");
    await commit("main migration");
    await git(["checkout", "-q", "pr"]);
    expect(await check()).toEqual([]);
  });
});
