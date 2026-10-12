import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UploadPackError } from "../../src/upload-pack/errors.js";
import { planFetch } from "../../src/upload-pack/fetch.js";
import type { GitSandbox } from "../../testing/git-cli.js";
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
 * The protocol v2 `fetch` response, section by section (gitprotocol-v2;
 * git v2.53.0 upload-pack.c `upload_pack_v2`): acknowledgments while
 * negotiating, `ready` when a pack can be computed, shallow-info, then the
 * packfile section.
 */

const scratch = new Scratch();
afterEach(() => scratch.cleanup());

async function linear() {
  const source = await sourceRepo(scratch);
  const one = await commit(source, { "a.txt": "1\n", "lib/x.txt": "x\n" }, "one");
  const two = await commit(source, { "a.txt": "2\n" }, "two");
  const three = await commit(source, { "a.txt": "3\n", "b.txt": "b\n" }, "three");
  await source.git(["checkout", "-q", "-b", "other", one]);
  const other = await commit(source, { "o.txt": "o\n" }, "other");
  await source.git(["checkout", "-q", "main"]);
  const loaded = await openUploadPackRepo(await serve(scratch, source));
  return { source, loaded, one, two, three, other };
}

describe("fetch response sections", () => {
  it("sends no acknowledgments without haves", async () => {
    const { loaded, three } = await linear();
    const response = parseFetchResponse(
      (await planAndRender(loaded, fetchArgs({ wants: [hexOid(three)], done: false }))).bytes,
    );
    expect(response.acknowledgments).toBeUndefined();
    expect(response.shallowInfo).toBeUndefined();
    expect(response.pack).toBeDefined();
  });

  it("answers NAK and no pack when no have is known", async () => {
    const { loaded, three } = await linear();
    const unknown = hexOid("1111111111111111111111111111111111111111");
    const { bytes, plan } = await planAndRender(
      loaded,
      fetchArgs({ wants: [hexOid(three)], haves: [unknown], done: false }),
    );
    expect(parseFetchResponse(bytes)).toEqual({
      acknowledgments: ["NAK"],
      ready: false,
      progress: "",
    });
    expect(plan.pack).toBeUndefined();
    expect(plan.leasePacks).toEqual([]);
  });

  it("ACKs common commits only, and is ready once every want reaches one", async () => {
    const { source, loaded, two, three, other } = await linear();
    const tree = (await source.git(["rev-parse", `${two}^{tree}`])).stdout.trim();
    // `other` does not reach `two`: not ready yet.
    const partial = parseFetchResponse(
      (
        await planAndRender(
          loaded,
          fetchArgs({
            wants: [hexOid(three), hexOid(other)],
            haves: [hexOid(tree), hexOid(two)],
            done: false,
          }),
        )
      ).bytes,
    );
    expect(partial).toEqual({ acknowledgments: [`ACK ${two}`], ready: false, progress: "" });

    const ready = parseFetchResponse(
      (
        await planAndRender(
          loaded,
          fetchArgs({ wants: [hexOid(three)], haves: [hexOid(two)], done: false }),
        )
      ).bytes,
    );
    expect(ready.acknowledgments).toEqual([`ACK ${two}`]);
    expect(ready.ready).toBe(true);
    expect(ready.pack).toBeDefined();
  });

  it("goes straight to the pack after `done`, sending only what the haves lack", async () => {
    const { source, loaded, two, three } = await linear();
    const { bytes, plan } = await planAndRender(
      loaded,
      fetchArgs({ wants: [hexOid(three)], haves: [hexOid(two)] }),
    );
    const response = parseFetchResponse(bytes);
    expect(response.acknowledgments).toBeUndefined();
    const { stdout } = await source.git(["rev-list", "--objects", three, `^${two}`]);
    expect(plan.pack?.objectCount).toBe(stdout.trim().split("\n").length);
    // commit three, its root tree, a.txt and b.txt: lib/ is unchanged.
    expect(plan.pack?.objectCount).toBe(4);
  });

  it("sends nothing at all for a request without wants", async () => {
    const { loaded } = await linear();
    const { bytes, plan } = await planAndRender(loaded, fetchArgs({}));
    expect(bytes.length).toBe(0);
    expect(plan.parts).toEqual([]);
  });

  it("writes whole objects and REF_DELTAs for a client without ofs-delta", async () => {
    const { source, loaded, three } = await linear();
    await source.git(["repack", "-adq"]);
    const repacked = await openUploadPackRepo(await serve(scratch, source));
    for (const repo of [loaded, repacked]) {
      const { bytes, plan } = await planAndRender(
        repo,
        fetchArgs({ wants: [hexOid(three)], ofsDelta: false }),
      );
      expect(plan.pack?.kind).toBe("regenerated");
      const pack = parseFetchResponse(bytes).pack as Uint8Array;
      const check = await scratch.sandbox();
      await check.git(["init", "-q"]);
      await check.git(["index-pack", "--strict", "--stdin"], { input: pack });
      const { stdout } = await check.git(["verify-pack", "-v", ...(await idxPaths(check))]);
      expect(stdout).not.toMatch(/ofs-delta/);
    }
  });

  it("refuses an ambiguous or unknown deepen-not", async () => {
    const { source, loaded, three } = await linear();
    await source.git(["tag", "other"]);
    const fresh = await openUploadPackRepo(await serve(scratch, source));
    for (const [repo, name] of [
      [loaded, "nosuchref"],
      [fresh, "other"],
    ] as const) {
      const error = await planFetch(
        repo.repository,
        fetchArgs({ wants: [hexOid(three)], deepenNot: [new TextEncoder().encode(name)] }),
        { framing: "transport" },
      ).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(UploadPackError);
      expect((error as Error).message).toBe(
        `git upload-pack: ambiguous deepen-not: deepen-not ${name}`,
      );
    }
  });
});

