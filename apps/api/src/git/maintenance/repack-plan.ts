import type { CapUnit } from "./tail-merge-plan.js";

/*
 * Which packs a geometric repack combines, the rule of
 * `git repack --geometric=<factor>` (builtin/repack.c, split_pack_geometry;
 * unverified against a pinned git version): sort the repository's own live
 * packs by object count; from the largest down, find where each pack stops
 * being at least `factor` times the next smaller one; everything below that
 * point is rolled into one new pack, and so is every larger pack that would
 * no longer be `factor` times the new pack's size. Repeated pushes then cost amortised logarithmic
 * rewriting, as with reftable's auto-compaction.
 *
 * A pack unit (a thin pack and its completion pack) moves as one. Leased
 * units are chosen like any other: the swap waits for their leases.
 */

/** Units to combine, smallest first; empty when the packs already form a progression. */
export function selectGeometricRepack(
  units: readonly CapUnit[],
  factor: number,
  maxObjects: number,
): CapUnit[] {
  if (!(factor > 1)) throw new RangeError(`geometric factor must be above 1, not ${factor}`);
  const weight = (u: CapUnit) => Math.max(1, u.objects);
  const sorted = [...units].sort(
    (a, b) => weight(a) - weight(b) || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1),
  );
  let i = sorted.length - 1;
  for (; i > 0; i--) {
    if (weight(sorted[i] as CapUnit) < factor * weight(sorted[i - 1] as CapUnit)) break;
  }
  let split = i > 0 ? i + 1 : 0;
  let total = sorted.slice(0, split).reduce((n, u) => n + weight(u), 0);
  for (; split < sorted.length; split++) {
    const unit = sorted[split] as CapUnit;
    if (weight(unit) >= factor * total) break;
    total += weight(unit);
  }
  // Within the budget, the smallest first: a partial roll-up still shortens the tail.
  const chosen: CapUnit[] = [];
  let objects = 0;
  for (const unit of sorted.slice(0, split)) {
    if (objects + weight(unit) > maxObjects) break;
    chosen.push(unit);
    objects += weight(unit);
  }
  return chosen.length >= 2 ? chosen : [];
}
