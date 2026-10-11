import type { ObjectType } from "../object/object.js";
import { compareOids, OID_BYTES, type Oid, oidFromBytes, oidToHex } from "../object/oid.js";
import type { MemoryBudget, MemoryReservation } from "../ports/memory-budget.js";
import type { Zlib } from "../ports/zlib.js";
import { crc32 } from "./crc32.js";
import { applyDelta } from "./delta-apply.js";
import { PackError } from "./errors.js";
import type { PackIndexState } from "./index-state.js";
import { inflateEntry, NeedMoreInput } from "./inflate.js";
import { reservePackMemory } from "./memory.js";
import { receivedObjectId } from "./object-id.js";
import type { ExternalBaseLookup, PackLimits, PackObject, PackRangeReader } from "./parse.js";
import { resolveThinBases } from "./thin.js";

/*
 * Pass 2: rebuild every delta. Resolution starts from objects whose ids are
 * known (whole objects in the pack, then external bases for a thin pack) and
 * walks each one's delta children depth first, so it does not depend on
 * entry order: a REF_DELTA whose base comes later in the pack resolves
 * like any other. Every entry is resolved at most once, and OFS bases
 * always precede their deltas, so the walk cannot loop; deltas left over at
 * the end belong to a missing base or a REF_DELTA cycle.
 *
 * Bases on the current chain are kept in memory up to a byte budget
 * (`deltaBaseCacheBytes`); one dropped to stay inside it is rebuilt from the
 * nearest kept ancestor when needed again, as git's index-pack does.
 */

export interface ResolveContext {
  readonly state: PackIndexState;
  readonly zlib: Zlib;
  readonly memory: MemoryBudget;
  readonly limits: PackLimits;
  readonly readRange: PackRangeReader;
  readonly externalBase: ExternalBaseLookup | undefined;
  readonly onObject: ((object: PackObject) => void | Promise<void>) | undefined;
}

/** A base on the current chain: an entry of the pack, or an external object (entry -1). */
interface Frame {
  readonly entry: number;
  oid: Uint8Array;
  readonly type: ObjectType;
  data: Uint8Array | undefined;
  reservation: MemoryReservation | undefined;
}

/** Resolves every delta of a scanned pack; returns the external bases used, sorted. */
export async function resolveDeltas(ctx: ResolveContext): Promise<Oid[]> {
  const { state } = ctx;
  let deltas = 0;
  let totalSize = 0;
  for (let i = 0; i < state.count; i++) {
    if (!state.isResolved(i)) deltas++;
    totalSize += state.size(i);
  }
  if (deltas === 0) return [];
  // A small pack does not need the whole cache budget.
  const cacheBytes = Math.min(ctx.limits.deltaBaseCacheBytes, totalSize);
  const resolver = await Resolver.create(ctx, deltas, cacheBytes);
  try {
    for (let i = 0; i < state.count; i++) {
      const kind = state.kind(i);
      if (kind === "ofs-delta" || kind === "ref-delta") continue;
      if (!resolver.hasChildren(i, state.oids, i * OID_BYTES)) continue;
      // The data is referenced only by the frame, so the cache can drop it.
      await resolver.walk({
        entry: i,
        oid: state.oids.subarray(i * OID_BYTES, (i + 1) * OID_BYTES),
        type: kind,
        data: await resolver.readEntry(i),
        reservation: undefined,
      });
    }
    const thinBases = await resolveThinBases(state, resolver, ctx.externalBase, ctx.limits);
    return thinBases.sort(compareOids);
  } finally {
    resolver.release();
  }
}

export class Resolver {
  readonly #ctx: ResolveContext;
  readonly #reservation: MemoryReservation;
  readonly #cacheBytes: number;
  /** OFS children of entry i: ofsChildren[ofsStart[i] .. ofsStart[i + 1]). */
  readonly #ofsStart: Uint32Array;
  readonly #ofsChildren: Uint32Array;
  /** REF_DELTA entries sorted by base oid. */
  readonly #refOrder: Uint32Array;
  /**
   * For the group of `refOrder` sharing one base oid and starting at `lo`,
   * `refNext[lo]` is the first position not yet taken. A group is walked once
   * however many copies of its base the pack holds, so duplicate bases cannot
   * rescan it.
   */
  readonly #refNext: Uint32Array;
  readonly #stack: Frame[] = [];

  private constructor(
    ctx: ResolveContext,
    reservation: MemoryReservation,
    cacheBytes: number,
    ofsStart: Uint32Array,
    ofsChildren: Uint32Array,
    refOrder: Uint32Array,
    refNext: Uint32Array,
  ) {
    this.#ctx = ctx;
    this.#reservation = reservation;
    this.#cacheBytes = cacheBytes;
    this.#ofsStart = ofsStart;
    this.#ofsChildren = ofsChildren;
    this.#refOrder = refOrder;
    this.#refNext = refNext;
  }

