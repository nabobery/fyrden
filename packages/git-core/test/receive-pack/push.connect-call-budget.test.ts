import { beforeEach, describe, expect, it } from "vitest";
import { openRangedIdx } from "../../src/pack/idx-range-read.js";
import type { PackIdxSource, RepoView } from "../../src/reader/view.js";
import { PushIndexer } from "../../src/receive-pack/indexer.js";
import { buildPack, gitOid, text } from "../pack/pack-builder.js";
import { commitBody, type MemoryServer, memoryServer, request, treeBody } from "./support.js";

/*
 * The connect phase runs against `.idx` files read by ranges (each read an
 * R2 GET in production, inside a Free invocation's 1,000 internal calls).
 * Linking many existing objects must not cost reads per object, and a
 * large check is cut into slices that each stay within a call budget.
 */

const FILES = 200;
const blobs = Array.from({ length: FILES }, (_, i) => {
  const data = text(`file ${i}\n`);
  return { data, oid: gitOid("blob", data) };
});
const named = (prefix: string) =>
  blobs
    .map((b, i) => ["100644", `${prefix}${String(i).padStart(3, "0")}`, b.oid] as const)
    .sort(([, a], [, b]) => (a < b ? -1 : 1));
const oldTree = treeBody(named("old-"));
const oldCommit = text(commitBody(gitOid("tree", oldTree), [], "files"));
const base = gitOid("commit", oldCommit);
const newTree = treeBody(named("new-"));
const renamed = text(commitBody(gitOid("tree", newTree), [base], "rename every file"));

let server: MemoryServer;
beforeEach(async () => {
  server = memoryServer();
  const pack = buildPack([
    ...blobs.map((b) => ({ kind: "blob" as const, data: b.data })),
    { kind: "tree", data: oldTree },
    { kind: "commit", data: oldCommit },
  ]).bytes;
  const first = await server.push(request([{ new: base, ref: "refs/heads/main" }], pack));
  expect(first.lines).toEqual(["unpack ok", "ok refs/heads/main"]);
});

/**
 * The live packs with ranged `.idx` readers that count their reads. With
 * `spanBytes`, batched lookups read in spans that small, so a batch costs
 * many reads, as one over a large index does.
 */
async function rangedView(spanBytes?: number): Promise<{ view: RepoView; reads: () => number }> {
  let reads = 0;
  const plain = await server.view();
  const packs = await Promise.all(
    plain.packs.map(async (pack) => {
      const bytes = server.idx.get(pack.packId) as Uint8Array;
      const ranged = await openRangedIdx(async (offset, length) => {
        reads++;
        return bytes.slice(offset, offset + length);
      });
      const idx: PackIdxSource =
        spanBytes === undefined
          ? ranged
          : {
              lookup: (oid, at, budget) => ranged.lookup(oid, at, budget),
              lookupMany: (oids, budget) => ranged.lookupMany(oids, budget, spanBytes),
              crc32At: (position, budget) => ranged.crc32At(position, budget),
            };
      return { ...pack, idx };
    }),
  );
  reads = 0;
  return { view: { scope: plain.scope, packs }, reads: () => reads };
}

const renamePush = () =>
  request(
    [{ old: base, new: gitOid("commit", renamed), ref: "refs/heads/main" }],
    buildPack([
      { kind: "tree", data: newTree },
      { kind: "commit", data: renamed },
    ]).bytes,
  );

describe("push.connect-call-budget", () => {
  it("links 200 renamed existing files with a handful of index reads", async () => {
    const { view, reads } = await rangedView();
    const pushed = await server.push(renamePush(), { index: { view } });
    expect(pushed.lines).toEqual(["unpack ok", "ok refs/heads/main"]);
    // One batched lookup for the blobs (oid, CRC32 and offset tables), one
    // for the parent commit, plus opening the index; never a read per file.
    expect(reads()).toBeLessThanOrEqual(8);
  });

  it("checkpoints the connect phase at its call budget and finishes in later slices", async () => {
    const { view } = await rangedView();
    const phases: string[] = [];
    const pushed = await server.push(renamePush(), {
      index: { view, limits: { connectCalls: 1, connectBatch: 50 } },
      onCheckpoint: (cursor) => {
        phases.push(PushIndexer.resume(cursor).phase);
      },
    });
    expect(pushed.lines).toEqual(["unpack ok", "ok refs/heads/main"]);
    // Four batches of 50 links: the slice after each batch but the last stops at the budget.
    expect(phases.filter((p) => p === "connect").length).toBe(1 + 3);
    expect(phases.at(-1)).toBe("done");
  });

  it("stops a slice before its call budget when batches cost many index reads", async () => {
    const { view, reads } = await rangedView(64);
    const connectCalls = 30;
    const slices: number[] = [];
    let before = reads();
    const pushed = await server.push(renamePush(), {
      index: { view, limits: { connectCalls, connectBatch: 4 } },
      onCheckpoint: () => {
        slices.push(reads() - before);
        before = reads();
      },
    });
    expect(pushed.lines).toEqual(["unpack ok", "ok refs/heads/main"]);
    // Every slice's index reads are counted as they happen, and none passes the budget.
    expect(slices.length).toBeGreaterThan(2);
    for (const slice of slices) expect(slice).toBeLessThanOrEqual(connectCalls);
  });
});
