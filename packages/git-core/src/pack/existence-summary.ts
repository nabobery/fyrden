import { DEFAULT_FALSE_POSITIVE_RATE, OidBloomFilter } from "./existence-filter.js";
import { checkOidAt, decodeFanout, fanoutBucket, IDX_FANOUT_ENTRIES } from "./idx-format.js";
import { type IdxRangeReader, RangedPackIdx } from "./idx-range-read.js";
import type { IdxLookup, PackIdx } from "./idx-read.js";

/**
 * What the registry keeps in memory per pack to answer "may this pack hold
 * X?" without touching R2: the `.idx` fanout (1 KB, the `packs.fanout`
 * column) and the bloom filter (the `pack_filters` rows). An empty fanout
 * bucket or a bloom miss is a certain "no"; only a "maybe" reads the `.idx`.
 */
export class PackExistenceSummary {
  readonly fanout: Uint32Array;
  readonly filter: OidBloomFilter;

  constructor(fanout: Uint32Array, filter: OidBloomFilter) {
    if (fanout.length !== IDX_FANOUT_ENTRIES) {
      throw new RangeError(`a fanout has ${IDX_FANOUT_ENTRIES} entries, not ${fanout.length}`);
    }
    this.fanout = fanout;
    this.filter = filter;
  }

  /** Builds the summary of a freshly written (or loaded) `.idx`. */
  static fromIdx(
    idx: PackIdx,
    falsePositiveRate = DEFAULT_FALSE_POSITIVE_RATE,
  ): PackExistenceSummary {
    const filter = OidBloomFilter.create(idx.count, falsePositiveRate);
    filter.addAll(idx.oidTable(), idx.count);
    return new PackExistenceSummary(idx.fanout, filter);
  }

  /**
   * Rebuilds a summary from its stored form: the 1 KB fanout blob and the
   * filter rows in chunk order. Throws `IdxError` or `ExistenceFilterError`.
   */
  static fromStored(fanout: Uint8Array, filterChunks: readonly Uint8Array[]): PackExistenceSummary {
    return new PackExistenceSummary(decodeFanout(fanout), OidBloomFilter.fromChunks(filterChunks));
  }

  /** False when the oid at `at` is certainly not in the pack. */
  mayContain(oid: Uint8Array, at = 0): boolean {
    checkOidAt(oid, at);
    const [lo, hi] = fanoutBucket(this.fanout, oid[at] as number);
    return lo < hi && this.filter.mayContain(oid, at);
  }

  /** Opens the pack's `.idx` for range reads using this fanout: no read happens here. */
  openIdx(readRange: IdxRangeReader, byteLength?: number): RangedPackIdx {
    return RangedPackIdx.withFanout(readRange, this.fanout, byteLength);
  }

  /** The oid's entry in the pack, reading the `.idx` only when the summary says "maybe". */
  async lookup(oid: Uint8Array, idx: RangedPackIdx, at = 0): Promise<IdxLookup | undefined> {
    if (!this.mayContain(oid, at)) return undefined;
    return idx.lookup(oid, at);
  }
}
