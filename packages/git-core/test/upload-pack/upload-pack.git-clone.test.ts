import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { uploadPackRemote } from "../../testing/ext-transport/upload-pack-remote.js";
import { readRequestLog } from "../../testing/ext-transport/upload-pack-repo.js";
import type { GitSandbox } from "../../testing/git-cli.js";
import {
  commit,
  fsck,
  gitRemote,
  objectSet,
  oracle,
  Scratch,
  serve,
  setOrigin,
  shallowFile,
  sourceRepo,
} from "./support.js";

/*
 * Stock git (the oracle) cloning and fetching from the engine over git's
 * `ext::` transport, protocol v2. Every clone must pass `git fsck` and hold
 * the same objects as the source (or, for shallow cases, as the same
 * operation run by git's own upload-pack over file://).
 */

const scratch = new Scratch();
afterEach(() => scratch.cleanup());

/**
 * main with three commits, a feature branch, a lightweight and an annotated
 * tag. Each step is packed on its own (as pushes are stored), so the
 * repository has several packs and no object twice.
 */
async function branchyRepo(): Promise<GitSandbox> {
  const repo = await sourceRepo(scratch);
  const pack = () => repo.git(["repack", "-d", "-q"]);
  await commit(repo, { "README.md": "hello\n", "src/a.txt": "a1\n", "src/b.txt": "b1\n" }, "one");
  await commit(repo, { "src/a.txt": "a2\n" }, "two");
  await repo.git(["tag", "light"]);
  await pack();
  await repo.git(["checkout", "-q", "-b", "feature"]);
  await commit(repo, { "docs/guide.md": "guide\n" }, "feature work");
  await pack();
  await repo.git(["checkout", "-q", "main"]);
  await commit(repo, { "src/b.txt": "b2\n", "src/deep/c.txt": "c\n" }, "three");
  await repo.git(["tag", "-a", "v1", "-m", "release v1"]);
  return repo;
}

async function cloneFrom(
  dir: string,
  args: readonly string[] = [],
  options: { framing?: "transport" | "stored" } = {},
): Promise<{ client: GitSandbox; cwd: string }> {
  const client = await scratch.sandbox();
  const cwd = join(client.dir, "clone");
  await gitRemote(client, dir, (url) => ["clone", "-q", ...args, url, cwd], options);
  return { client, cwd };
}

