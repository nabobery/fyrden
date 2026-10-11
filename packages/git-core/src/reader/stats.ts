/**
 * What one request's reads cost, for metrics. A reader adds to the object
 * it was given, so several readers in one request can share one.
 */
export interface ReadStats {
  /** 64 KiB blocks found in the block cache. */
  blockHits: number;
  /** Blocks not in the block cache (or no cache), read from the pack store. */
  blockMisses: number;
  /** `PackStore.openRange` calls (block misses are coalesced; walks read large ranges). */
  storeReads: number;
  /** Bytes those calls returned. */
  storeBytes: number;
  /** Block cache puts that failed; the read itself went on. */
  cachePutErrors: number;
  /** Objects found in the delta-base cache. */
  deltaBaseHits: number;
  /** Objects built from pack entries because the delta-base cache did not hold them. */
  deltaBaseMisses: number;
  /** Objects returned by `readObject` and `walk`. */
  objectsRead: number;
}

export function createReadStats(): ReadStats {
  return {
    blockHits: 0,
    blockMisses: 0,
    storeReads: 0,
    storeBytes: 0,
    cachePutErrors: 0,
    deltaBaseHits: 0,
    deltaBaseMisses: 0,
    objectsRead: 0,
  };
}