  static async create(ctx: ResolveContext, deltas: number, cacheBytes: number): Promise<Resolver> {
    const { state } = ctx;
    const n = state.count;
    // Child lists: two arrays of 4 bytes per entry, two of 4 bytes per delta
    // (child order, and the REF_DELTA group cursors); then the base cache.
    const reservation = await reservePackMemory(
      ctx.memory,
      8 * (n + 1) + 8 * deltas + cacheBytes,
      "delta resolution",
    );
    // Counting sort of OFS_DELTAs by base entry: ofsStart[b + 1] counts b's children first.
    const ofsStart = new Uint32Array(n + 1);
    let refs = 0;
    for (let i = 0; i < n; i++) {
      const kind = state.kind(i);
      if (kind === "ofs-delta") {
        const slot = state.ofsBase(i) + 1;
        ofsStart[slot] = (ofsStart[slot] as number) + 1;
      } else if (kind === "ref-delta") {
        refs++;
      }
    }
    for (let i = 0; i < n; i++)
      ofsStart[i + 1] = (ofsStart[i + 1] as number) + (ofsStart[i] as number);
    const next = ofsStart.slice(0, n);
    const ofsChildren = new Uint32Array(ofsStart[n] as number);
    const refOrder = new Uint32Array(refs);
    refs = 0;
    for (let i = 0; i < n; i++) {
      const kind = state.kind(i);
      if (kind === "ofs-delta") {
        const base = state.ofsBase(i);
        ofsChildren[next[base] as number] = i;
        next[base] = (next[base] as number) + 1;
      } else if (kind === "ref-delta") {
        refOrder[refs++] = i;
      }
    }
    const bases = state.refBaseOids;
    refOrder.sort(
      (a, b) => compareAt(bases, state.refBaseAt(a), bases, state.refBaseAt(b)) || a - b,
    );
    const refNext = new Uint32Array(refs);
    for (let k = 0; k < refs; k++) refNext[k] = k;
    return new Resolver(ctx, reservation, cacheBytes, ofsStart, ofsChildren, refOrder, refNext);
  }

  release(): void {
    for (const frame of this.#stack) frame.reservation?.release();
    this.#reservation.release();
  }

  /**
   * True when entry `entry` (or, for -1, the object `oid`) is the base of some
   * delta not yet taken: its own OFS_DELTAs, or REF_DELTAs naming `oid` that
   * no earlier copy of the base has walked.
   */
  hasChildren(entry: number, oid: Uint8Array, oidAt: number): boolean {
    if (entry >= 0 && (this.#ofsStart[entry + 1] as number) > (this.#ofsStart[entry] as number)) {
      return true;
    }
    const [lo, hi] = this.#refRange(oid, oidAt);
    return hi > lo && hi > (this.#refNext[lo] as number);
  }

  /** Resolves every delta below `root`, depth first. */
  async walk(root: Frame): Promise<void> {
    this.#push(root);
    try {
      await this.#resolveChildren();
    } finally {
      this.#pop();
    }
  }

  /** Reads and inflates entry `index` again, checking it is the bytes pass 1 saw. */
  async readEntry(index: number): Promise<Uint8Array> {
    const { state, zlib } = this.#ctx;
    const offset = state.offset(index);
    const length = state.entryLength(index);
    const raw = await this.#ctx.readRange(offset, length);
    if (raw.length !== length || crc32(raw) !== state.crc32(index)) {
      throw new PackError("bad-checksum", "entry bytes differ from the first read", offset);
    }
    const body = raw.subarray(state.headerLength(index));
    try {
      const { data, consumed } = inflateEntry(zlib, body, state.entrySize(index), offset);
      if (consumed !== body.length) {
        throw new PackError("bad-checksum", "entry bytes differ from the first read", offset);
      }
      return data;
    } catch (error) {
      if (error instanceof NeedMoreInput) {
        throw new PackError("bad-checksum", "entry bytes differ from the first read", offset);
      }
      throw error;
    }
  }

  async #resolveChildren(): Promise<void> {
    const frame = this.#stack[this.#stack.length - 1] as Frame;
    if (frame.entry >= 0) {
      const end = this.#ofsStart[frame.entry + 1] as number;
      for (let k = this.#ofsStart[frame.entry] as number; k < end; k++) {
        await this.#resolveChild(this.#ofsChildren[k] as number);
      }
    }
    const [lo, hi] = this.#refRange(frame.oid, 0);
    if (hi === lo) return;
    // A REF_DELTA's base oid can appear twice in a pack (or be produced again
    // below this frame): the group cursor moves before each child resolves, so
    // every copy and every nested frame continues where the last one stopped.
    for (let k = this.#refNext[lo] as number; k < hi; k = this.#refNext[lo] as number) {
      this.#refNext[lo] = k + 1;
      const child = this.#refOrder[k] as number;
      if (!this.#ctx.state.isResolved(child)) await this.#resolveChild(child);
    }
  }

  async #resolveChild(child: number): Promise<void> {
    const { state, limits } = this.#ctx;
    const depth = this.#stack.length;
    if (depth > limits.maxDeltaDepth) {
      throw new PackError(
        "delta-too-deep",
        `delta chain longer than ${limits.maxDeltaDepth}`,
        state.offset(child),
      );
    }
    const { type } = this.#stack[depth - 1] as Frame;
    const reservation = await this.reserve(state.entrySize(child) + state.size(child));
    let kept = false;
    try {
      const frame: Frame = {
        entry: child,
        oid: new Uint8Array(0),
        type,
        data: undefined,
        reservation,
      };
      // Locals do not hold the base or the result past this block, so once
      // the frame is on the stack the cache alone decides what stays in memory.
      {
        const result = await this.#apply(await this.#dataAt(depth - 1), child);
        const oid = receivedObjectId(type, result);
        state.resolve(child, oid, type, depth);
        await this.#ctx.onObject?.({ index: child, oid: oidFromBytes(oid), type, data: result });
        if (!this.hasChildren(child, oid, 0)) return;
        frame.oid = oid;
        frame.data = result;
      }
      kept = true;
      await this.walk(frame);
    } finally {
      if (!kept) reservation?.release();
    }
  }

  async #apply(base: Uint8Array, child: number): Promise<Uint8Array> {
    const { state, limits } = this.#ctx;
    const delta = await this.readEntry(child);
    try {
      return applyDelta(base, delta, limits.maxObjectBytes);
    } catch (error) {
      if (error instanceof PackError && error.offset === undefined) {
        throw new PackError(error.code, error.detail, state.offset(child));
      }
      throw error;
    }
  }

  /** The data of the frame at `index`, rebuilt from the nearest kept ancestor if it was dropped. */
  async #dataAt(index: number): Promise<Uint8Array> {
    const frame = this.#stack[index] as Frame;
    if (frame.data !== undefined) return frame.data;
    let from = index - 1;
    while (from >= 0 && (this.#stack[from] as Frame).data === undefined) from--;
    let data: Uint8Array;
    if (from < 0) {
      from = 0;
      data = await this.#loadRoot(this.#stack[0] as Frame);
    } else {
      data = (this.#stack[from] as Frame).data as Uint8Array;
    }
    for (let k = from + 1; k <= index; k++) {
      data = await this.#apply(data, (this.#stack[k] as Frame).entry);
    }
    frame.reservation = await this.reserve(data.length);
    frame.data = data;
    this.#evict(index);
    return data;
  }

  async #loadRoot(root: Frame): Promise<Uint8Array> {
    if (root.entry >= 0) return this.readEntry(root.entry);
    const found = await this.#ctx.externalBase?.(oidFromBytes(root.oid));
    if (found === undefined) {
      throw new PackError(
        "bad-external-base",
        `external base ${oidToHex(oidFromBytes(root.oid))} vanished`,
      );
    }
    return found.data;
  }

  #push(frame: Frame): void {
    this.#stack.push(frame);
    this.#evict(this.#stack.length - 1);
  }

  #pop(): void {
    const frame = this.#stack.pop();
    frame?.reservation?.release();
  }