describe("clone over the ext transport", () => {
  it.each([
    ["one pack, as-is", true, "transport", "as-is"],
    ["one pack, pre-framed copy", true, "stored", "as-is"],
    ["several packs, stitched", false, "transport", "stitched"],
    ["several packs, pre-framed stitched copy", false, "stored", "stitched"],
  ] as const)("%s", async (name, repack, framing, planKind) => {
    const source = await branchyRepo();
    if (repack) await source.git(["repack", "-adq"]);
    const dir = await serve(scratch, source);
    const { client, cwd } = await cloneFrom(dir, [], { framing });
    await fsck(client, cwd);
    expect(await objectSet(client, cwd)).toEqual(await objectSet(source));
    const log = await readRequestLog(dir);
    const fetches = log.filter((entry) => entry.command === "fetch");
    expect(fetches.map((entry) => entry.plan)).toEqual([planKind]);
    const [entry] = fetches;
    // Subrequest proxy: planning a verbatim clone reads no pack bytes, and
    // streaming it costs one ranged read per stored pack (or one read of
    // the pre-framed copy).
    if (framing === "transport") expect(entry?.planStoreReads).toBe(0);
    const packs = entry?.leasePacks ?? 0;
    expect(entry?.transportReads).toBe(framing === "stored" || repack ? 1 : packs);
    if (!repack && framing === "transport") expect(packs).toBeGreaterThan(1);
    console.info(`clone (${name}): ${JSON.stringify(entry)}`);
  });

  it("regenerates a pack when a stored pack is not known to be all reachable", async () => {
    const source = await branchyRepo();
    const dir = await serve(scratch, source, { allReachable: (index) => index !== 0 });
    for (const framing of ["transport", "stored"] as const) {
      const { client, cwd } = await cloneFrom(dir, [], { framing });
      await fsck(client, cwd);
      expect(await objectSet(client, cwd)).toEqual(await objectSet(source));
    }
    const fetches = (await readRequestLog(dir)).filter((entry) => entry.command === "fetch");
    expect(fetches.map((entry) => entry.plan)).toEqual(["regenerated", "regenerated"]);
    console.info(`regenerated clone: ${JSON.stringify(fetches[0])}`);
  });

  it("clones an empty repository", async () => {
    const source = await sourceRepo(scratch);
    const dir = await serve(scratch, source);
    const client = await scratch.sandbox();
    const cwd = join(client.dir, "clone");
    const { stderr } = await gitRemote(client, dir, (url) => ["clone", url, cwd]);
    expect(stderr).toContain("empty repository");
  });

  it("fetches only what the client lacks after new commits (negotiation with haves)", async () => {
    const source = await branchyRepo();
    const { client, cwd } = await cloneFrom(await serve(scratch, source));
    const before = (await source.git(["rev-parse", "main"])).stdout.trim();
    await commit(source, { "src/a.txt": "a3\n" }, "four");
    await commit(source, { "src/deep/c.txt": "c2\n", "new.txt": "new\n" }, "five");
    const dir = await serve(scratch, source);
    await setOrigin(client, cwd, dir);
    const remote = uploadPackRemote(dir);
    await client.git([...remote.config, "fetch", "-q", "origin"], { cwd, env: remote.env });
    await fsck(client, cwd);
    expect(await objectSet(client, cwd)).toEqual(await objectSet(source));
    const { stdout: lacking } = await source.git(["rev-list", "--objects", "main", `^${before}`]);
    const fetches = (await readRequestLog(dir)).filter((entry) => entry.command === "fetch");
    const last = fetches.at(-1);
    expect(last?.plan).toBe("regenerated");
    // Exactly the objects git itself would send: no history the client has.
    expect(last?.objectCount).toBe(lacking.trim().split("\n").length);
  });

  it("fetches a single ref by name", async () => {
    const source = await branchyRepo();
    const { client, cwd } = await cloneFrom(await serve(scratch, source), ["--single-branch"]);
    await source.git(["checkout", "-q", "feature"]);
    const tip = await commit(source, { "docs/more.md": "more\n" }, "more feature work");
    const dir = await serve(scratch, source);
    await gitRemote(client, dir, (url) => ["fetch", "-q", url, "refs/heads/feature"], { cwd });
    expect((await client.git(["rev-parse", "FETCH_HEAD"], { cwd })).stdout.trim()).toBe(tip);
    await fsck(client, cwd);
  });

  it("follows annotated tags with include-tag", async () => {
    const source = await branchyRepo();
    const { client, cwd } = await cloneFrom(await serve(scratch, source));
    await commit(source, { "src/a.txt": "a-next\n" }, "next");
    await source.git(["tag", "-a", "v2", "-m", "release v2"]);
    const dir = await serve(scratch, source);
    await setOrigin(client, cwd, dir);
    const remote = uploadPackRemote(dir);
    // A fetch with the configured refspec follows tags (git's builtin/fetch.c `autotags`).
    const { stderr } = await client.git([...remote.config, "fetch", "origin"], {
      cwd,
      env: { ...remote.env, GIT_TRACE_PACKET: "1" },
    });
    expect(stderr).toContain("fetch> include-tag");
    const v2 = (await source.git(["rev-parse", "v2"])).stdout.trim();
    expect((await client.git(["rev-parse", "refs/tags/v2"], { cwd })).stdout.trim()).toBe(v2);
    await fsck(client, cwd);
  });

  it("refuses a want only the reflog keeps with `not our ref`", async () => {
    const source = await branchyRepo();
    const dropped = await commit(source, { "secret.txt": "force-pushed away\n" }, "oops");
    await source.git(["reset", "-q", "--hard", "HEAD~1"]);
    const dir = await serve(scratch, source);
    const { client, cwd } = await cloneFrom(dir);
    const error = await gitRemote(client, dir, (url) => ["fetch", url, dropped], { cwd }).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(error?.message).toContain(`not our ref ${dropped}`);
    const log = await readRequestLog(dir);
    expect(log.at(-1)?.error).toBe(`upload-pack: not our ref ${dropped}`);
  });

  it("refuses protocol v0 and v1 with a clear error", async () => {
    const source = await branchyRepo();
    const dir = await serve(scratch, source);
    const client = await scratch.sandbox();
    const error = await gitRemote(client, dir, (url) => ["clone", url, join(client.dir, "clone")], {
      protocol: 0,
    }).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(error?.message).toContain(
      "remote error: Fyrden serves fetch and clone over git protocol version 2 only",
    );
  });
});

