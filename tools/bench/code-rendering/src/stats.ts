/** Order statistics for the report: nearest-rank percentiles. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] as number;
}

export interface Summary {
  n: number;
  median: number;
  p95: number;
  min: number;
  max: number;
}

export function summarize(values: readonly number[]): Summary {
  return {
    n: values.length,
    median: percentile(values, 50),
    p95: percentile(values, 95),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

/**
 * The largest size (KiB) whose time stays within `budget`, interpolated
 * linearly between the two ladder steps around the crossing; null when even
 * the smallest step is over, and the largest step when none is.
 */
export function largestWithin(
  points: readonly { kib: number; ms: number }[],
  budget: number,
): { kib: number | null; beyondLadder: boolean } {
  const sorted = [...points].sort((a, b) => a.kib - b.kib);
  const first = sorted[0];
  if (!first || first.ms > budget) return { kib: null, beyondLadder: false };
  for (let i = 1; i < sorted.length; i++) {
    const below = sorted[i - 1] as { kib: number; ms: number };
    const above = sorted[i] as { kib: number; ms: number };
    if (above.ms > budget) {
      const share = above.ms === below.ms ? 0 : (budget - below.ms) / (above.ms - below.ms);
      return { kib: below.kib + share * (above.kib - below.kib), beyondLadder: false };
    }
  }
  return { kib: (sorted.at(-1) as { kib: number }).kib, beyondLadder: true };
}
