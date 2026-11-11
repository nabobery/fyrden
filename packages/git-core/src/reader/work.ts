import { ReaderWorkSpent } from "./errors.js";

/** What a decoding primitive is charged as. */
export type ReaderWorkKind =
  /** Each inflate attempt, including one that stops for more input: span given plus declared size. */
  | "inflate"
  /** A delta apply's program bytes, which bound its opcodes; apart from the result, for its weight. */
  | "delta-program"
  /** A delta apply's result size. */
  | "delta-result"
  /** Copying a whole object to a buffer of its own length. */
  | "exact-copy"
  /** Each copy handed to the caller, also on a cache hit. */
  | "returned-copy"
  /** Each run of blocks read, warm or cold: 64 KiB per block touched. */
  | "block-run"
  /** Each `readHeader` and `readObject`, also on a cache hit: the lookup and its maps. */
  | "lookup"
  /** Scanning a tree's bytes. The reader doesn't scan; its caller charges this. */
  | "tree-scan";

/**
 * Counts what a reader does, before it does it. `charge` throws to refuse, and
 * then the primitive doesn't run. The bytes a reader builds don't predict its
 * CPU: an inflate that fails and a warm read that copies blocks build none.
 */
export interface ReaderWork {
  charge(kind: ReaderWorkKind, units: number): void;
}

/** Units of a lookup, charged flat. */
export const READER_LOOKUP_WORK = 1024;

export interface ReaderWorkMeter extends ReaderWork {
  /** Weighted units charged so far. A refused charge isn't counted. */
  spent(): number;
}

/**
 * A work port that stops at `limit` weighted units, by throwing
 * `ReaderWorkSpent`. A kind's weight defaults to 1.
 */
export function createReaderWorkMeter(options: {
  readonly limit: number;
  readonly weights?: Partial<Record<ReaderWorkKind, number>>;
}): ReaderWorkMeter {
  const { limit } = options;
  if (!(limit >= 1)) throw new RangeError(`a work limit must be at least 1, not ${limit}`);
  // A copy: a weight changed after this check can't reach the count. Infinity times a
  // charge of 0 is NaN, which no later charge could pass the limit from.
  const weights = { ...options.weights };
  for (const [kind, weight] of Object.entries(weights)) {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new RangeError(`bad weight ${weight} for ${kind}`);
    }
  }
  let spent = 0;
  return {
    charge(kind, units) {
      if (!Number.isFinite(units) || units < 0) {
        throw new RangeError(`bad work charge ${units} for ${kind}`);
      }
      const next = spent + units * (weights[kind] ?? 1);
      if (next > limit) {
        throw new ReaderWorkSpent(limit, `decoding took more than ${limit} units of work`);
      }
      spent = next;
    },
    spent: () => spent,
  };
}
