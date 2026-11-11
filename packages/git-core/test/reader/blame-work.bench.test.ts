import { describe, expect, it } from "vitest";
import { BLAME_DECODING_WORK } from "../../src/blame/walk.js";
import { ObjectReader } from "../../src/reader/object-reader.js";
import type { RepoView } from "../../src/reader/view.js";
import { createReaderWorkMeter, type ReaderWorkKind } from "../../src/reader/work.js";
import { createMemoryBudget } from "../../testing/fakes/memory-budget.js";
import { createMemoryRepoStore } from "../../testing/fakes/memory-repo-store.js";
import { createNodeZlib } from "../../testing/node-zlib.js";
import { buildPack, gitOid, makeDelta, type PackEntrySpec } from "../pack/pack-builder.js";
import { prng } from "../pack/repo-fixture.js";
import { loadPack, MiB, toOid } from "./support.js";

/*
 * What a step through long delta chains charges, against the bytes it builds:
 * a decoding-work limit has to leave room for the steps real packs need. Runs
 * only on request:
 *
 *   FYRDEN_BENCH=1 npx vitest run test/reader/blame-work.bench.test.ts
 */

const bench = process.env.FYRDEN_BENCH === "1";
const DEPTH = 50;

function chainOf(size: number, editBytes: number, seed: number) {
  const rand = prng(seed);
  const first = new Uint8Array(size);
  for (let k = 0; k < size; k++) first[k] = 32 + Math.floor(rand() * 90);
  const entries: PackEntrySpec[] = [{ kind: "blob", data: first }];
  let current = first;
  for (let depth = 1; depth <= DEPTH; depth++) {
    // Rewrites the tail, so programs are mostly copies plus one literal run.
    const next = current.slice();
    for (let k = size - editBytes; k < size; k++) next[k] = 32 + Math.floor(rand() * 90);
    entries.push({ kind: "ofs", base: depth - 1, delta: makeDelta(current, next) });
    current = next;
  }
  return { entries, tip: gitOid("blob", current) };
}

describe.skipIf(!bench)("work charged through long delta chains", () => {
  for (const [title, size, editBytes] of [
    ["3.48 MiB, 4 KiB edits", 3.48 * MiB, 4096],
    ["2 MiB, 4 KiB edits", 2 * MiB, 4096],
    ["2.25 MiB, 4 KiB edits", 2.25 * MiB, 4096],
    ["2.5 MiB, 4 KiB edits", 2.5 * MiB, 4096],
    ["1 MiB, 64 KiB edits", MiB, 64 * 1024],
    ["3.48 MiB, 48 KiB edits", 3.48 * MiB, 48 * 1024],
    ["3.48 MiB, 64 KiB edits", 3.48 * MiB, 64 * 1024],
    ["3.48 MiB, 80 KiB edits", 3.48 * MiB, 80 * 1024],
    ["3.48 MiB, 256 KiB edits", 3.48 * MiB, 256 * 1024],
    ["1 MiB, 4 KiB edits", MiB, 4096],
    ["64 KiB, 1 KiB edits", 64 * 1024, 1024],
  ] as const) {
    it(`two chains of depth ${DEPTH}, ${title}`, async () => {
      const whole = Math.floor(size);
      const a = chainOf(whole, editBytes, 1);
      const b = chainOf(whole, editBytes, 2);
      const repo = createMemoryRepoStore();
      const offset = a.entries.length;
      const entries = [
        ...a.entries,
        ...b.entries.map((entry) =>
          entry.kind === "ofs" ? { ...entry, base: (entry.base as number) + offset } : entry,
        ),
      ];
      const view: RepoView = {
        scope: "net-work",
        packs: [await loadPack(repo.packStore, buildPack(entries).bytes)],
      };
      const meter = createReaderWorkMeter({
        limit: Number.MAX_SAFE_INTEGER,
        weights: BLAME_DECODING_WORK.weights,
      });
      const byKind = new Map<ReaderWorkKind, number>();
      const reader = await ObjectReader.open({
        view,
        packStore: repo.packStore,
        zlib: createNodeZlib(),
        memory: createMemoryBudget(64 * MiB),
        limits: { maxObjectBytes: 4 * MiB, deltaBaseCacheBytes: 8 * MiB },
        strictDeltaCache: true,
        work: {
          charge(kind, units) {
            byKind.set(kind, (byKind.get(kind) ?? 0) + units);
            meter.charge(kind, units);
          },
        },
      });
      await reader.readObject(toOid(a.tip));
      await reader.readObject(toOid(b.tip));
      reader.release();
      const builtBytes = (byKind.get("delta-result") ?? 0) + 2 * whole;
      console.log(
        `chain ${title}: built ${(builtBytes / MiB).toFixed(0)} MiB, charged ${(meter.spent() / MiB).toFixed(0)} M units, ${(meter.spent() / builtBytes).toFixed(2)} a byte built, ${JSON.stringify(Object.fromEntries([...byKind].map(([kind, units]) => [kind, Math.round(units / MiB)])))}`,
      );
      expect(meter.spent()).toBeGreaterThan(builtBytes);
    }, 600_000);
  }
});
