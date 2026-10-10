/**
 * In-isolate cache of verified token records for read paths.
 *
 * Entries live at most `ttlMs` (30 s by default), which bounds how long a
 * revoked token can still read through another isolate. Write paths never use
 * this cache. There is deliberately no shared tier: KV's minimum cacheTtl is
 * 60 s, longer than the 30 s bound, and a DO hop costs as much as the D1 read
 * it would replace.
 */
export class TokenCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly clock: () => number,
    private readonly ttlMs = 30_000,
    private readonly maxEntries = 10_000,
  ) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.clock()) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-insert to keep Map order as least-recently-used first.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /**
   * Caches a value checked at `checkedAt` (default: now). Freshness counts
   * from when the authoritative check started, not from when its answer
   * arrived, so a slow lookup cannot stretch the bound; an answer that is
   * already stale is not cached at all.
   */
  set(key: string, value: V, checkedAt = this.clock()): void {
    const expiresAt = checkedAt + this.ttlMs;
    this.entries.delete(key);
    if (expiresAt <= this.clock()) return;
    this.entries.set(key, { value, expiresAt });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /**
   * Replaces a cached value without extending its lifetime. Only an
   * authoritative check may renew freshness, so metadata updates (such as
   * last-used time) never stretch the revocation bound.
   */
  update(key: string, value: V): void {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > this.clock()) entry.value = value;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }
}
