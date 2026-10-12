import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isObjectType } from "../../src/object/object.js";
import { oidToHex } from "../../src/object/oid.js";
import type { PackIdx } from "../../src/pack/idx-read.js";
import { ObjectReader } from "../../src/reader/object-reader.js";
import { createMemoryBlockCache } from "../../testing/fakes/memory-block-cache.js";
import { createMemoryBudget } from "../../testing/fakes/memory-budget.js";
import { createMemoryRepoStore } from "../../testing/fakes/memory-repo-store.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";
import { createNodeZlib } from "../../testing/node-zlib.js";
import { buildPack, type WholeType } from "../pack/pack-builder.js";
import { parseBytes } from "../pack/parse-helpers.js";
import { buildRepo, packObjects } from "../pack/repo-fixture.js";
import { catFileBatch, hex, idxOids, loadPack, MiB } from "./support.js";

/*
 * A pack unit: a received thin pack, whose REF_DELTAs name bases outside
 * it, stored next to a completion pack holding exactly those bases. The
 * reader resolves REF_DELTA bases by oid across the whole view, so the two
 * read like one pack, whichever comes first in the view.
 */

let sandbox: GitSandbox;
let thin: Uint8Array;
let completion: Uint8Array;
beforeAll(async () => {
  sandbox = await createGitSandbox();
  await buildRepo(sandbox, { seed: 515, commits: 14, files: 4, binaryBytes: 3000 });
  thin = await packObjects(sandbox, { thin: true, revs: ["main", "^main~4"], window: 20 });
  const { pack } = await parseBytes(thin, {
    externalBase: async (oid) => {
      const type = (await sandbox.git(["cat-file", "-t", oidToHex(oid)])).stdout.trim();
      if (!isObjectType(type)) return undefined;
      return { type, data: await sandbox.gitBytes(["cat-file", type, oidToHex(oid)]) };
    },
  });
  expect(pack.thinBases.length).toBeGreaterThan(0);
  const bases = await catFileBatch(sandbox, pack.thinBases.map(oidToHex));
  completion = buildPack(
    [...bases.values()].map((o) => ({ kind: o.type as WholeType, data: o.bytes })),
  ).bytes;
  pack.release();
}, 60_000);
afterAll(() => sandbox.dispose());

describe("reader: thin pack plus completion pack", () => {
  for (const completionFirst of [false, true]) {
    it(`reads every object of the unit (completion pack ${completionFirst ? "first" : "second"})`, async () => {
      const { packStore } = createMemoryRepoStore();
      // The thin pack is indexed against the completion pack's objects, as on receive.
      const { objects } = await parseBytes(completion);
      const thinPack = await loadPack(packStore, thin, async (oid) => {
        const found = objects.get(oidToHex(oid));
        return found && isObjectType(found.type)
          ? { type: found.type, data: found.data }
          : undefined;
      });
      const completionPack = await loadPack(packStore, completion);
      const packs = completionFirst ? [completionPack, thinPack] : [thinPack, completionPack];
      const reader = await ObjectReader.open({
        view: { scope: "net-thin", packs },
        packStore,
        zlib: createNodeZlib(),
        memory: createMemoryBudget(64 * MiB),
        blockCache: createMemoryBlockCache(),
      });
      try {
        const oids = [
          ...idxOids(thinPack.idx as PackIdx),
          ...idxOids(completionPack.idx as PackIdx),
        ];
        const expected = await catFileBatch(sandbox, oids.map(hex));
        expect(expected.size).toBe(oids.length);
        for (const oid of oids) {
          const object = await reader.readObject(oid);
          expect(object?.type).toBe(expected.get(hex(oid))?.type);
          expect(hex(object?.bytes as Uint8Array)).toBe(
            hex(expected.get(hex(oid))?.bytes as Uint8Array),
          );
          expect(await reader.readHeader(oid)).toEqual({
            type: object?.type,
            size: object?.bytes.length,
          });
        }
        let walked = 0;
        await reader.walk(oids, ({ oid, bytes }) => {
          walked++;
          expect(hex(bytes)).toBe(hex(expected.get(hex(oid))?.bytes as Uint8Array));
        });
        expect(walked).toBe(oids.length);
      } finally {
        reader.release();
      }
    });
  }
});
