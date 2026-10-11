import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Oid, oidToHex } from "../../src/object/oid.js";
import { parsePack } from "../../src/pack/parse.js";
import { uploadPackRemote } from "../../testing/ext-transport/upload-pack-remote.js";
import { readRequestLog } from "../../testing/ext-transport/upload-pack-repo.js";
import { createMemoryBudget } from "../../testing/fakes/memory-budget.js";
import type { GitSandbox } from "../../testing/git-cli.js";
import { createNodeZlib } from "../../testing/node-zlib.js";
import {
  commit,
  fetchArgs,
  fsck,
  gitRemote,
  hexOid,
  objectSet,
  openUploadPackRepo,
  parseFetchResponse,
  planAndRender,
  Scratch,
  serve,
  setOrigin,
  sourceRepo,
} from "./support.js";

/*
 * Thin packs for fetch (`thin-pack`, gitprotocol-v2): a regenerated pack
 * may keep a stored delta whose base the client is proven to hold (an
 * object of a tree of its common commits) instead of rebuilding the
 * object whole. Without `thin-pack`, or for bases the client is not known
 * to have, the pack stays self-contained.
 */

const scratch = new Scratch();
afterEach(() => scratch.cleanup());

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i} ${"y".repeat(i % 50)}`);

/**
 * main: `big` (a 2,000-line file), `small` (the commit a client has), then
 * `trim` (big.txt shortened). Repacked whole, so git stores the shorter
 * new version as a delta against the version the client already has.
 */
async function trimmedRepo(): Promise<{ source: GitSandbox; have: string }> {
  const source = await sourceRepo(scratch);
  await commit(source, { "big.txt": lines(2_000).join("\n"), "small.txt": "1\n" }, "big");
  const have = await commit(source, { "small.txt": "2\n" }, "small");
  await commit(source, { "big.txt": lines(1_990).join("\n") }, "trim");
  await source.git(["repack", "-adf", "-q"]);
  return { source, have };
}

async function blobOid(source: GitSandbox, rev: string): Promise<string> {
  return (await source.git(["rev-parse", rev])).stdout.trim();
}

/** The pack's objects and the external bases its deltas use, resolved from `source`. */
async function readThinPack(source: GitSandbox, pack: Uint8Array) {
  const parsed = await parsePack(
    (async function* () {
      yield pack;
    })(),
    {
      zlib: createNodeZlib(),
      memory: createMemoryBudget(256 * 1024 * 1024),
      readRange: async (offset, length) => pack.subarray(offset, offset + length),
      externalBase: async (oid: Oid) => {
        const hex = oidToHex(oid);
        const type = (await source.git(["cat-file", "-t", hex])).stdout.trim();
        return { type: type as "blob", data: await source.gitBytes(["cat-file", type, hex]) };
      },
    },
  );
  const oids: string[] = [];
  for (let i = 0; i < parsed.entries.count; i++) oids.push(oidToHex(parsed.entries.oid(i)));
  const thinBases = parsed.thinBases.map(oidToHex);
  parsed.release();
  return { oids: oids.sort(), thinBases, bytes: pack.length };
}

describe("thin packs", () => {
  it("keeps a delta against a blob the client has when it asks for thin-pack", async () => {
    const { source, have } = await trimmedRepo();
    const loaded = await openUploadPackRepo(await serve(scratch, source));
    const main = await blobOid(source, "main");
    const oldBlob = await blobOid(source, `${have}:big.txt`);
    const { stdout: lacking } = await source.git(["rev-list", "--objects", "main", `^${have}`]);
    const expected = lacking
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => l.slice(0, 40))
      .sort();

    const request = (thinPack: boolean) =>
      fetchArgs({ wants: [hexOid(main)], haves: [hexOid(have)], thinPack });
    const thin = await planAndRender(loaded, request(true));
    const whole = await planAndRender(loaded, request(false));
    expect(thin.plan.pack?.kind).toBe("regenerated");

    const thinPack = await readThinPack(source, parseFetchResponse(thin.bytes).pack as Uint8Array);
    const wholePack = await readThinPack(
      source,
      parseFetchResponse(whole.bytes).pack as Uint8Array,
    );
    expect(thinPack.oids).toEqual(expected);
    expect(wholePack.oids).toEqual(expected);
    expect(thinPack.thinBases).toEqual([oldBlob]);
    expect(wholePack.thinBases).toEqual([]);
    expect(thinPack.bytes).toBeLessThan(wholePack.bytes);
  });

  it("never thins against an object the client is not proven to have", async () => {
    const { source } = await trimmedRepo();
    const loaded = await openUploadPackRepo(await serve(scratch, source));
    const main = await blobOid(source, "main");
    // A clone: no haves, so nothing is known to be held.
    const { bytes } = await planAndRender(
      loaded,
      fetchArgs({ wants: [hexOid(main)], thinPack: true, ofsDelta: false }),
    );
    const pack = await readThinPack(source, parseFetchResponse(bytes).pack as Uint8Array);
    expect(pack.thinBases).toEqual([]);
  });

  it("stock git fetches a thin pack and the repository passes fsck", async () => {
    const source = await sourceRepo(scratch);
    await commit(source, { "big.txt": lines(2_000).join("\n"), "small.txt": "1\n" }, "big");
    await commit(source, { "small.txt": "2\n" }, "small");
    const client = await scratch.sandbox();
    const cwd = join(client.dir, "clone");
    await gitRemote(client, await serve(scratch, source), (url) => ["clone", "-q", url, cwd]);

    await commit(source, { "big.txt": lines(1_990).join("\n") }, "trim");
    await source.git(["repack", "-adf", "-q"]);
    const dir = await serve(scratch, source);
    await setOrigin(client, cwd, dir);
    const remote = uploadPackRemote(dir);
    const { stderr } = await client.git([...remote.config, "fetch", "origin"], {
      cwd,
      env: { ...remote.env, GIT_TRACE_PACKET: "1" },
    });
    expect(stderr).toContain("fetch> thin-pack");
    await fsck(client, cwd);
    expect(await objectSet(client, cwd)).toEqual(await objectSet(source));
    const fetches = (await readRequestLog(dir)).filter((entry) => entry.command === "fetch");
    expect(fetches.at(-1)?.plan).toBe("regenerated");
  });
});
