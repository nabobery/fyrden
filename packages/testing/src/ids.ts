/**
 * Unique ids for tests. Storage isolation in workerd tests is per file, not
 * per test, so every test that touches a Durable Object, R2 key or D1 row
 * uses its own id instead of relying on a clean slate.
 */
export function uniqueId(prefix = "t"): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
