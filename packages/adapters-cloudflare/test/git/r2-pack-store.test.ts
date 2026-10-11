import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MIN_PART_BYTES } from "../../src/git/r2-pack-store.js";
import { inProbe, newProbe } from "./harness.js";

/** Deterministic bytes, so any misplaced part shows up in a range read. */
function pattern(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

describe("R2PackStore", () => {
  it("stores a pack larger than one part as a multipart upload under the network's key", async () => {
    const { stub, networkId } = await newProbe();
    const total = 2 * MIN_PART_BYTES + 12_345;
    const bytes = pattern(total, 7);
    const result = await inProbe(stub, async (probe) => {
      const writer = probe.git.packStore.beginPack();
      // Uneven chunks across part boundaries.
      for (let at = 0; at < total; at += 1_000_003)
        await writer.write(bytes.subarray(at, at + 1_000_003));
      const info = await writer.finish();
      const row = probe.git.registry.get(writer.packId);
      const edge = await probe.git.packStore.openRange(writer.packId, MIN_PART_BYTES - 10, 20);
      const tail = await probe.git.packStore.openRange(writer.packId, total - 5, 5);
      const r2 = probe.metrics
        .filter((m) => m.name.startsWith("r2."))
        .map((m) => `${m.name}:${m.dimensions.op}`);
      return { info, row, edge, tail, r2, packId: writer.packId };
    });
    expect(result.info).toEqual({ packId: result.packId, bytes: total });
    expect(result.row).toMatchObject({
      state: "indexing",
      r2Key: `net/${networkId}/p/${result.packId}.pack`,
    });
    expect(result.edge).toEqual(bytes.subarray(MIN_PART_BYTES - 10, MIN_PART_BYTES + 10));
    expect(result.tail).toEqual(bytes.subarray(total - 5));
    expect(result.r2).toEqual([
      "r2.class_a:create_multipart",
      "r2.class_a:upload_part",
      "r2.class_a:upload_part",
      "r2.class_a:upload_part",
      "r2.class_a:complete_multipart",
      "r2.class_b:get",
      "r2.class_b:get",
    ]);
    const stored = await env.GIT.head(`net/${networkId}/p/${result.packId}.pack`);
    expect(stored?.size).toBe(total);
  });

  it("writes a small pack with one PUT", async () => {
    const { stub, networkId } = await newProbe();
    const result = await inProbe(stub, async (probe) => {
      const writer = probe.git.packStore.beginPack();
      await writer.write(pattern(100, 1));
      await writer.finish();
      return {
        packId: writer.packId,
        r2: probe.metrics.filter((m) => m.name.startsWith("r2.")).map((m) => m.dimensions.op),
      };
    });
    expect(result.r2).toEqual(["put"]);
    expect((await env.GIT.head(`net/${networkId}/p/${result.packId}.pack`))?.size).toBe(100);
  });

  it("discards an aborted multipart pack: no R2 object, row discarded, never readable", async () => {
    const { stub, networkId } = await newProbe();
    const result = await inProbe(stub, async (probe) => {
      const writer = probe.git.packStore.beginPack();
      await writer.write(pattern(MIN_PART_BYTES + 1, 3));
      await writer.abort();
      let readable = true;
      try {
        await probe.git.packStore.openRange(writer.packId, 0, 1);
      } catch {
        readable = false;
      }
      return {
        packId: writer.packId,
        state: probe.git.registry.get(writer.packId)?.state,
        readable,
      };
    });
    expect(result).toMatchObject({ state: "discarded", readable: false });
    expect(await env.GIT.head(`net/${networkId}/p/${result.packId}.pack`)).toBeNull();
  });

  it("lists only live packs, from the registry", async () => {
    const { stub } = await newProbe();
    const result = await inProbe(stub, async ({ git }) => {
      const a = git.packStore.beginPack();
      await a.write(pattern(10, 1));
      await a.finish();
      const before = await git.packStore.listPacks();
      git.refStore.commitSync({
        addPacks: [a.packId],
        removePacks: [],
        refUpdates: [],
        expectedVersion: 0,
      });
      return { before, after: await git.packStore.listPacks(), packId: a.packId };
    });
    expect(result.before).toEqual([]);
    expect(result.after).toEqual([{ packId: result.packId, bytes: 10 }]);
  });

  it("refuses to start a pack before the repository has a network", async () => {
    const { stub } = await newProbe();
    await expect(
      inProbe(stub, ({ git }) => {
        git.context.storage.sql.exec("DELETE FROM git_meta");
        return git.packStore.beginPack().packId;
      }),
    ).rejects.toThrow(/not initialized/);
  });
});
