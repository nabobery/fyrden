import type { PackId } from "@fyrden/git-core";

/*
 * The pack-count cap: every push adds a pack unit and every
 * fetch consults every live pack, so a push may not leave more than `cap`
 * own live packs. When it would, its commit first merges the smallest
 * packs (the "tail") into one compacted pack, usually together with the
 * push's own unit. This module only chooses; tail-merge.ts does the work.
 *
 * Choosing: take the smallest unleased units until enough packs go away,
 * then keep taking while the next unit is no larger than everything taken
 * so far. That second rule groups equal small packs into one merge and
 * leaves a pack bigger than the merge alone, so a long run of small pushes
 * merges small packs with small packs instead of rewriting the largest
 * pack every few pushes. Every merge stays within a byte and object budget
 * that fits one Durable Object request; when no merge within budget makes
 * room, the push is refused with a retryable error.
 */

export interface PackCapPolicy {
  /**
   * Most own live packs a repository may have after a commit. Proposed 16
   * (design; tuned under load). git's own `gc.autoPackLimit` default is 50
   * (unverified).
   */
  readonly cap: number;
  /**
   * Most pack bytes one synchronous merge may read and copy, the push's
   * own unit included. Proposed 64 MiB (design): copying entries and
   * hashing the output costs a few milliseconds of CPU per MiB (stitching
   * with the TypeScript SHA-1 measured 3.3 to 3.4 ms per MiB on an Apple M4
   * under Node), far inside a request's 30 s of CPU (measured for Durable
   * Object requests on Workers Free, 2026-10-10).
   */
  readonly maxMergeBytes: number;
  /**
   * Most objects one synchronous merge may hold. Proposed 500,000:
   * compaction keeps about 49 bytes per object (plan and entry table), so
   * about 24 MiB of the 72 MiB operation pool.
   */
  readonly maxMergeObjects: number;
}

export const PACK_CAP_DEFAULTS: PackCapPolicy = Object.freeze({
  cap: 16,
  maxMergeBytes: 64 * 1024 * 1024,
  maxMergeObjects: 500_000,
});

const VARIABLES: Record<keyof PackCapPolicy, string> = {
  cap: "GIT_PACK_CAP",
  maxMergeBytes: "GIT_TAIL_MERGE_MAX_BYTES",
  maxMergeObjects: "GIT_TAIL_MERGE_MAX_OBJECTS",
};

/** Smallest cap that can work: one merged pack plus the push that did not fit in it. */
const MIN_CAP = 2;

/** The policy for this Worker: the defaults, overridden by any variables set to a usable value. */
export function packCapPolicy(env: object): PackCapPolicy {
  const vars = env as Partial<Record<string, unknown>>;
  const out: Record<string, number> = { ...PACK_CAP_DEFAULTS };
  for (const [key, name] of Object.entries(VARIABLES)) {
    const raw = vars[name];
    const value = typeof raw === "string" || typeof raw === "number" ? Number(raw) : Number.NaN;
    const min = key === "cap" ? MIN_CAP : 1;
    if (Number.isSafeInteger(value) && value >= min) out[key] = value;
  }
  return out as unknown as PackCapPolicy;
}

/** Live packs that live and die together (a thin pack and its completion pack), or one pack. */
export interface CapUnit {
  readonly id: string;
  readonly packIds: readonly PackId[];
  readonly bytes: number;
  /** Objects recorded at indexing; 0 when unknown. */
  readonly objects: number;
  readonly createdAt: number;
  /** Some pack of the unit has an unexpired lease: it must not be superseded. */
  readonly leased: boolean;
}

export type TailSelection =
  /** The commit stays under the cap as it is. */
  | { readonly kind: "within-cap" }
  /**
   * Merge `units` (and the push's unit when `withIncoming`) into one pack;
   * the repository then has `livePacksAfter` live packs.
   */
  | {
      readonly kind: "merge";
      readonly units: readonly CapUnit[];
      readonly withIncoming: boolean;
      readonly bytes: number;
      readonly livePacksAfter: number;
    }
  /** No merge within budget makes room: refuse the push (retryable). */
  | { readonly kind: "over-budget"; readonly reason: "budget" | "leased" };

