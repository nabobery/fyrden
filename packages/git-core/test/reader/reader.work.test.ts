import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { BLAME_DECODING_WORK } from "../../src/blame/walk.js";
import { PackError } from "../../src/pack/errors.js";
import type { PackStore } from "../../src/ports/pack-store.js";
import type { Zlib } from "../../src/ports/zlib.js";
import { ObjectReader, ReaderWorkSpent } from "../../src/reader/object-reader.js";
import type { RepoView } from "../../src/reader/view.js";
import {
  createReaderWorkMeter,
  type ReaderWork,
  type ReaderWorkKind,
} from "../../src/reader/work.js";
import { createMemoryBlockCache } from "../../testing/fakes/memory-block-cache.js";
import { createMemoryBudget } from "../../testing/fakes/memory-budget.js";
import { createMemoryRepoStore } from "../../testing/fakes/memory-repo-store.js";
import { createNodeZlib } from "../../testing/node-zlib.js";
import {
  buildPack,
  encodeDelta,
  gitOid,
  makeDelta,
  type PackEntrySpec,
  text,
} from "../pack/pack-builder.js";
import { prng } from "../pack/repo-fixture.js";
import { loadPack, MiB, toOid } from "./support.js";

/*
 * The optional work port is charged before each decoding primitive, so a
 * primitive refused by it never runs: nothing it would have done is done, and
 * a reader over a limit costs no more than the limit. A warm read costs too:
 * no store call and no inflate, but it copies blocks and looks things up.
 */

const KiB = 1024;
const BLOCK = 64 * KiB;

type Event = { readonly charge: string; readonly units: number } | { readonly ran: string };

/** The port, the store and zlib, logging in order into `events`. */
function logged(events: Event[], refuseAt = Number.POSITIVE_INFINITY) {
  let charges = 0;
  const work: ReaderWork = {
    charge(kind, units) {
      charges++;
      events.push({ charge: kind, units });
      if (charges >= refuseAt) throw new ReaderWorkSpent(refuseAt);
    },
  };
  const real = createNodeZlib();
  const zlib: Zlib = {
    inflate(input, options) {
      events.push({ ran: "inflate" });
      return real.inflate(input, options);
    },
    deflate: (input, options) => real.deflate(input, options),
  };
  return { work, zlib, charges: () => charges };
}

function loggedStore(events: Event[], inner: Pick<PackStore, "openRange">) {
  return {
    openRange(packId: Parameters<PackStore["openRange"]>[0], offset: number, length: number) {
      events.push({ ran: "store" });
      return inner.openRange(packId, offset, length);
    },
  };
}

async function open(entries: readonly PackEntrySpec[]) {
  const repo = createMemoryRepoStore();
  const pack = await loadPack(repo.packStore, buildPack(entries).bytes);
  const view: RepoView = { scope: "net-work", packs: [pack] };
  return { view, store: repo.packStore };
}

function randomBytes(n: number, seed = 5): Uint8Array {
  const rand = prng(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rand() * 256);
  return out;
}

const charged = (events: readonly Event[]) =>
  events.flatMap((e) => ("charge" in e ? [`${e.charge}:${e.units}`] : []));

