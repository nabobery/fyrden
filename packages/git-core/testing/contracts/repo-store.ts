import { describe, expect, it } from "vitest";
import { type Oid, oidFromBytes } from "../../src/object/oid.js";
import { isPackId, type PackStore } from "../../src/ports/pack-store.js";
import type { RefStore } from "../../src/ports/ref-store.js";

const oid = (n: number) => oidFromBytes(new Uint8Array(20).fill(n));
const bytes = (...values: number[]) => Uint8Array.from(values);

/** Like Node's Buffer: `slice()` returns a view, so a store that "copies" with it aliases. */
export class ViewSlicingBytes extends Uint8Array {
  override slice(start?: number, end?: number): Uint8Array<ArrayBuffer> {
    return this.subarray(start, end) as Uint8Array<ArrayBuffer>;
  }
}

/**
 * The behaviour every `PackStore` + `RefStore` pair must have. Run it against
 * the in-memory fake here and against the Durable Object and R2 adapters.
 * `create` must return an empty repository each call.
 */
export function describeRepoStoreContract(
  name: string,
  create: () => Promise<{ packStore: PackStore; refStore: RefStore }>,
): void {
  async function writePack(packStore: PackStore, ...chunks: Uint8Array[]) {
    const writer = packStore.beginPack();
    for (const chunk of chunks) await writer.write(chunk);
    return writer.finish();
  }

  describe(`${name}: PackStore and RefStore contract`, () => {
    it("starts empty at version 0", async () => {
      const { packStore, refStore } = await create();
      expect(await packStore.listPacks()).toEqual([]);
      const snapshot = await refStore.readRefs();
      expect(snapshot.version).toBe(0);
      expect(snapshot.refs.size).toBe(0);
    });

    it("gives each pack a distinct, valid id", async () => {
      const { packStore } = await create();
      const ids = [packStore.beginPack().packId, packStore.beginPack().packId];
      expect(ids.every(isPackId)).toBe(true);
      expect(ids[0]).not.toBe(ids[1]);
    });

    it("reads a finished pack by range before it is live", async () => {
      const { packStore } = await create();
      const info = await writePack(packStore, bytes(1, 2, 3), bytes(), bytes(4, 5));
      expect(info.bytes).toBe(5);
      expect(await packStore.openRange(info.packId, 1, 3)).toEqual(bytes(2, 3, 4));
      expect(await packStore.openRange(info.packId, 5, 0)).toEqual(bytes());
      expect(await packStore.listPacks()).toEqual([]);
    });

    it("refuses ranges outside the pack and packs that do not exist", async () => {
      const { packStore } = await create();
      const { packId } = await writePack(packStore, bytes(1, 2));
      await expect(packStore.openRange(packId, 1, 2)).rejects.toThrow(RangeError);
      await expect(packStore.openRange(packId, -1, 1)).rejects.toThrow(RangeError);
      const unknown = packStore.beginPack().packId;
      await expect(packStore.openRange(unknown, 0, 0)).rejects.toThrow();
    });

    it("copies what it is given and what it returns", async () => {
      const { packStore } = await create();
      const chunk = ViewSlicingBytes.from([1, 2, 3]);
      const writer = packStore.beginPack();
      await writer.write(chunk);
      chunk.fill(9);
      const { packId } = await writer.finish();
      const read = await packStore.openRange(packId, 0, 3);
      read.fill(7);
      expect(await packStore.openRange(packId, 0, 3)).toEqual(bytes(1, 2, 3));
    });

    it("refuses writes after finish or abort, and never commits an aborted pack", async () => {
      const { packStore, refStore } = await create();
      const finished = packStore.beginPack();
      await finished.finish();
      await expect(finished.write(bytes(1))).rejects.toThrow();
      await expect(finished.finish()).rejects.toThrow();
      const aborted = packStore.beginPack();
      await aborted.write(bytes(1));
      await aborted.abort();
      await expect(aborted.write(bytes(1))).rejects.toThrow();
      await expect(packStore.openRange(aborted.packId, 0, 1)).rejects.toThrow();
      expect(
        await refStore.commit({
          addPacks: [aborted.packId],
          removePacks: [],
          refUpdates: [],
          expectedVersion: 0,
        }),
      ).toEqual({ ok: false, reason: "unknown-pack", packId: aborted.packId });
    });

    it("commits refs and packs together and bumps the version by one", async () => {
      const { packStore, refStore } = await create();
      const pack = await writePack(packStore, bytes(1, 2, 3));
      const result = await refStore.commit({
        addPacks: [pack.packId],
        removePacks: [],
        refUpdates: [{ name: "refs/heads/main", oldOid: null, newOid: oid(1) }],
        expectedVersion: 0,
      });
      expect(result).toEqual({ ok: true, version: 1 });
      expect(await packStore.listPacks()).toEqual([pack]);
      const snapshot = await refStore.readRefs();
      expect(snapshot.version).toBe(1);
      expect(snapshot.refs.get("refs/heads/main")).toEqual(oid(1));
    });

    it("updates and deletes refs only from their expected old value", async () => {
      const { refStore } = await create();
      const main = "refs/heads/main";
      await refStore.commit({
        addPacks: [],
        removePacks: [],
        refUpdates: [{ name: main, oldOid: null, newOid: oid(1) }],
        expectedVersion: 0,
      });
      expect(
        await refStore.commit({
          addPacks: [],
          removePacks: [],
          refUpdates: [{ name: main, oldOid: null, newOid: oid(2) }],
          expectedVersion: 1,
        }),
      ).toEqual({ ok: false, reason: "ref-conflict", ref: main });
      expect(
        await refStore.commit({
          addPacks: [],
          removePacks: [],
          refUpdates: [{ name: main, oldOid: oid(1), newOid: oid(2) }],
          expectedVersion: 1,
        }),
      ).toEqual({ ok: true, version: 2 });
      expect(
        await refStore.commit({
          addPacks: [],
          removePacks: [],
          refUpdates: [{ name: main, oldOid: oid(2), newOid: null }],
          expectedVersion: 2,
        }),
      ).toEqual({ ok: true, version: 3 });
      expect((await refStore.readRefs()).refs.has(main)).toBe(false);
    });

    it("changes nothing when any part of a commit conflicts", async () => {
      const { packStore, refStore } = await create();
      const old = await writePack(packStore, bytes(1));
      await refStore.commit({
        addPacks: [old.packId],
        removePacks: [],
        refUpdates: [{ name: "refs/heads/a", oldOid: null, newOid: oid(1) }],
        expectedVersion: 0,
      });
      const next = await writePack(packStore, bytes(2));
      const attempt = (over: object) =>
        refStore.commit({
          addPacks: [next.packId],
          removePacks: [old.packId],
          refUpdates: [
            { name: "refs/heads/a", oldOid: oid(1), newOid: oid(2) },
            { name: "refs/heads/b", oldOid: null, newOid: oid(3) },
          ],
          expectedVersion: 1,
          ...over,
        });
      expect(await attempt({ expectedVersion: 0 })).toEqual({
        ok: false,
        reason: "version-conflict",
        version: 1,
      });
      expect(
        await attempt({
          refUpdates: [
            { name: "refs/heads/a", oldOid: oid(1), newOid: oid(2) },
            { name: "refs/heads/b", oldOid: oid(9), newOid: oid(3) },
          ],
        }),
      ).toEqual({ ok: false, reason: "ref-conflict", ref: "refs/heads/b" });
      const unknown = packStore.beginPack().packId;
      expect(await attempt({ addPacks: [unknown] })).toEqual({
        ok: false,
        reason: "unknown-pack",
        packId: unknown,
      });
      const notLive = await writePack(packStore, bytes(3));
      expect(await attempt({ removePacks: [notLive.packId] })).toEqual({
        ok: false,
        reason: "unknown-pack",
        packId: notLive.packId,
      });
      const snapshot = await refStore.readRefs();
      expect(snapshot.version).toBe(1);
      expect([...snapshot.refs.keys()]).toEqual(["refs/heads/a"]);
      expect(snapshot.refs.get("refs/heads/a")).toEqual(oid(1));
      expect(await packStore.listPacks()).toEqual([old]);
      expect(await refStore.readReflog("refs/heads/a", 10)).toHaveLength(1);
      expect(await refStore.readReflog("refs/heads/b", 10)).toEqual([]);
      expect(await attempt({})).toEqual({ ok: true, version: 2 });
      expect(await packStore.listPacks()).toEqual([next]);
      const after = await refStore.readRefs();
      expect(after.refs.get("refs/heads/a")).toEqual(oid(2));
      expect(after.refs.get("refs/heads/b")).toEqual(oid(3));
      for (const [name, oldOid, newOid] of [
        ["refs/heads/a", oid(1), oid(2)],
        ["refs/heads/b", null, oid(3)],
      ] as const) {
        const [latest] = await refStore.readReflog(name, 1);
        expect([latest?.version, latest?.oldOid, latest?.newOid]).toEqual([2, oldOid, newOid]);
      }
    });

    it("adds a pack only once", async () => {
      const { packStore, refStore } = await create();
      const { packId } = await writePack(packStore, bytes(1));
      const add = (expectedVersion: number) =>
        refStore.commit({ addPacks: [packId], removePacks: [], refUpdates: [], expectedVersion });
      expect(await add(0)).toEqual({ ok: true, version: 1 });
      expect(await add(1)).toEqual({ ok: false, reason: "unknown-pack", packId });
    });

    it("deletes several refs in one commit", async () => {
      const { refStore } = await create();
      const names = ["refs/heads/a", "refs/heads/b"];
      await refStore.commit({
        addPacks: [],
        removePacks: [],
        refUpdates: names.map((name, i) => ({ name, oldOid: null, newOid: oid(i + 1) })),
        expectedVersion: 0,
      });
      expect(
        await refStore.commit({
          addPacks: [],
          removePacks: [],
          refUpdates: names.map((name, i) => ({ name, oldOid: oid(i + 1), newOid: null })),
          expectedVersion: 1,
        }),
      ).toEqual({ ok: true, version: 2 });
      expect((await refStore.readRefs()).refs.size).toBe(0);
    });

    it("cannot be changed through what it was given or what it returned", async () => {
      const { refStore } = await create();
      const input = oid(1);
      await refStore.commit({
        addPacks: [],
        removePacks: [],
        refUpdates: [{ name: "refs/heads/main", oldOid: null, newOid: input }],
        expectedVersion: 0,
      });
      input.fill(9);
      (await refStore.readRefs()).refs.get("refs/heads/main")?.fill(7);
      (await refStore.readReflog("refs/heads/main", 1))[0]?.newOid?.fill(7);
      expect((await refStore.readRefs()).refs.get("refs/heads/main")).toEqual(oid(1));
      expect((await refStore.readReflog("refs/heads/main", 1))[0]?.newOid).toEqual(oid(1));
    });

    it("returns no reflog entries for a limit of 0 and refuses a bad limit", async () => {
      const { refStore } = await create();
      await refStore.commit({
        addPacks: [],
        removePacks: [],
        refUpdates: [{ name: "refs/heads/main", oldOid: null, newOid: oid(1) }],
        expectedVersion: 0,
      });
      expect(await refStore.readReflog("refs/heads/main", 0)).toEqual([]);
      for (const limit of [-1, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
        await expect(refStore.readReflog("refs/heads/main", limit)).rejects.toThrow(RangeError);
      }
    });

    it("refuses malformed requests", async () => {
      const { packStore, refStore } = await create();
      const base = { addPacks: [], removePacks: [], expectedVersion: 0 };
      await expect(
        refStore.commit({
          ...base,
          refUpdates: [{ name: "refs/heads/a..b", oldOid: null, newOid: oid(1) }],
        }),
      ).rejects.toThrow(RangeError);
      await expect(
        refStore.commit({
          ...base,
          refUpdates: [
            { name: "refs/heads/a", oldOid: null, newOid: oid(1) },
            { name: "refs/heads/a", oldOid: null, newOid: oid(2) },
          ],
        }),
      ).rejects.toThrow(RangeError);
      const { packId } = await writePack(packStore, bytes(1));
      await expect(
        refStore.commit({ ...base, addPacks: [packId, packId], refUpdates: [] }),
      ).rejects.toThrow(RangeError);
      expect((await refStore.readRefs()).version).toBe(0);
    });

    it("keeps a reflog per ref, newest first", async () => {
      const { refStore } = await create();
      const name = "refs/heads/main";
      const ids: (Oid | null)[] = [null, oid(1), oid(2), null];
      for (let i = 1; i < ids.length; i++) {
        await refStore.commit({
          addPacks: [],
          removePacks: [],
          refUpdates: [{ name, oldOid: ids[i - 1] ?? null, newOid: ids[i] ?? null }],
          expectedVersion: i - 1,
        });
      }
      const log = await refStore.readReflog(name, 2);
      expect(log.map((e) => [e.version, e.oldOid, e.newOid])).toEqual([
        [3, oid(2), null],
        [2, oid(1), oid(2)],
      ]);
      expect(log.every((e) => Number.isFinite(e.at))).toBe(true);
      expect(await refStore.readReflog("refs/heads/other", 5)).toEqual([]);
    });

    describe("ref namespace (a ref and a ref below it cannot both exist)", () => {
      const creation = (name: string, n = 1) => ({ name, oldOid: null, newOid: oid(n) });
      const commitRefs = (refStore: RefStore, expectedVersion: number, ...refUpdates: object[]) =>
        refStore.commit({
          addPacks: [],
          removePacks: [],
          refUpdates: refUpdates as never,
          expectedVersion,
        });
      const unchanged = async (refStore: RefStore, version: number, names: string[]) => {
        const snapshot = await refStore.readRefs();
        expect(snapshot.version).toBe(version);
        expect([...snapshot.refs.keys()].sort()).toEqual([...names].sort());
      };

      it("refuses creating a ref below an existing ref", async () => {
        const { packStore, refStore } = await create();
        expect(await commitRefs(refStore, 0, creation("refs/heads/topic"))).toEqual({
          ok: true,
          version: 1,
        });
        const pack = await writePack(packStore, bytes(1));
        expect(
          await refStore.commit({
            addPacks: [pack.packId],
            removePacks: [],
            refUpdates: [creation("refs/heads/topic/sub"), creation("refs/heads/other")],
            expectedVersion: 1,
          }),
        ).toEqual({
          ok: false,
          reason: "refname-conflict",
          ref: "refs/heads/topic/sub",
          conflictsWith: "refs/heads/topic",
        });
        await unchanged(refStore, 1, ["refs/heads/topic"]);
        expect(await packStore.listPacks()).toEqual([]);
        expect(await refStore.readReflog("refs/heads/topic/sub", 5)).toEqual([]);
        expect(
          await commitRefs(refStore, 1, creation("refs/heads/topic/sub/deeper")),
        ).toMatchObject({ reason: "refname-conflict", conflictsWith: "refs/heads/topic" });
      });

      it("refuses creating a ref above an existing ref", async () => {
        const { refStore } = await create();
        await commitRefs(refStore, 0, creation("refs/tags/a/b/c"));
        for (const name of ["refs/tags/a", "refs/tags/a/b"]) {
          expect(await commitRefs(refStore, 1, creation(name))).toEqual({
            ok: false,
            reason: "refname-conflict",
            ref: name,
            conflictsWith: "refs/tags/a/b/c",
          });
        }
        await unchanged(refStore, 1, ["refs/tags/a/b/c"]);
      });

      it("refuses two colliding creations in one request", async () => {
        const { refStore } = await create();
        expect(
          await commitRefs(refStore, 0, creation("refs/heads/x/y"), creation("refs/heads/x")),
        ).toEqual({
          ok: false,
          reason: "refname-conflict",
          ref: "refs/heads/x",
          conflictsWith: "refs/heads/x/y",
        });
        await unchanged(refStore, 0, []);
      });

      it("refuses a creation below a ref the same request updates", async () => {
        const { refStore } = await create();
        await commitRefs(refStore, 0, creation("refs/heads/x"));
        expect(
          await commitRefs(
            refStore,
            1,
            { name: "refs/heads/x", oldOid: oid(1), newOid: oid(2) },
            creation("refs/heads/x/y"),
          ),
        ).toMatchObject({ ok: false, reason: "refname-conflict", ref: "refs/heads/x/y" });
        await unchanged(refStore, 1, ["refs/heads/x"]);
      });

      it("lets a deletion in the same request free the name", async () => {
        const { refStore } = await create();
        await commitRefs(refStore, 0, creation("refs/heads/topic"), creation("refs/heads/q/y"));
        expect(
          await commitRefs(
            refStore,
            1,
            creation("refs/heads/topic/sub"),
            { name: "refs/heads/topic", oldOid: oid(1), newOid: null },
            { name: "refs/heads/q/y", oldOid: oid(1), newOid: null },
            creation("refs/heads/q"),
          ),
        ).toEqual({ ok: true, version: 2 });
        await unchanged(refStore, 2, ["refs/heads/topic/sub", "refs/heads/q"]);
      });

      it("does not confuse names that merely share a prefix", async () => {
        const { refStore } = await create();
        await commitRefs(
          refStore,
          0,
          creation("refs/heads/ab"),
          creation("refs/heads/a-b/c"),
          creation("refs/heads/a.b"),
        );
        expect(await commitRefs(refStore, 1, creation("refs/heads/a"))).toEqual({
          ok: true,
          version: 2,
        });
      });
    });

    it("lets exactly one of two racing commits win", async () => {
      const { refStore } = await create();
      const results = await Promise.all(
        [1, 2].map((n) =>
          refStore.commit({
            addPacks: [],
            removePacks: [],
            refUpdates: [{ name: "refs/heads/main", oldOid: null, newOid: oid(n) }],
            expectedVersion: 0,
          }),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect((await refStore.readRefs()).version).toBe(1);
    });
  });
}