const packsOf = (units: readonly CapUnit[]) => units.reduce((n, u) => n + u.packIds.length, 0);

/**
 * Chooses what a commit merges so that at most `target` (default the cap)
 * own live packs remain. `incoming` is the push's pack unit, which is not
 * live yet; without one (a background run), at least two units merge.
 */
export function selectTailMerge(
  live: readonly CapUnit[],
  incoming: CapUnit | undefined,
  policy: PackCapPolicy,
  options: { readonly target?: number } = {},
): TailSelection {
  const target = options.target ?? policy.cap;
  if (!Number.isSafeInteger(target) || target < 1) throw new RangeError(`bad target ${target}`);
  const livePacks = packsOf(live);
  const incomingPacks = incoming?.packIds.length ?? 0;
  if (livePacks + incomingPacks <= target) return { kind: "within-cap" };

  const eligible = live
    .filter((u) => !u.leased)
    .sort((a, b) => a.bytes - b.bytes || b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1));
  const anyLeased = eligible.length < live.length;

  // With the push's unit: the merged pack replaces the push and the units taken.
  if (incoming && fits(incoming.bytes, incoming.objects, policy)) {
    const taken = take(eligible, livePacks + 1 - target, 0, incoming, policy);
    if (taken) return merge(taken, true, livePacks - packsOf(taken.units) + 1);
  }
  // Without it (too large to copy again, or no push): the push stays a unit of its own.
  const taken = take(eligible, livePacks + incomingPacks + 1 - target, 2, undefined, policy);
  if (taken) return merge(taken, false, livePacks - packsOf(taken.units) + 1 + incomingPacks);
  // Leases are the reason only when the same choice without them would succeed.
  const leasedOnly =
    anyLeased &&
    selectTailMerge(
      live.map((u) => ({ ...u, leased: false })),
      incoming,
      policy,
      options,
    ).kind === "merge";
  return { kind: "over-budget", reason: leasedOnly ? "leased" : "budget" };
}

function merge(
  taken: { units: CapUnit[]; bytes: number },
  withIncoming: boolean,
  livePacksAfter: number,
): TailSelection {
  return { kind: "merge", units: taken.units, withIncoming, bytes: taken.bytes, livePacksAfter };
}

function fits(bytes: number, objects: number, policy: PackCapPolicy): boolean {
  return bytes <= policy.maxMergeBytes && objects <= policy.maxMergeObjects;
}

/**
 * The smallest units, in order, until `needPacks` packs and `minUnits`
 * units are taken; then more while the next is no larger than all taken so
 * far. Undefined when the budget runs out first.
 */
function take(
  eligible: readonly CapUnit[],
  needPacks: number,
  minUnits: number,
  start: CapUnit | undefined,
  policy: PackCapPolicy,
): { units: CapUnit[]; bytes: number } | undefined {
  const units: CapUnit[] = [];
  let bytes = start?.bytes ?? 0;
  let objects = start?.objects ?? 0;
  let packs = 0;
  let at = 0;
  for (; at < eligible.length && (packs < needPacks || units.length < minUnits); at++) {
    const unit = eligible[at] as CapUnit;
    if (!fits(bytes + unit.bytes, objects + unit.objects, policy)) return undefined;
    units.push(unit);
    bytes += unit.bytes;
    objects += unit.objects;
    packs += unit.packIds.length;
  }
  if (packs < needPacks || units.length < minUnits) return undefined;
  for (; at < eligible.length; at++) {
    const unit = eligible[at] as CapUnit;
    if (unit.bytes > bytes || !fits(bytes + unit.bytes, objects + unit.objects, policy)) break;
    units.push(unit);
    bytes += unit.bytes;
    objects += unit.objects;
  }
  return { units, bytes };
}