describe("reader: work port", () => {
  const base = text("base\n".repeat(50));
  const mid = text(`${"base\n".repeat(50)}mid\n`);
  const tip = text(`${"base\n".repeat(50)}mid\ntip\n`);
  const chain: PackEntrySpec[] = [
    { kind: "blob", data: base },
    { kind: "ofs", base: 0, delta: makeDelta(base, mid) },
    { kind: "ofs", base: 1, delta: makeDelta(mid, tip) },
  ];
  const tipOid = toOid(gitOid("blob", tip));

  it("charges each primitive of a cold chain before it runs", async () => {
    const { view, store } = await open(chain);
    const events: Event[] = [];
    const { work, zlib } = logged(events);
    const reader = await ObjectReader.open({
      view,
      packStore: loggedStore(events, store),
      zlib,
      memory: createMemoryBudget(64 * MiB),
      work,
    });
    const object = await reader.readObject(tipOid);
    expect(object?.bytes).toEqual(tip);

    // Each run of the store or zlib directly follows the charge that paid for it.
    events.forEach((event, at) => {
      if (!("ran" in event)) return;
      const before = events[at - 1];
      expect(before && "charge" in before ? before.charge : undefined).toBe(
        event.ran === "store" ? "block-run" : "inflate",
      );
    });
    expect(events[0]).toEqual({ charge: "lookup", units: KiB });
    const kinds = events.flatMap((e) => ("charge" in e ? [e.charge] : []));
    expect(kinds.filter((k) => k === "delta-program")).toHaveLength(2);
    expect(kinds.filter((k) => k === "delta-result")).toHaveLength(2);
    expect(kinds.filter((k) => k === "inflate")).toHaveLength(3);
    expect(kinds.at(-1)).toBe("returned-copy");
    expect(charged(events)).toContain(`delta-result:${tip.length}`);
    expect(charged(events)).toContain(`delta-result:${mid.length}`);
    expect(charged(events).at(-1)).toBe(`returned-copy:${tip.length}`);
    reader.release();
  });

  it("charges the span and the declared size for an inflate", async () => {
    const data = randomBytes(1000);
    const { view, store } = await open([{ kind: "blob", data }]);
    const events: Event[] = [];
    const { work, zlib } = logged(events);
    const reader = await ObjectReader.open({
      view,
      packStore: store,
      zlib,
      memory: createMemoryBudget(64 * MiB),
      work,
    });
    await reader.readObject(toOid(gitOid("blob", data)));
    const inflates = events.flatMap((e) =>
      "charge" in e && e.charge === "inflate" ? [e.units] : [],
    );
    // The whole object in one attempt: what's given is at least the stream, and at most the first read.
    expect(inflates).toHaveLength(1);
    const stream = deflateSync(data).length;
    expect(inflates[0]).toBeGreaterThanOrEqual(stream + 1000);
    expect(inflates[0]).toBeLessThanOrEqual(1000 + (1000 >> 6) + 64 + 1000);
    reader.release();
  });

  it("charges every attempt when a stream needs more input", async () => {
    const data = randomBytes(3 * MiB);
    const { view, store } = await open([{ kind: "blob", data }]);
    const events: Event[] = [];
    const { work, zlib } = logged(events);
    const reader = await ObjectReader.open({
      view,
      packStore: store,
      zlib,
      memory: createMemoryBudget(64 * MiB),
      work,
    });
    expect((await reader.readObject(toOid(gitOid("blob", data))))?.bytes).toEqual(data);
    const inflates = events.flatMap((e) =>
      "charge" in e && e.charge === "inflate" ? [e.units] : [],
    );
    const ran = events.filter((e) => "ran" in e && e.ran === "inflate");
    expect(inflates.length).toBe(ran.length);
    // 1 MiB, then 2, then the 3 MiB it takes: attempts that stopped are paid for.
    expect(inflates.length).toBeGreaterThanOrEqual(3);
    reader.release();
    // Under coverage in CI this took 29 s, against the 30 s default.
  }, 120_000);

  it("charges a warm read: the lookup, the blocks and the returned copy, with no store call", async () => {
    const { view, store } = await open(chain);
    const blockCache = createMemoryBlockCache();
    const open2 = async (events: Event[]) =>
      ObjectReader.open({
        view,
        packStore: loggedStore(events, store),
        zlib: logged(events).zlib,
        memory: createMemoryBudget(64 * MiB),
        blockCache,
        work: logged(events).work,
      });
    const first = await open2([]);
    await first.readObject(tipOid);
    first.release();

    const events: Event[] = [];
    const reader = await open2(events);
    await reader.readObject(tipOid);
    expect(events.some((e) => "ran" in e && e.ran === "store")).toBe(false);
    const blocks = events.flatMap((e) =>
      "charge" in e && e.charge === "block-run" ? [e.units] : [],
    );
    expect(blocks.length).toBeGreaterThan(0);
    for (const units of blocks) expect(units % BLOCK).toBe(0);

    // The cache has it now: a second read inflates nothing, and still pays.
    events.length = 0;
    await reader.readObject(tipOid);
    expect(charged(events)).toEqual(["lookup:1024", `returned-copy:${tip.length}`]);
    reader.release();
  });

  it("charges a block run by the blocks it touches, known before the cache is asked", async () => {
    const data = randomBytes(200 * KiB);
    const { view, store } = await open([{ kind: "blob", data }]);
    const events: Event[] = [];
    const reader = await ObjectReader.open({
      view,
      packStore: loggedStore(events, store),
      zlib: logged(events).zlib,
      memory: createMemoryBudget(64 * MiB),
      work: logged(events).work,
    });
    await reader.readObject(toOid(gitOid("blob", data)));
    const blocks = events.flatMap((e) =>
      "charge" in e && e.charge === "block-run" ? [e.units] : [],
    );
    // A short header read, then the whole body from its start, at least 200 KiB: four blocks.
    expect(blocks).toEqual([BLOCK, 4 * BLOCK]);
    reader.release();
  });

  it("charges a run that starts past the first block by the blocks it touches", async () => {
    const before = randomBytes(100 * KiB);
    const data = randomBytes(KiB, 6);
    const { view, store } = await open([
      { kind: "blob", data: before },
      { kind: "blob", data },
    ]);
    const events: Event[] = [];
    const reader = await ObjectReader.open({
      view,
      packStore: loggedStore(events, store),
      zlib: logged(events).zlib,
      memory: createMemoryBudget(64 * MiB),
      work: logged(events).work,
    });
    await reader.readObject(toOid(gitOid("blob", data)));
    const blocks = events.flatMap((e) =>
      "charge" in e && e.charge === "block-run" ? [e.units] : [],
    );
    // The second entry lies wholly in the second block: one block a read.
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every((units) => units === BLOCK)).toBe(true);
    reader.release();
  });

  it("charges a header read: the flat lookup, then the program's inflate for a delta", async () => {
    const { view, store } = await open(chain);
    const events: Event[] = [];
    const { work, zlib } = logged(events);
    const reader = await ObjectReader.open({
      view,
      packStore: store,
      zlib,
      memory: createMemoryBudget(64 * MiB),
      work,
    });
    expect(await reader.readHeader(tipOid)).toEqual({ type: "blob", size: tip.length });
    const kinds = events.flatMap((e) => ("charge" in e ? [e.charge] : []));
    expect(kinds[0]).toBe("lookup");
    expect(kinds.filter((k) => k === "inflate")).toHaveLength(1);
    expect(kinds).not.toContain("delta-result");
    expect(kinds).not.toContain("returned-copy");
    reader.release();
  });

  it("makes no returned-copy charge when nothing was copied", async () => {
    const data = text("over the cache\n".repeat(100));
    const { view, store } = await open([{ kind: "blob", data }]);
    const events: Event[] = [];
    const { work, zlib } = logged(events);
    const reader = await ObjectReader.open({
      view,
      packStore: store,
      zlib,
      memory: createMemoryBudget(64 * MiB),
      limits: { deltaBaseCacheBytes: 16 },
      work,
    });
    expect((await reader.readObject(toOid(gitOid("blob", data))))?.bytes).toEqual(data);
    const kinds = events.flatMap((e) => ("charge" in e ? [e.charge] : []));
    expect(kinds).not.toContain("returned-copy");
    reader.release();
  });

  it("runs nothing after a refused charge, wherever the refusal falls", async () => {
    const { view, store } = await open(chain);
    const counting: Event[] = [];
    const baseline = logged(counting);
    const reader = await ObjectReader.open({
      view,
      packStore: store,
      zlib: baseline.zlib,
      memory: createMemoryBudget(64 * MiB),
      work: baseline.work,
    });
    await reader.readObject(tipOid);
    reader.release();
    const total = baseline.charges();
    expect(total).toBeGreaterThan(5);

    for (let refuseAt = 1; refuseAt <= total; refuseAt++) {
      const events: Event[] = [];
      const { work, zlib } = logged(events, refuseAt);
      const refused = await ObjectReader.open({
        view,
        packStore: loggedStore(events, store),
        zlib,
        memory: createMemoryBudget(64 * MiB),
        work,
      });
      await expect(refused.readObject(tipOid)).rejects.toBeInstanceOf(ReaderWorkSpent);
      expect(events.at(-1)).toHaveProperty("charge");
      refused.release();
    }
  });

  it("leaves a reader usable after a refusal", async () => {
    const { view, store } = await open(chain);
    const meter = createReaderWorkMeter({ limit: 1 });
    const reader = await ObjectReader.open({
      view,
      packStore: store,
      zlib: createNodeZlib(),
      memory: createMemoryBudget(64 * MiB),
      work: meter,
    });
    await expect(reader.readObject(tipOid)).rejects.toBeInstanceOf(ReaderWorkSpent);
    reader.release();
  });

  it("keeps a delta's own error, with the entry's offset", async () => {
    // A pack the parser would refuse, so it reaches the reader through a hand-made index.
    const delta = encodeDelta(999, 10, [{ insert: text("0123456789") }]);
    const { bytes, offsets } = buildPack([
      { kind: "blob", data: base },
      { kind: "ofs", base: 0, delta },
    ]);
    const repo = createMemoryRepoStore();
    const writer = repo.packStore.beginPack();
    await writer.write(bytes);
    const info = await writer.finish();
    const at = offsets[1] as number;
    const view: RepoView = {
      scope: "net-bad",
      packs: [
        {
          packId: info.packId,
          bytes: info.bytes,
          idx: {
            lookup: async () => ({ position: 0, offset: at }),
            crc32At: async () => 0,
          },
        },
      ],
    };
    const events: Event[] = [];
    const { work, zlib } = logged(events);
    const reader = await ObjectReader.open({
      view,
      packStore: repo.packStore,
      zlib,
      memory: createMemoryBudget(64 * MiB),
      work,
    });
    const failed = await reader.readObject(new Uint8Array(20)).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(PackError);
    expect((failed as PackError).code).toBe("delta-base-size-mismatch");
    expect((failed as PackError).offset).toBe(at);
    reader.release();
  });
});

