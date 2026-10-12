import { newUlid } from "./keys.js";
import { countRowsWritten, first, type GitStorageContext, run } from "./sql.js";

/**
 * Lock names. A Durable Object's input gate does not hold back other
 * requests while it awaits R2 or another service (measured on a deployed
 * object, 2026-10-11; the local test runtime differs and does hold them), so
 * a multi-step operation that awaits between its reads and its final
 * transaction holds an explicit lock instead.
 *
 * - `ref-commit`: held from the awaited re-authorization through the commit
 *   transaction of a push, a server-side ref update, or a maintenance swap.
 * - `maintenance`: one compaction, GC or detach at a time.
 *
 * Correctness never rests on a lock alone: the commit transaction still
 * compares `ref_state.version` and every ref's old value. Locks keep
 * concurrent work from wasting effort and let a holder fence its own
 * transaction with `isHeld`.
 */
export const LOCK_REF_COMMIT = "ref-commit";
export const LOCK_MAINTENANCE = "maintenance";

export interface LockHandle {
  readonly name: string;
  readonly holder: string;
  readonly token: string;
  readonly expiresAt: number;
}

export interface AcquireOptions {
  /** How long the lock stays held without renewal. */
  readonly ttlMs: number;
  /** How long to wait for a held lock; 0 fails at once. */
  readonly waitMs: number;
}

type LockRow = { holder: string; token: string; expires_at: number };

/**
 * Named per-repository locks stored in SQLite, so they survive eviction: a
 * lock whose holder died stays held until it expires, and nothing a holder
 * did is half-applied, because its writes commit in one transaction.
 * Waiters queue in arrival order within the object.
 */
export class RepoLocks {
  readonly #waiters = new Map<string, (() => void)[]>();

  constructor(private readonly context: GitStorageContext) {}

  /** Takes the lock if it is free or expired; never waits. */
  tryAcquire(name: string, holder: string, ttlMs: number): LockHandle | undefined {
    checkTtl(ttlMs);
    const { storage } = this.context;
    const now = this.context.now();
    const token = newUlid(now);
    const expiresAt = now + ttlMs;
    const written = storage.transactionSync(() => {
      const current = first<LockRow>(
        storage,
        "SELECT holder, token, expires_at FROM locks WHERE name = ?",
        name,
      );
      if (current && current.expires_at > now) return 0;
      return run(
        storage,
        `INSERT INTO locks (name, holder, token, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, token = excluded.token,
           acquired_at = excluded.acquired_at, expires_at = excluded.expires_at`,
        name,
        holder,
        token,
        now,
        expiresAt,
      );
    });
    if (written === 0) return undefined;
    countRowsWritten(this.context, "locks.acquire", written);
    return { name, holder, token, expiresAt };
  }

  /**
   * Takes the lock, waiting up to `waitMs` for the holder to release it or
   * for it to expire. Returns undefined when the wait ends without the lock
   * (the caller reports "busy, retry").
   */
  async acquire(
    name: string,
    holder: string,
    options: AcquireOptions,
  ): Promise<LockHandle | undefined> {
    const deadline = this.context.now() + options.waitMs;
    const queue = this.#queue(name);
    // Wait behind earlier waiters, so a stream of newcomers cannot starve them.
    if (queue.length === 0) {
      const handle = this.tryAcquire(name, holder, options.ttlMs);
      if (handle || options.waitMs <= 0) return handle;
    } else if (options.waitMs <= 0) {
      return undefined;
    }
    for (;;) {
      const now = this.context.now();
      const remaining = deadline - now;
      if (remaining <= 0) return undefined;
      const holderExpiry = this.#expiresAt(name);
      if (holderExpiry === undefined || holderExpiry <= now) {
        // Free (released or expired): take it now rather than sleep.
        const handle = this.tryAcquire(name, holder, options.ttlMs);
        if (handle) return handle;
        continue;
      }
      await this.#wait(name, Math.max(1, Math.min(remaining, holderExpiry - now)));
      const handle = this.tryAcquire(name, holder, options.ttlMs);
      if (handle) return handle;
    }
  }

  /** Extends a held lock. Returns false when the lock is no longer this handle's. */
  renew(handle: LockHandle, ttlMs: number): LockHandle | undefined {
    checkTtl(ttlMs);
    const now = this.context.now();
    const expiresAt = now + ttlMs;
    const written = run(
      this.context.storage,
      "UPDATE locks SET expires_at = ? WHERE name = ? AND token = ? AND expires_at > ?",
      expiresAt,
      handle.name,
      handle.token,
      now,
    );
    if (written === 0) return undefined;
    countRowsWritten(this.context, "locks.renew", written);
    return { ...handle, expiresAt };
  }

  /**
   * Whether `handle` still holds its lock (not released, not expired, not
   * taken over). Synchronous, so a holder can check it inside its commit
   * transaction.
   */
  isHeld(handle: LockHandle): boolean {
    const row = first<LockRow>(
      this.context.storage,
      "SELECT holder, token, expires_at FROM locks WHERE name = ?",
      handle.name,
    );
    return row !== undefined && row.token === handle.token && row.expires_at > this.context.now();
  }

  /** Releases a lock held by `handle` and wakes the next waiter. Releasing twice has no effect. */
  release(handle: LockHandle): void {
    const written = run(
      this.context.storage,
      "DELETE FROM locks WHERE name = ? AND token = ?",
      handle.name,
      handle.token,
    );
    countRowsWritten(this.context, "locks.release", written);
    this.#wake(handle.name);
  }

  /** Runs `fn` holding the lock, releasing it however `fn` ends. */
  async withLock<T>(
    name: string,
    holder: string,
    options: AcquireOptions,
    fn: (handle: LockHandle) => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; reason: "busy" }> {
    const handle = await this.acquire(name, holder, options);
    if (!handle) return { ok: false, reason: "busy" };
    try {
      return { ok: true, value: await fn(handle) };
    } finally {
      this.release(handle);
    }
  }

  #expiresAt(name: string): number | undefined {
    return first<{ expires_at: number }>(
      this.context.storage,
      "SELECT expires_at FROM locks WHERE name = ?",
      name,
    )?.expires_at;
  }

  #queue(name: string): (() => void)[] {
    let queue = this.#waiters.get(name);
    if (!queue) {
      queue = [];
      this.#waiters.set(name, queue);
    }
    return queue;
  }

  #wait(name: string, ms: number): Promise<void> {
    const queue = this.#queue(name);
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        const at = queue.indexOf(wake);
        if (at >= 0) queue.splice(at, 1);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      queue.push(wake);
    });
  }

  #wake(name: string): void {
    this.#waiters.get(name)?.[0]?.();
  }
}

function checkTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new RangeError(`bad lock ttl ${ttlMs}`);
}
