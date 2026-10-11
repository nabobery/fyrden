// A second protocol v2 client: JGit (jgit/FyrdenJGit.java) against
// fyrden-api under `wrangler dev`. Every result is checked with the git
// under test (fsck, same objects as git's own clone).
//
//   FYRDEN_JGIT_CLASSPATH   classpath of the pinned JGit jars (jgit/fetch-jars.sh)
//   FYRDEN_JGIT_REQUIRED=1  fail instead of skipping when it is not set (CI)
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitVersion } from "@fyrden/testing/git-cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cloneBoth, expectSameRepository, seeded } from "./cases/support.ts";
import { createInterop, type Interop, type Run, run } from "./harness.ts";
import { type Server, startServer } from "./server.ts";

const classpath = process.env.FYRDEN_JGIT_CLASSPATH ?? "";
if (!classpath && process.env.FYRDEN_JGIT_REQUIRED === "1") {
  throw new Error("FYRDEN_JGIT_CLASSPATH is not set (run tools/ci/interop/jgit/fetch-jars.sh)");
}
const source = join(import.meta.dirname, "jgit/FyrdenJGit.java");
const version = await gitVersion();

let scratch = "";
let server: Server;
let next = 0;

beforeAll(async () => {
  if (!classpath) return;
  scratch = await mkdtemp(join(tmpdir(), "fyrden-interop-jgit-"));
  server = await startServer({ persistTo: join(scratch, "state") });
}, 120_000);

afterAll(async () => {
  await server?.stop();
  expect(server?.tokenLines() ?? []).toEqual([]);
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

async function context(): Promise<Interop> {
  const id = `j${next++}`;
  return createInterop(server, join(scratch, id), version, id);
}

/** Runs the JGit client in the case's scratch directory, with the case's HOME and token. */
function jgit(t: Interop, args: string[]): Promise<Run> {
  const home = join(t.scratch, "home");
  return run("java", [`-Duser.home=${home}`, "-cp", classpath, source, ...args], {
    cwd: t.scratch,
    env: { HOME: home, FYRDEN_INTEROP_TOKEN: t.token },
  });
}

async function jgitOk(t: Interop, args: string[]): Promise<string> {
  const res = await jgit(t, args);
  expect(res.code, `jgit ${args.join(" ")}\n${res.stderr}`).toBe(0);
  return res.stdout;
}

describe.skipIf(!classpath)("JGit (protocol v2 fetch, v0 push) against Fyrden", () => {
  it("lists the same refs as git ls-remote", async () => {
    const t = await context();
    const { remotes } = await seeded(t, "jgit-ls");
    const listed = (await jgitOk(t, ["ls-remote", remotes.fyrden]))
      .split("\n")
      .filter((l) => l.length > 0)
      .sort();
    const byGit = Object.entries(await t.lsRemote(remotes.fyrden))
      .filter(([ref]) => ref !== "HEAD")
      .map(([ref, oid]) => `${oid}\t${ref}`)
      .sort();
    expect(listed).toEqual(byGit);
  });

  it("clones the same objects as git, and fetches new commits", async () => {
    const t = await context();
    const { work, remotes } = await seeded(t, "jgit-clone");
    await jgitOk(t, ["clone", remotes.fyrden, join(t.scratch, "jgit-clone")]);
    const byGit = await cloneBoth(t, remotes, "git-clone");
    await t.fsck("jgit-clone");
    expect(await t.objects("jgit-clone")).toEqual(await t.objects(byGit.fyrden));

    await t.commit(work, { "more.txt": "more\n" }, "more");
    await t.ok(["push", "-q", remotes.fyrden, "main"], work);
    await jgitOk(t, ["fetch", join(t.scratch, "jgit-clone")]);
    await t.fsck("jgit-clone");
    expect((await t.ok(["rev-parse", "origin/main"], "jgit-clone")).trim()).toBe(
      (await t.ok(["rev-parse", "main"], work)).trim(),
    );
  });

  it("makes a shallow clone with the same boundary as git", async () => {
    const t = await context();
    const { remotes } = await seeded(t, "jgit-shallow");
    await jgitOk(t, ["clone", remotes.fyrden, join(t.scratch, "jgit-shallow"), "1"]);
    const byGit = await cloneBoth(t, remotes, "git-shallow", [
      "--depth",
      "1",
      "--no-single-branch",
    ]);
    await expectSameRepository(t, byGit);
    await t.fsck("jgit-shallow");
    expect(await t.shallow("jgit-shallow")).toEqual(await t.shallow(byGit.fyrden));
  });

  // JGit sends every receive-pack request with Content-Encoding: gzip.
  it("pushes a branch, is refused a non-fast-forward, and deletes", async () => {
    const t = await context();
    const { work, remotes } = await seeded(t, "jgit-push");
    const workDir = join(t.scratch, work);
    await t.commit(work, { "j.txt": "j\n" }, "by jgit");
    expect(
      await jgitOk(t, ["push", workDir, remotes.fyrden, "refs/heads/main:refs/heads/jgit"]),
    ).toMatch(/refs\/heads\/jgit OK/);
    expect((await t.lsRemote(remotes.fyrden))["refs/heads/jgit"]).toBe(
      (await t.ok(["rev-parse", "main"], work)).trim(),
    );

    await t.ok(["reset", "-q", "--hard", "main~2"], work);
    await t.commit(work, { "nff.txt": "nff\n" }, "diverged");
    const refused = await jgit(t, [
      "push",
      workDir,
      remotes.fyrden,
      "refs/heads/main:refs/heads/jgit",
    ]);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toMatch(/refs\/heads\/jgit REJECTED_NONFASTFORWARD/);

    expect(await jgitOk(t, ["push", workDir, remotes.fyrden, ":refs/heads/jgit"])).toMatch(
      /refs\/heads\/jgit OK/,
    );
    expect(Object.keys(await t.lsRemote(remotes.fyrden))).not.toContain("refs/heads/jgit");
  });
});
