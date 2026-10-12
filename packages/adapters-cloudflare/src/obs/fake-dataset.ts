import { ANALYTICS_ENGINE_POINTS_PER_INVOCATION, currentInvocation } from "./invocation.js";

/** One data point as a test reads it back. */
export interface RecordedPoint {
  readonly name: string;
  readonly blobs: string[];
  readonly value: number;
}

/** The error the platform throws past its per-invocation limit (measured on a deployment, 2026-10-11). */
export const WRITE_LIMIT_MESSAGE = "Analytics Engine write limit exceeded.";

/**
 * A test stand-in for an Analytics Engine dataset that records every point
 * and, like the platform, throws once one invocation has written 250
 * points. The local runtime's binding enforces no limit, so tests that use
 * this fake are the ones that catch code writing too many points.
 *
 * An invocation is the measured invocation the write happens in (the point
 * budget it shares with any nested one). Writes outside one are grouped by
 * task: the count restarts after the current macrotask, which is how a
 * synchronous Durable Object method or a plain test call behaves.
 */
export function createFakeDataset(): {
  dataset: AnalyticsEngineDataset;
  points: RecordedPoint[];
} {
  const points: RecordedPoint[] = [];
  const perInvocation = new WeakMap<object, number>();
  let outside = 0;
  let resetScheduled = false;
  const dataset: AnalyticsEngineDataset = {
    writeDataPoint(point) {
      const key = currentInvocation()?.pointBudget;
      const used = key === undefined ? outside : (perInvocation.get(key) ?? 0);
      if (used >= ANALYTICS_ENGINE_POINTS_PER_INVOCATION) throw new Error(WRITE_LIMIT_MESSAGE);
      if (key === undefined) {
        outside = used + 1;
        if (!resetScheduled) {
          resetScheduled = true;
          setTimeout(() => {
            outside = 0;
            resetScheduled = false;
          }, 0);
        }
      } else {
        perInvocation.set(key, used + 1);
      }
      points.push({
        name: String(point?.indexes?.[0] ?? ""),
        blobs: (point?.blobs ?? []).map(String),
        value: Number(point?.doubles?.[0] ?? 0),
      });
    },
  };
  return { dataset, points };
}