  /**
   * Keeps the bases on the stack inside the cache budget: the frame at `keep`
   * stays; large bases (with their own reservations) and then the shallowest
   * small ones are dropped first.
   */
  #evict(keep: number): void {
    const { largeObjectBytes } = this.#ctx.limits;
    let held = 0;
    for (let k = 0; k < this.#stack.length; k++) {
      const frame = this.#stack[k] as Frame;
      if (k === keep || frame.data === undefined) continue;
      if (frame.data.length > largeObjectBytes) {
        this.#drop(frame);
        continue;
      }
      held += frame.data.length;
    }
    for (let k = 0; k < this.#stack.length && held > this.#cacheBytes; k++) {
      const frame = this.#stack[k] as Frame;
      if (k === keep || frame.data === undefined) continue;
      held -= frame.data.length;
      this.#drop(frame);
    }
  }

  #drop(frame: Frame): void {
    frame.data = undefined;
    frame.reservation?.release();
    frame.reservation = undefined;
  }

  /** Reserves memory for a buffer above the large-object size; smaller ones use the cache reservation. */
  async reserve(bytes: number): Promise<MemoryReservation | undefined> {
    if (bytes <= this.#ctx.limits.largeObjectBytes) return undefined;
    return reservePackMemory(this.#ctx.memory, bytes, "an object");
  }

  /** The range of `refOrder` whose base oid is `oid[at .. at + 20)`, by two binary searches. */
  #refRange(oid: Uint8Array, at: number): [number, number] {
    const lo = this.#refBound(oid, at, false);
    return [lo, this.#refBound(oid, at, true, lo)];
  }

  /** First position whose base oid is not below (`after`: not at or below) `oid`. */
  #refBound(oid: Uint8Array, at: number, after: boolean, from = 0): number {
    const { state } = this.#ctx;
    const bases = state.refBaseOids;
    const order = this.#refOrder;
    let lo = from;
    let hi = order.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const d = compareAt(bases, state.refBaseAt(order[mid] as number), oid, at);
      if (d < 0 || (after && d === 0)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

function compareAt(a: Uint8Array, aAt: number, b: Uint8Array, bAt: number): number {
  for (let i = 0; i < OID_BYTES; i++) {
    const d = (a[aAt + i] as number) - (b[bAt + i] as number);
    if (d !== 0) return d;
  }
  return 0;
}
