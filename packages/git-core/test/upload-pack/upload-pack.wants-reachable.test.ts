import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { oidToHex } from "../../src/object/oid.js";
import { UploadPackError } from "../../src/upload-pack/errors.js";
import { planFetch } from "../../src/upload-pack/fetch.js";
import type { UploadPackRepoState } from "../../testing/ext-transport/upload-pack-repo.js";
import {
  commit,
  fetchArgs,
  hexOid,
  objectSet,
  openUploadPackRepo,
  parseFetchResponse,
  planAndRender,
  Scratch,
  serve,
  sourceRepo,
} from "./support.js";

/*
 * Every want must be reachable from this repository's current refs. Objects that only the reflog keeps, and objects of
 * a sibling fork stored in a pack this repository shares, are never served.
 */

const scratch = new Scratch();
afterEach(() => scratch.cleanup());

async function rejection(promise: Promise<unknown>): Promise<UploadPackError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(UploadPackError);
  return error as UploadPackError;
}

describe("upload-pack.wants-reachable", () => {
  it("refuses a force-pushed-away commit still kept by the reflog", async () => {
    const source = await sourceRepo(scratch);
    await commit(source, { "a.txt": "1\n" }, "one");
    const kept = await commit(source, { "a.txt": "2\n" }, "two");
    const dropped = await commit(source, { "secret.txt": "x\n" }, "dropped");
    await source.git(["reset", "-q", "--hard", kept]);
    const dir = await serve(scratch, source);
    const loaded = await openUploadPackRepo(dir);
    // The commit is in the stored pack and in this repository's commit graph.
    const [row] = await loaded.repository.commitGraph.read([hexOid(dropped)], "verified");
    expect(row).toBeDefined();

    const error = await rejection(
      planFetch(loaded.repository, fetchArgs({ wants: [hexOid(dropped)] }), {
        framing: "transport",
      }),
    );
    expect(error.code).toBe("not-our-ref");
    expect(error.message).toBe(`upload-pack: not our ref ${dropped}`);
    // Its tree and blob are refused as well.
    const { stdout: tree } = await source.git(["rev-parse", `${dropped}^{tree}`]);
    const { stdout: blob } = await source.git(["rev-parse", `${dropped}:secret.txt`]);
    for (const hex of [tree.trim(), blob.trim()]) {
      const refused = await rejection(
        planFetch(loaded.repository, fetchArgs({ wants: [hexOid(hex)] }), { framing: "transport" }),
      );
      expect(refused.message).toBe(`upload-pack: not our ref ${hex}`);
    }
  });

  it("refuses a sibling fork's commit, tree and blob held in a shared pack", async () => {
    // One object store for the network: the sibling's branch is in the same
    // pack, but its ref and commit rows belong to the sibling repository.
    const source = await sourceRepo(scratch);
    await commit(source, { "a.txt": "1\n" }, "one");
    await source.git(["checkout", "-q", "-b", "sibling"]);
    const theirs = await commit(source, { "private.txt": "sibling only\n" }, "sibling private");
    await source.git(["checkout", "-q", "main"]);
    await source.git(["repack", "-adq"]);
    const dir = await serve(scratch, source);
    const statePath = join(dir, "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as UploadPackRepoState;
    await writeFile(
      statePath,
      JSON.stringify({
        ...state,
        refs: state.refs.filter(([name]) => name !== "refs/heads/sibling"),
        commits: state.commits.filter(([oid]) => oid !== theirs),
        // The shared pack holds objects outside this repository's closure.
        packs: state.packs.map((p) => ({ ...p, allReachable: false })),
      }),
    );
    const loaded = await openUploadPackRepo(dir);
    const { stdout: tree } = await source.git(["rev-parse", `${theirs}^{tree}`]);
    const { stdout: blob } = await source.git(["rev-parse", `${theirs}:private.txt`]);
    for (const hex of [theirs, tree.trim(), blob.trim()]) {
      const error = await rejection(
        planFetch(loaded.repository, fetchArgs({ wants: [hexOid(hex)] }), { framing: "transport" }),
      );
      expect(error.message).toBe(`upload-pack: not our ref ${hex}`);
    }

    // A full clone of this repository does not carry the sibling's objects.
    const main = (await source.git(["rev-parse", "main"])).stdout.trim();
    const { bytes } = await planAndRender(loaded, fetchArgs({ wants: [hexOid(main)] }));
    const pack = parseFetchResponse(bytes).pack as Uint8Array;
    const check = await scratch.sandbox();
    await check.git(["init", "-q"]);
    await check.git(["index-pack", "--strict", "--stdin"], { input: pack });
    const sent = await objectSet(check);
    expect(sent).not.toContain(theirs);
    expect(sent).not.toContain(blob.trim());
  });

  it("serves a tag's target, a commit below a tip, and the tag itself", async () => {
    const source = await sourceRepo(scratch);
    const first = await commit(source, { "a.txt": "1\n" }, "one");
    await commit(source, { "a.txt": "2\n" }, "two");
    await source.git(["tag", "-a", "v1", "-m", "v1", first]);
    const dir = await serve(scratch, source);
    const loaded = await openUploadPackRepo(dir);
    const tag = (await source.git(["rev-parse", "v1"])).stdout.trim();
    for (const want of [first, tag]) {
      const { bytes } = await planAndRender(loaded, fetchArgs({ wants: [hexOid(want)] }));
      expect(parseFetchResponse(bytes).pack?.length).toBeGreaterThan(32);
    }
  });

  it("reports the first unreachable want in request order", async () => {
    const source = await sourceRepo(scratch);
    const a = await commit(source, { "a.txt": "1\n" }, "one");
    const b = await commit(source, { "a.txt": "2\n" }, "two");
    const c = await commit(source, { "a.txt": "3\n" }, "three");
    await source.git(["reset", "-q", "--hard", a]);
    const loaded = await openUploadPackRepo(await serve(scratch, source));
    const unknown = "0123456789abcdef0123456789abcdef01234567";
    const error = await rejection(
      planFetch(
        loaded.repository,
        fetchArgs({ wants: [hexOid(a), hexOid(c), hexOid(unknown), hexOid(b)] }),
        { framing: "transport" },
      ),
    );
    expect(error.message).toBe(`upload-pack: not our ref ${c}`);
    expect(oidToHex(error.oid ?? hexOid(unknown))).toBe(c);
  });

  it("does not unshallow a retained commit the current refs do not reach", async () => {
    // Refs reach only A; C (parent B) survives a force push in the stored pack.
    const source = await sourceRepo(scratch);
    const a = await commit(source, { "a.txt": "1\n" }, "a");
    const b = await commit(source, { "secret.txt": "b\n" }, "b");
    const c = await commit(source, { "secret.txt": "c\n" }, "c");
    await source.git(["reset", "-q", "--hard", a]);
    const loaded = await openUploadPackRepo(await serve(scratch, source));
    const { bytes } = await planAndRender(
      loaded,
      fetchArgs({ wants: [hexOid(a)], shallow: [hexOid(c)], deepen: 2147483647 }),
    );
    const response = parseFetchResponse(bytes);
    expect(response.shallowInfo ?? []).not.toContain(`unshallow ${c}`);
    const check = await scratch.sandbox();
    await check.git(["init", "-q"]);
    await check.git(["index-pack", "--stdin"], { input: response.pack as Uint8Array });
    const sent = await check.git(["cat-file", "--batch-check"], { input: `${a}\n${b}\n` });
    const [sentA, sentB] = sent.stdout.split("\n");
    expect(sentA).toMatch(new RegExp(`^${a} commit `));
    expect(sentB).toBe(`${b} missing`);
  });

  it("fails closed when the reachability walk runs out of budget", async () => {
    const source = await sourceRepo(scratch);
    const first = await commit(source, { "a.txt": "0\n" }, "c0");
    for (let i = 1; i < 12; i++) await commit(source, { "a.txt": `${i}\n` }, `c${i}`);
    const loaded = await openUploadPackRepo(await serve(scratch, source));
    const args = fetchArgs({ wants: [hexOid(first)] });
    const error = await rejection(
      planFetch(loaded.repository, args, { framing: "transport", limits: { wantWalkCommits: 5 } }),
    );
    expect(error.message).toBe(`upload-pack: not our ref ${first}`);
    await expect(
      planFetch(loaded.repository, args, { framing: "transport", limits: { wantWalkCommits: 50 } }),
    ).resolves.toBeDefined();
  });

  describe("with an extra tip (a commit the caller vouches for, never advertised)", () => {
    // main: a <- b <- c, then reset to a; d, a child of a on a deleted branch, is reachable from
    // neither main nor c. The caller vouches for c.
    async function forcePushed() {
      const source = await sourceRepo(scratch);
      const a = await commit(source, { "a.txt": "1\n" }, "a");
      const b = await commit(source, { "b.txt": "b\n" }, "b");
      const c = await commit(source, { "c.txt": "c\n" }, "c");
      await source.git(["checkout", "-q", "-b", "side", a]);
      const d = await commit(source, { "d.txt": "d\n" }, "d");
      await source.git(["checkout", "-q", "main"]);
      await source.git(["branch", "-q", "-D", "side"]);
      await source.git(["reset", "-q", "--hard", a]);
      const loaded = await openUploadPackRepo(await serve(scratch, source));
      return { source, loaded, a, b, c, d };
    }

    const withExtra = (
      loaded: Awaited<ReturnType<typeof openUploadPackRepo>>,
      extraTips: readonly string[],
    ) => ({ ...loaded, repository: { ...loaded.repository, extraTips: extraTips.map(hexOid) } });

    async function sentObjects(pack: Uint8Array, oids: readonly string[]): Promise<string[]> {
      const check = await scratch.sandbox();
      await check.git(["init", "-q"]);
      await check.git(["index-pack", "--stdin"], { input: pack });
      const { stdout } = await check.git(["cat-file", "--batch-check"], {
        input: oids.map((o) => `${o}\n`).join(""),
      });
      return stdout.trim().split("\n");
    }

    it("serves it and its ancestors, and still refuses a commit neither reaches", async () => {
      const { loaded, a, b, c, d } = await forcePushed();
      const extra = withExtra(loaded, [c]);
      for (const want of [c, b]) {
        const { bytes } = await planAndRender(extra, fetchArgs({ wants: [hexOid(want)] }));
        const sent = await sentObjects(parseFetchResponse(bytes).pack as Uint8Array, [want, a]);
        expect(sent.map((line) => line.split(" ")[1])).toEqual(["commit", "commit"]);
      }
      const refused = await rejection(
        planFetch(extra.repository, fetchArgs({ wants: [hexOid(d)] }), { framing: "transport" }),
      );
      expect(refused.message).toBe(`upload-pack: not our ref ${d}`);
      // Without the extra tip, the same request is refused.
      const plain = await rejection(
        planFetch(loaded.repository, fetchArgs({ wants: [hexOid(c)] }), { framing: "transport" }),
      );
      expect(plain.message).toBe(`upload-pack: not our ref ${c}`);
    });

    it("serves it shallow and lifts a boundary below it", async () => {
      const { loaded, b, c } = await forcePushed();
      const extra = withExtra(loaded, [c]);
      const shallow = parseFetchResponse(
        (await planAndRender(extra, fetchArgs({ wants: [hexOid(c)], deepen: 1 }))).bytes,
      );
      expect(shallow.shallowInfo).toEqual([`shallow ${c}`]);
      const whole = parseFetchResponse(
        (
          await planAndRender(
            extra,
            fetchArgs({
              wants: [hexOid(c)],
              haves: [hexOid(c)],
              shallow: [hexOid(c)],
              deepen: 2147483647,
            }),
          )
        ).bytes,
      );
      expect(whole.shallowInfo).toEqual([`unshallow ${c}`]);
      const [sentB] = await sentObjects(whole.pack as Uint8Array, [b]);
      expect(sentB).toMatch(new RegExp(`^${b} commit `));
    });

    it("ignores an extra tip that is not a stored commit", async () => {
      const { loaded, a } = await forcePushed();
      const unknown = "0123456789abcdef0123456789abcdef01234567";
      const extra = withExtra(loaded, [unknown]);
      const refused = await rejection(
        planFetch(extra.repository, fetchArgs({ wants: [hexOid(unknown)] }), {
          framing: "transport",
        }),
      );
      expect(refused.message).toBe(`upload-pack: not our ref ${unknown}`);
      await expect(
        planFetch(extra.repository, fetchArgs({ wants: [hexOid(a)] }), { framing: "transport" }),
      ).resolves.toBeDefined();
    });

    // Lifting the client's boundary at c depends on who vouches for c, so the regenerated pack
    // does too: a pack cached for one caller is never served to the other.
    describe("and the regenerated pack cache", () => {
      const lift = (a: string, c: string) =>
        fetchArgs({ wants: [hexOid(a)], shallow: [hexOid(c)], deepen: 2147483647 });

      async function planned(
        loaded: Awaited<ReturnType<typeof openUploadPackRepo>>,
        args: ReturnType<typeof fetchArgs>,
        b: string,
      ) {
        const { plan, bytes } = await planAndRender(loaded, args);
        const response = parseFetchResponse(bytes);
        const [sentB] = await sentObjects(response.pack as Uint8Array, [b]);
        return { cached: plan.pack?.cached, shallowInfo: response.shallowInfo ?? [], sentB };
      }

      it("serves the vouching caller's pack, then regenerates for one without the tip", async () => {
        const { loaded, a, b, c } = await forcePushed();
        const job = await planned(withExtra(loaded, [c]), lift(a, c), b);
        expect(job.shallowInfo).toEqual([`unshallow ${c}`]);
        expect(job.sentB).toMatch(new RegExp(`^${b} commit `));

        const other = await planned(loaded, lift(a, c), b);
        expect(other.cached).toBe(false);
        expect(other.shallowInfo).not.toContain(`unshallow ${c}`);
        expect(other.sentB).toBe(`${b} missing`);
      });

      it("serves a caller without the tip first, then regenerates for the vouching one", async () => {
        const { loaded, a, b, c } = await forcePushed();
        const other = await planned(loaded, lift(a, c), b);
        expect(other.sentB).toBe(`${b} missing`);

        const job = await planned(withExtra(loaded, [c]), lift(a, c), b);
        expect(job.cached).toBe(false);
        expect(job.shallowInfo).toEqual([`unshallow ${c}`]);
        expect(job.sentB).toMatch(new RegExp(`^${b} commit `));
      });

      it("shares one pack between callers vouching for the same tips, in any order", async () => {
        const { loaded, a, b, c } = await forcePushed();
        const first = await planned(withExtra(loaded, [c]), lift(a, c), b);
        const again = await planned(withExtra(loaded, [c, c]), lift(a, c), b);
        expect([first.cached, again.cached]).toEqual([false, true]);
      });
    });
  });
});