describe("shallow clones and deepening, against git's own upload-pack", () => {
  /** A history with dates a day apart and a merge: main = one..six, side merged in at five. */
  async function history(): Promise<{ source: GitSandbox; dates: number[] }> {
    const source = await sourceRepo(scratch);
    const dates: number[] = [];
    const at = (n: number) => {
      const date = 1_767_225_600 + n * 86_400;
      dates.push(date);
      return { date };
    };
    await commit(source, { "a/one.txt": "1\n", "b/keep.txt": "keep\n" }, "one", at(0));
    await commit(source, { "a/one.txt": "2\n" }, "two", at(1));
    await commit(source, { "a/two.txt": "two\n" }, "three", at(2));
    await source.git(["checkout", "-q", "-b", "side", "HEAD~1"]);
    await commit(source, { "c/side.txt": "side\n" }, "side", at(3));
    await source.git(["checkout", "-q", "main"]);
    await source.git(["merge", "-q", "--no-edit", "side"], {
      env: { GIT_AUTHOR_DATE: `${at(4).date} +0000`, GIT_COMMITTER_DATE: `${dates[4]} +0000` },
    });
    await commit(source, { "a/one.txt": "6\n" }, "six", at(5));
    await source.git(["tag", "-a", "v6", "-m", "six"]);
    return { source, dates };
  }

  async function compare(
    source: GitSandbox,
    steps: readonly ((url: string) => string[])[],
  ): Promise<void> {
    const dir = await serve(scratch, source);
    const ours = await scratch.sandbox();
    const theirs = await scratch.sandbox();
    const oursCwd = join(ours.dir, "clone");
    const theirsCwd = join(theirs.dir, "clone");
    for (const [i, step] of steps.entries()) {
      const inClone = i === 0 ? {} : { cwd: oursCwd };
      await gitRemote(
        ours,
        dir,
        (url) => step(url).map((a) => (a === "<dest>" ? oursCwd : a)),
        inClone,
      );
      await oracle(
        theirs,
        source,
        (url) => step(url).map((a) => (a === "<dest>" ? theirsCwd : a)),
        i === 0 ? undefined : theirsCwd,
      );
      await fsck(ours, oursCwd);
      expect(await shallowFile(oursCwd), `shallow after step ${i}`).toEqual(
        await shallowFile(theirsCwd),
      );
      expect(await objectSet(ours, oursCwd), `objects after step ${i}`).toEqual(
        await objectSet(theirs, theirsCwd),
      );
    }
  }

  it("clone --depth 1, then --depth 3 and --unshallow", async () => {
    const { source } = await history();
    await compare(source, [
      (url) => ["clone", "-q", "--depth", "1", url, "<dest>"],
      (url) => ["fetch", "-q", "--depth", "3", url, "main"],
      (url) => ["fetch", "-q", "--unshallow", url, "main"],
    ]);
  });

  it("clone --depth 1, then fetch --deepen (deepen-relative)", async () => {
    const { source } = await history();
    await compare(source, [
      (url) => ["clone", "-q", "--depth", "1", url, "<dest>"],
      (url) => ["fetch", "-q", "--deepen", "1", url, "main"],
      (url) => ["fetch", "-q", "--deepen", "2", url, "main"],
    ]);
  });

  it("clone --shallow-since", async () => {
    const { source, dates } = await history();
    await compare(source, [(url) => ["clone", "-q", `--shallow-since=${dates[3]}`, url, "<dest>"]]);
  });

  it("clone --shallow-exclude", async () => {
    const { source } = await history();
    await source.git(["tag", "base", "main~2"]);
    await compare(source, [(url) => ["clone", "-q", "--shallow-exclude", "base", url, "<dest>"]]);
  });

  it("clone --depth 2 --no-single-branch with tags", async () => {
    const { source } = await history();
    await compare(source, [
      (url) => ["clone", "-q", "--depth", "2", "--no-single-branch", url, "<dest>"],
    ]);
  });
});
