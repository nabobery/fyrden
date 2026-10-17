import { type Oid, oidFromBytes, oidToHex } from "../object/oid.js";
import type { IdxLocation, IdxReadBudget } from "../pack/idx-read.js";
import type { PackStore } from "../ports/pack-store.js";
import type { RepoView, ViewPack } from "../reader/view.js";

type Found = IdxLocation | undefined;

/** Most `.idx` reads one single lookup makes: the bucket's oids, the CRC32, the offset and a 64-bit offset. */
const MAX_LOOKUP_READS = 4;

/**
 * The repository's packs as one indexing step sees them. Every `.idx`
 * lookup is remembered for the step, so locating an object and then
 * reading it through a reader opened on `view` costs one lookup; many
 * objects are located together with coalesced reads (`lookupMany`); and
 * the step's store calls are counted: pack reads, and the `.idx` reads
 * each index reports (an index held in memory reads nothing).
 */
export class StepView {
  readonly view: RepoView;
  readonly packStore: Pick<PackStore, "openRange">;
  readonly #packs: readonly ViewPack[];
  /** Per pack: lookup results by oid hex (undefined: not in that pack). */
  readonly #memo: Map<string, Found | Promise<Found>>[];
  #packCalls = 0;
  /** Every `.idx` read of the step, counted by the indexes. */
  readonly #idxReads: IdxReadBudget = { reads: 0, maxReads: Number.POSITIVE_INFINITY };

  constructor(view: RepoView, packStore: Pick<PackStore, "openRange">) {
    this.#packs = view.packs;
    this.#memo = view.packs.map(() => new Map());
    this.view = {
      scope: view.scope,
      packs: view.packs.map((pack, i) => ({
        ...pack,
        idx: {
          lookup: (oid: Uint8Array, at = 0) => this.#lookup(i, oid, at),
          crc32At: (position: number) => pack.idx.crc32At(position, this.#idxReads),
        },
      })),
    };
    this.packStore = {
      openRange: (packId, offset, length) => {
        this.#packCalls++;
        return packStore.openRange(packId, offset, length);
      },
    };
  }

  /** Store calls made through this view so far: pack reads and `.idx` reads. */
  get calls(): number {
    return this.#packCalls + this.#idxReads.reads;
  }

  /** The first pack of the view holding `oid` (the one a reader uses), or undefined. */
  async locate(oid: Oid): Promise<ViewPack | undefined> {
    return (await this.locateMany([oid]))[0] ?? undefined;
  }

  /**
   * The first pack holding each oid, or undefined. Each pack is asked once
   * for every oid not found before it, in one batched lookup when its
   * index has one; the answers are remembered for later reads.
   *
   * With `maxCalls`, no `.idx` read starts that could take `calls` past
   * it; an oid it leaves unanswered is `null` (a later step asks again).
   */
  async locateMany(
    oids: readonly Oid[],
    maxCalls = Number.POSITIVE_INFINITY,
  ): Promise<(ViewPack | undefined | null)[]> {
    const result: (ViewPack | undefined | null)[] = oids.map(() => undefined);
    let open = oids.map((_, i) => i);
    for (const [p, pack] of this.view.packs.entries()) {
      if (open.length === 0) break;
      const original = this.#packs[p] as ViewPack;
      const candidates = open.filter(
        (i) => !pack.summary || pack.summary.mayContain(oids[i] as Oid),
      );
      const unanswered = await this.#prefetch(
        p,
        original,
        candidates.map((i) => oids[i] as Oid),
        maxCalls,
      );
      const settled = new Set<number>();
      const memo = this.#memo[p] as Map<string, Found | Promise<Found>>;
      for (const i of candidates) {
        const oid = oids[i] as Oid;
        const hex = oidToHex(oid);
        // Without a batched answer, a single lookup starts only when all its reads fit.
        if (unanswered.has(hex) || (!memo.has(hex) && this.calls + MAX_LOOKUP_READS > maxCalls)) {
          result[i] = null;
          settled.add(i);
        } else if (await this.#lookup(p, oid, 0)) {
          result[i] = pack;
          settled.add(i);
        }
      }
      open = open.filter((i) => !settled.has(i));
    }
    return result;
  }

  /**
   * Fills the memo for `oids` in pack `p` with one batched lookup, when the
   * index has it. Returns the oids (hex) the allowance left unanswered.
   */
  async #prefetch(
    p: number,
    pack: ViewPack,
    oids: readonly Oid[],
    maxCalls: number,
  ): Promise<Set<string>> {
    const unanswered = new Set<string>();
    const memo = this.#memo[p] as Map<string, Found | Promise<Found>>;
    const missing = [...new Map(oids.map((oid) => [oidToHex(oid), oid])).entries()].filter(
      ([hex]) => !memo.has(hex),
    );
    if (missing.length === 0 || !pack.idx.lookupMany) return unanswered;
    const budget: IdxReadBudget = { reads: 0, maxReads: Math.max(0, maxCalls - this.calls) };
    try {
      const found = await pack.idx.lookupMany(
        missing.map(([, oid]) => oid),
        budget,
      );
      // Unanswered oids stay out of the memo, for a later step to ask again.
      for (const [k, [hex]] of missing.entries()) {
        const answer = found[k];
        if (answer === null) unanswered.add(hex);
        else memo.set(hex, answer);
      }
    } finally {
      this.#idxReads.reads += budget.reads;
    }
    return unanswered;
  }

  #lookup(p: number, oid: Uint8Array, at: number): Found | Promise<Found> {
    const memo = this.#memo[p] as Map<string, Found | Promise<Found>>;
    const key = oidToHex(oidFromBytes(oid, at));
    if (memo.has(key)) return memo.get(key);
    const pending = Promise.resolve(
      (this.#packs[p] as ViewPack).idx.lookup(oid, at, this.#idxReads),
    );
    memo.set(key, pending);
    return pending;
  }
}
