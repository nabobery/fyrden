import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitSandbox } from "../../testing/git-cli.js";
import {
  commit,
  fetchArgs,
  fsck,
  gitRemote,
  hexOid,
  objectSet,
  openUploadPackRepo,
  oracle,
  parseFetchResponse,
  planAndRender,
  Scratch,
  serve,
  shallowFile,
  sourceRepo,
} from "./support.js";

/*
 * A shallow fetch gets the full closure it lacks. The
 * unchanged-subtree skip is valid only against trees the client
 * is proven to have; a commit at the shallow boundary must bring its whole
 * tree even when its excluded parent's tree is identical.
 */

const scratch = new Scratch();
afterEach(() => scratch.cleanup());

/**
 * Indexes each pack into a fresh repository with the shallow boundary it
 * comes with (`index-pack --strict` checks links, so the boundary goes in
 * first), points `main` at `tip`, then runs `git fsck`: it fails if any
 * object the tip needs is missing.
 */
async function checkShallowPacks(
  steps: readonly (readonly [pack: Uint8Array, shallow: string])[],
  tip: string,
): Promise<GitSandbox> {
  const client = await scratch.sandbox();
  await client.git(["init", "-q", "-b", "main"]);
  for (const [pack, shallow] of steps) {
    await writeFile(join(client.dir, ".git/shallow"), `${shallow}\n`);
    await client.git(["index-pack", "--strict", "--stdin"], { input: pack });
  }
  await client.git(["update-ref", "refs/heads/main", tip]);
  await fsck(client, client.dir);
  return client;
}

describe("upload-pack.shallow-boundary", () => {
  it("depth 1 on an empty tip commit whose tree equals its parent's sends the whole tree", async () => {
    const source = await sourceRepo(scratch);
    await commit(source, { "a/x.txt": "x\n", "b/y.txt": "y\n", "top.txt": "t\n" }, "one");
    const tip = await commit(source, {}, "empty", { allowEmpty: true });
    const loaded = await openUploadPackRepo(await serve(scratch, source));
    const { bytes, plan } = await planAndRender(
      loaded,
      fetchArgs({ wants: [hexOid(tip)], deepen: 1 }),
    );
    const response = parseFetchResponse(bytes);
    expect(response.shallowInfo).toEqual([`shallow ${tip}`]);
    expect(plan.pack?.kind).toBe("regenerated");
    const client = await checkShallowPacks([[response.pack as Uint8Array, tip]], tip);
    // tip commit, root tree, a/, b/, three blobs
    expect(plan.pack?.objectCount).toBe(7);
    const { stdout } = await source.git(["rev-list", "--objects", "--no-walk", tip]);
    const closure = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(0, 40));
    expect(await objectSet(client)).toEqual(closure.sort());
  });

  it("deepening a shallow client with haves sends the full tree of the new boundary", async () => {
    // Directory `lib/` never changes. Each new boundary commit must still
    // bring its whole tree: the client has only the tip's.
    const source = await sourceRepo(scratch);
    await commit(
      source,
      { "lib/util.txt": "u\n", "lib/deep/k.txt": "k\n", "app.txt": "1\n" },
      "c1",
    );
    await commit(source, { "app.txt": "2\n" }, "c2");
    await commit(source, {}, "c3 (empty)", { allowEmpty: true });
    const tip = await commit(source, { "app.txt": "4\n" }, "c4");
    const loaded = await openUploadPackRepo(await serve(scratch, source));
    const parent = (await source.git(["rev-parse", `${tip}~1`])).stdout.trim();
    const grandparent = (await source.git(["rev-parse", `${tip}~2`])).stdout.trim();

    // The client holds a depth-1 clone (boundary at tip) and asks for one
    // more level, relatively: the new boundary is the empty commit c3.
    const relative = parseFetchResponse(
      (
        await planAndRender(
          loaded,
          fetchArgs({
            wants: [hexOid(tip)],
            haves: [hexOid(tip)],
            shallow: [hexOid(tip)],
            deepen: 1,
            deepenRelative: true,
          }),
        )
      ).bytes,
    );
    expect(relative.shallowInfo).toEqual([`shallow ${parent}`, `unshallow ${tip}`]);

    // And absolutely, to depth 3: the new boundary is c2, whose tree the
    // empty commit c3 shares; the client has neither.
    const absolute = parseFetchResponse(
      (
        await planAndRender(
          loaded,
          fetchArgs({
            wants: [hexOid(tip)],
            haves: [hexOid(tip)],
            shallow: [hexOid(tip)],
            deepen: 3,
          }),
        )
      ).bytes,
    );
    expect(absolute.shallowInfo).toEqual([`shallow ${grandparent}`, `unshallow ${tip}`]);
    // Each pack, on top of a depth-1 client, leaves a complete closure.
    const base = parseFetchResponse(
      (await planAndRender(loaded, fetchArgs({ wants: [hexOid(tip)], deepen: 1 }))).bytes,
    );
    for (const [response, boundary] of [
      [relative, parent],
      [absolute, grandparent],
    ] as const) {
      await checkShallowPacks(
        [
          [base.pack as Uint8Array, tip],
          [response.pack as Uint8Array, boundary],
        ],
        tip,
      );
    }
  });

  async function unchangedDirectories(): Promise<GitSandbox> {
    const source = await sourceRepo(scratch);
    await commit(
      source,
      { "vendor/a/a.txt": "a\n", "vendor/b/b.txt": "b\n", "src/main.txt": "0\n" },
      "base",
    );
    for (let i = 1; i <= 4; i++) await commit(source, { "src/main.txt": `${i}\n` }, `edit ${i}`);
    await commit(source, {}, "empty tip", { allowEmpty: true });
    return source;
  }

  it.each([
    ["deepen", ["--depth", "2"], ["--depth", "4"]],
    ["deepen-relative", ["--depth", "1"], ["--deepen", "2"]],
    ["unshallow", ["--depth", "1"], ["--unshallow"]],
  ] as const)(
    "unchanged directories across %s give the same result as git",
    async (_, first, second) => {
      const source = await unchangedDirectories();
      const dir = await serve(scratch, source);
      const ours = await scratch.sandbox();
      const theirs = await scratch.sandbox();
      const oursCwd = join(ours.dir, "clone");
      const theirsCwd = join(theirs.dir, "clone");
      await gitRemote(ours, dir, (url) => ["clone", "-q", ...first, url, oursCwd]);
      await oracle(theirs, source, (url) => ["clone", "-q", ...first, url, theirsCwd]);
      await fsck(ours, oursCwd);
      await gitRemote(ours, dir, (url) => ["fetch", "-q", ...second, url, "main"], {
        cwd: oursCwd,
      });
      await oracle(theirs, source, (url) => ["fetch", "-q", ...second, url, "main"], theirsCwd);
      await fsck(ours, oursCwd);
      expect(await shallowFile(oursCwd)).toEqual(await shallowFile(theirsCwd));
      expect(await objectSet(ours, oursCwd)).toEqual(await objectSet(theirs, theirsCwd));
    },
  );
});