describe("include-tag", () => {
  async function tagged() {
    const source = await sourceRepo(scratch);
    const one = await commit(source, { "a.txt": "1\n" }, "one");
    await source.git(["tag", "-a", "v1", "-m", "v1"]);
    const two = await commit(source, { "a.txt": "2\n" }, "two");
    await source.git(["tag", "-a", "v2", "-m", "v2"]);
    await source.git(["tag", "-a", "v2-again", "-m", "tag of a tag", "v2"]);
    await source.git(["tag", "light"]);
    await source.git(["checkout", "-q", "-b", "elsewhere", one]);
    await commit(source, { "e.txt": "e\n" }, "elsewhere");
    await source.git(["tag", "-a", "v-elsewhere", "-m", "elsewhere"]);
    await source.git(["checkout", "-q", "main"]);
    const loaded = await openUploadPackRepo(await serve(scratch, source));
    const rev = async (name: string) => (await source.git(["rev-parse", name])).stdout.trim();
    return { source, loaded, one, two, rev };
  }

  async function sentObjects(pack: Uint8Array): Promise<string[]> {
    const check = await scratch.sandbox();
    await check.git(["init", "-q"]);
    await check.git(["index-pack", "--stdin"], { input: pack });
    const { stdout } = await check.git([
      "cat-file",
      "--batch-all-objects",
      "--batch-check=%(objectname)",
    ]);
    return stdout.split("\n").filter(Boolean);
  }

  it("adds annotated tags (and tag chains) whose target is sent, and no others", async () => {
    const { loaded, one, two, rev } = await tagged();
    const withTags = await sentObjects(
      parseFetchResponse(
        (
          await planAndRender(
            loaded,
            fetchArgs({ wants: [hexOid(two)], haves: [hexOid(one)], includeTag: true }),
          )
        ).bytes,
      ).pack as Uint8Array,
    );
    expect(withTags).toContain(await rev("v2"));
    expect(withTags).toContain(await rev("v2-again"));
    // v1's target is not sent (the client has it); v-elsewhere's is not wanted.
    expect(withTags).not.toContain(await rev("v1"));
    expect(withTags).not.toContain(await rev("v-elsewhere"));

    const without = await sentObjects(
      parseFetchResponse(
        (await planAndRender(loaded, fetchArgs({ wants: [hexOid(two)], haves: [hexOid(one)] })))
          .bytes,
      ).pack as Uint8Array,
    );
    expect(without).not.toContain(await rev("v2"));
    expect(without.length).toBe(withTags.length - 2);
  });

  it("a wanted annotated tag brings its target's closure", async () => {
    const { source, loaded, rev } = await tagged();
    const pack = parseFetchResponse(
      (await planAndRender(loaded, fetchArgs({ wants: [hexOid(await rev("v2-again"))] }))).bytes,
    ).pack as Uint8Array;
    const check = await scratch.sandbox();
    await check.git(["init", "-q"]);
    await check.git(["index-pack", "--strict", "--stdin"], { input: pack });
    await check.git(["update-ref", "refs/tags/v2-again", await rev("v2-again")]);
    await check.git(["fsck", "--full", "--strict"]);
    const { stdout } = await source.git(["rev-list", "--objects", "v2-again"]);
    const closure = stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(0, 40));
    const expected = new Set([...closure, await rev("v2-again"), await rev("v2")]);
    expect(await objectSet(check)).toEqual([...expected].sort());
  });
});

async function idxPaths(check: GitSandbox): Promise<string[]> {
  const dir = join(check.dir, ".git/objects/pack");
  return (await readdir(dir)).filter((n) => n.endsWith(".idx")).map((n) => join(dir, n));
}
