import { PACK_HEADER_BYTES, PACK_TRAILER_BYTES } from "../pack/entry-header.js";
import type { PackExistenceSummary } from "../pack/existence-summary.js";
import type { IdxLookup, IdxReadBudget } from "../pack/idx-read.js";
import { isPackId, type PackId } from "../ports/pack-store.js";

/**
 * Finds an oid in one pack's `.idx`: `PackIdx` (held in memory) and
 * `RangedPackIdx` (read by ranges) both fit. A source that reads by ranges
 * adds its reads to `budget` when one is given (opening the index
 * included), so callers can count their store calls.
 */
export interface PackIdxSource {
  lookup(
    oid: Uint8Array,
    at?: number,
    budget?: IdxReadBudget,
  ): IdxLookup | undefined | Promise<IdxLookup | undefined>;
  /**
   * Optional: `lookup` for many oids with coalesced reads (both `.idx`
   * classes have it). Callers that check many objects at once use it when
   * present. With a budget, an oid left unanswered because the budget ran
   * out is `null`.
   */
  lookupMany?(
    oids: readonly Uint8Array[],
    budget?: IdxReadBudget,
  ): (IdxLookup | undefined | null)[] | Promise<(IdxLookup | undefined | null)[]>;
}

/** One live pack of a repository, as its registry row describes it. */
export interface ViewPack {
  readonly packId: PackId;
  /** The pack's length in bytes, trailer included. */
  readonly bytes: number;
  readonly idx: PackIdxSource;
  /** When given, a certain "no" from it skips the `.idx`. */
  readonly summary?: PackExistenceSummary | undefined;
  /**
   * The pack is shared in a fork network (borrowed from it): it may hold
   * another member's objects, outside this repository's closure. A push
   * uses an object found only in shared packs once it has proven the
   * object reachable from this repository's verified commits or refs.
   * Absent means a pack of the repository's own.
   */
  readonly shared?: boolean;
}

/**
 * The packs one repository may read, from its own pack registry: its own
 * packs first (newest first), then packs borrowed from its fork network.
 * Lookups follow this order. `scope` is the network id, which keys the
 * network-wide block cache tier.
 *
 * Build a view only from the repository's registry. A reader reads blocks
 * of these packs and no others; whether a given object may be shown to a
 * caller (the repository-level object check) is decided before the reader
 * is asked for it.
 */
export interface RepoView {
  readonly scope: string;
  readonly packs: readonly ViewPack[];
}

const MIN_PACK_BYTES = PACK_HEADER_BYTES + PACK_TRAILER_BYTES;

/** Throws RangeError for an empty scope, a bad or repeated pack id, or a bad pack length. */
export function checkView(view: RepoView): void {
  if (typeof view.scope !== "string" || view.scope.length === 0) {
    throw new RangeError("a view needs a scope");
  }
  const seen = new Set<string>();
  for (const pack of view.packs) {
    if (!isPackId(pack.packId)) throw new RangeError("not a pack id");
    if (seen.has(pack.packId)) throw new RangeError(`pack ${pack.packId} is in the view twice`);
    seen.add(pack.packId);
    if (!Number.isSafeInteger(pack.bytes) || pack.bytes < MIN_PACK_BYTES) {
      throw new RangeError(`pack ${pack.packId} has a bad length ${pack.bytes}`);
    }
  }
}
