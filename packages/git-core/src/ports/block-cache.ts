import type { PackId } from "./pack-store.js";

/** Packs are read and cached in fixed 64 KiB blocks; a pack's last block may be shorter. */
export const BLOCK_SIZE = 64 * 1024;

/**
 * A cache of immutable pack blocks. `scope` is the fork network id for the
 * internal block tier: a block is read from it only after the repository
 * check has allowed the object. Packs never change, so a block put
 * twice is the same block.
 */
export interface BlockCache {
  get(scope: string, packId: PackId, blockIndex: number): Promise<Uint8Array | undefined>;
  /** Throws RangeError for a block larger than BLOCK_SIZE or a bad index. */
  put(scope: string, packId: PackId, blockIndex: number, block: Uint8Array): Promise<void>;
}
