import { afterEach, describe, expect, it } from "vitest";
import type { FetchArgs } from "../../src/protocol/v2-command.js";
import { planFetch } from "../../src/upload-pack/fetch.js";
import type { FetchResponsePart } from "../../src/upload-pack/response.js";
import { materialisedKeys } from "../../testing/ext-transport/upload-pack-repo.js";
import {
  commit,
  fetchArgs,
  hexOid,
  openUploadPackRepo,
  parseFetchResponse,
  planAndRender,
  Scratch,
  serve,
  sourceRepo,
} from "./support.js";

/*
 * A regenerated pack is written to storage (R2 in production) before the
 * plan is returned, and the plan only names it: the Durable Object never
 * streams a client-paced body. The same
 * holds for the side-band framed copies kept for Workers Free.
 */

const scratch = new Scratch();
afterEach(() => scratch.cleanup());

/** The largest literal buffer a plan may carry: section lines, acks, shallow-info. */
const MAX_LITERAL_BYTES = 4096;

function literalBytes(parts: readonly FetchResponsePart[]): Uint8Array[] {
  return parts.flatMap((part) => (part.kind === "bytes" ? [part.bytes] : []));
}

function carriesPackBytes(parts: readonly FetchResponsePart[]): boolean {
  return literalBytes(parts).some((bytes) => {
    const text = Buffer.from(bytes).toString("latin1");
    return bytes.length > MAX_LITERAL_BYTES || text.includes("PACK");
  });
}

async function repoWithHistory() {
  const source = await sourceRepo(scratch);
  await commit(source, { "a.txt": "1\n", "dir/b.txt": "b\n" }, "one");
  const second = await commit(source, { "a.txt": "2\n" }, "two");
  const tip = await commit(source, { "a.txt": "3\n", "dir/c.txt": "c\n" }, "three");
  return { source, second, tip };
}

describe("upload-pack.regen-materialised", () => {
  it.each(["transport", "stored"] as const)(
    "a regenerated pack is materialised before the plan returns (%s framing)",
    async (framing) => {
      const { source, second, tip } = await repoWithHistory();
      const dir = await serve(scratch, source);
      const loaded = await openUploadPackRepo(dir);
      const args = fetchArgs({ wants: [hexOid(tip)], haves: [hexOid(second)] });
      const plan = await planFetch(loaded.repository, args, { framing });
      expect(plan.pack?.kind).toBe("regenerated");
      expect(carriesPackBytes(plan.parts)).toBe(false);
      const packs = plan.parts.filter((p) => p.kind === "pack");
      expect(packs).toHaveLength(1);
      const [part] = packs as [Extract<FetchResponsePart, { kind: "pack" }>];
      expect(part.framed).toBe(framing === "stored");
      expect(plan.leasePacks).toEqual([part.packId]);
      // The bytes are already in the store, whole.
      const stored = await loaded.packStore.openRange(part.packId, 0, part.length);
      expect(stored.length).toBe(part.length);
      expect(await materialisedKeys(dir)).toHaveLength(1);
      if (framing === "transport")
        expect(Buffer.from(stored.subarray(0, 4)).toString()).toBe("PACK");
    },
  );

  it("a verbatim plan in stored framing materialises one framed copy per pack and reuses it", async () => {
    const { source, tip } = await repoWithHistory();
    await source.git(["repack", "-adq"]);
    const dir = await serve(scratch, source);
    const loaded = await openUploadPackRepo(dir);
    const args = fetchArgs({ wants: [hexOid(tip)] });
    const first = await planFetch(loaded.repository, args, { framing: "stored" });
    expect(first.pack).toMatchObject({ kind: "as-is", cached: false });
    expect(carriesPackBytes(first.parts)).toBe(false);
    const second = await planFetch(loaded.repository, args, { framing: "stored" });
    expect(second.pack).toMatchObject({ kind: "as-is", cached: true });
    expect(await materialisedKeys(dir)).toHaveLength(1);
    // Transport framing reads the stored pack itself: nothing is materialised.
    const direct = await planFetch(loaded.repository, args, { framing: "transport" });
    expect(direct.parts.filter((p) => p.kind === "pack")).toMatchObject([
      { framed: false, offset: 0 },
    ]);
    expect(await materialisedKeys(dir)).toHaveLength(1);
  });

  it("an identical request reuses the materialised pack; capabilities or ref version never share it", async () => {
    const { source, second, tip } = await repoWithHistory();
    const dir = await serve(scratch, source);
    const loaded = await openUploadPackRepo(dir);
    const base = fetchArgs({ wants: [hexOid(tip)], haves: [hexOid(second)] });
    const variants: FetchArgs[] = [
      { ...base, ofsDelta: false },
      { ...base, thinPack: true },
      { ...base, includeTag: true },
    ];
    const first = await planFetch(loaded.repository, base, { framing: "transport" });
    const again = await planFetch(loaded.repository, base, { framing: "transport" });
    expect(first.pack?.cached).toBe(false);
    expect(again.pack?.cached).toBe(true);
    expect(again.leasePacks).toEqual(first.leasePacks);
    for (const variant of variants) {
      const plan = await planFetch(loaded.repository, variant, { framing: "transport" });
      expect(plan.pack?.cached).toBe(false);
    }
    const moved = {
      ...loaded.repository,
      refs: { ...loaded.repository.refs, version: loaded.repository.refs.version + 1 },
    };
    expect((await planFetch(moved, base, { framing: "transport" })).pack?.cached).toBe(false);
    const repacked = {
      ...loaded.repository,
      cacheIdentity: { ...loaded.repository.cacheIdentity, registryVersion: 99 },
    };
    expect((await planFetch(repacked, base, { framing: "transport" })).pack?.cached).toBe(false);
    expect(await materialisedKeys(dir)).toHaveLength(1 + variants.length + 2);
  });

  it("transport and stored framing carry the same pack", async () => {
    const { source, second, tip } = await repoWithHistory();
    const loaded = await openUploadPackRepo(await serve(scratch, source));
    const args = fetchArgs({ wants: [hexOid(tip)], haves: [hexOid(second)] });
    const transport = parseFetchResponse(
      (await planAndRender(loaded, args, { framing: "transport" })).bytes,
    );
    const stored = parseFetchResponse(
      (await planAndRender(loaded, args, { framing: "stored", payloadBytes: 1000 })).bytes,
    );
    expect(Buffer.from(stored.pack as Uint8Array).equals(transport.pack as Uint8Array)).toBe(true);
  });
});