describe("createReaderWorkMeter", () => {
  it("takes blame's limit and weights", () => {
    const meter = createReaderWorkMeter(BLAME_DECODING_WORK);
    meter.charge("delta-program", 2);
    meter.charge("tree-scan", 2);
    meter.charge("inflate", 2);
    expect(meter.spent()).toBe(2 * 30 + 2 * 3 + 2);
    expect(() => meter.charge("inflate", BLAME_DECODING_WORK.limit)).toThrow(ReaderWorkSpent);
  });

  it("adds units by weight and counts up to its limit exactly", () => {
    const meter = createReaderWorkMeter({ limit: 100, weights: { "delta-program": 4 } });
    meter.charge("inflate", 60);
    meter.charge("delta-program", 10);
    expect(meter.spent()).toBe(100);
    expect(() => meter.charge("lookup", 1)).toThrow(ReaderWorkSpent);
  });

  it("refuses a charge that would pass the limit, before it is spent", () => {
    const meter = createReaderWorkMeter({ limit: 100 });
    meter.charge("inflate", 90);
    expect(() => meter.charge("inflate", 11)).toThrow(ReaderWorkSpent);
    expect(meter.spent()).toBe(90);
    meter.charge("inflate", 10);
    expect(meter.spent()).toBe(100);
  });

  it("refuses a bad limit, weight or charge", () => {
    expect(() => createReaderWorkMeter({ limit: 0 })).toThrow(
      new RangeError("a work limit must be at least 1, not 0"),
    );
    expect(() => createReaderWorkMeter({ limit: 1, weights: { inflate: -1 } })).toThrow(
      new RangeError("bad weight -1 for inflate"),
    );
    const meter = createReaderWorkMeter({ limit: 1 });
    expect(() => meter.charge("inflate", -1)).toThrow(/bad work charge -1 for inflate/);
  });

  it("refuses a weight or charge that isn't finite, which would make the count NaN", () => {
    for (const weight of [Number.POSITIVE_INFINITY, Number.NaN])
      expect(() =>
        createReaderWorkMeter({ limit: 10, weights: { "returned-copy": weight } }),
      ).toThrow(new RangeError(`bad weight ${weight} for returned-copy`));
    const free = createReaderWorkMeter({ limit: 10, weights: { inflate: 0 } });
    expect(() => free.charge("inflate", Number.POSITIVE_INFINITY)).toThrow(
      /bad work charge Infinity for inflate/,
    );
    expect(() => free.charge("inflate", Number.NaN)).toThrow(/bad work charge NaN for inflate/);
    expect(free.spent()).toBe(0);
  });

  it("keeps the weights it checked, whatever happens to the object they came in", () => {
    const weights: Partial<Record<ReaderWorkKind, number>> = { inflate: 2 };
    const meter = createReaderWorkMeter({ limit: 10, weights });
    weights.inflate = Number.NaN;
    meter.charge("inflate", 3);
    expect(meter.spent()).toBe(6);
  });

  it("takes a charge of nothing, as an empty object's scan is", () => {
    const meter = createReaderWorkMeter({ limit: 1 });
    meter.charge("tree-scan", 0);
    expect(meter.spent()).toBe(0);
  });

  it("takes a weight of nothing, which makes that kind free", () => {
    const meter = createReaderWorkMeter({ limit: 1, weights: { inflate: 0 } });
    meter.charge("inflate", 1000);
    expect(meter.spent()).toBe(0);
  });

  it("names the limit it stopped at", () => {
    const meter = createReaderWorkMeter({ limit: 5 });
    const error = (() => {
      try {
        meter.charge("inflate", 6);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(ReaderWorkSpent);
    expect(error).toMatchObject({ name: "ReaderWorkSpent", limit: 5 });
    expect((error as Error).message).toBe("decoding took more than 5 units of work");
  });
});
