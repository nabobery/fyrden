/**
 * Typed product and cost counters written to Analytics Engine. Every feature
 * counts the billable operations it makes (D1, R2, Durable Object, queue), so
 * per-deployment cost can be reported. A counter is added with the first
 * feature that emits it.
 *
 * Data point layout: index = metric name; blobs = dimensions in a fixed order;
 * doubles[0] = value.
 */
export const METRICS = {
  "http.request": ["route", "method", "status"],
  "r2.class_a": ["bucket", "op"],
  "r2.class_b": ["bucket", "op"],
  "do.rows_written": ["class", "op"],
  "do.request": ["class", "method"],
  "d1.query": ["db", "op"],
  "auth.token": ["type", "outcome"],
} as const satisfies Record<string, readonly string[]>;

export type MetricName = keyof typeof METRICS;
export type MetricDimensions<N extends MetricName> = Record<(typeof METRICS)[N][number], string>;

export interface Metrics {
  count<N extends MetricName>(name: N, dimensions: MetricDimensions<N>, value?: number): void;
}

export function createMetrics(dataset: AnalyticsEngineDataset): Metrics {
  return {
    count(name, dimensions, value = 1) {
      const blobs = METRICS[name].map((key) => (dimensions as Record<string, string>)[key] ?? "");
      dataset.writeDataPoint({ indexes: [name], blobs, doubles: [value] });
    },
  };
}
