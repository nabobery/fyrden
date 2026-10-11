import type { PackId } from "@fyrden/git-core";
import { newUlid } from "./keys.js";
import { READABLE_STATES } from "./pack-registry.js";
import {
  chunks,
  countRowsWritten,
  first,
  type GitStorageContext,
  placeholders,
  rows,
  run,
} from "./sql.js";

export const LEASE_KINDS = ["read", "index", "maintenance", "saga"] as const;
export type LeaseKind = (typeof LEASE_KINDS)[number];

export type LeaseGrant =
  | { readonly ok: true; readonly leaseId: string; readonly expiresAt: number }
  | { readonly ok: false; readonly packId: PackId; readonly reason: "condemned" | "unreadable" };

/**
 * Leases on packs. A pack with an unexpired lease is never superseded or
 * deleted by maintenance, and a condemned pack gets no new leases, which is
 * what lets its lifetime authority delete it safely. A lease that is not
 * renewed expires, so a holder that dies cannot pin a pack forever.
 */
export class PackLeases {
  constructor(private readonly context: GitStorageContext) {}

  /**
   * Leases every pack in `packIds` under one lease id, or none of them.
   * Synchronous, so it can run inside a larger transaction.
   */
  grant(kind: LeaseKind, packIds: readonly PackId[], holder: string, ttlMs: number): LeaseGrant {
    if (!LEASE_KINDS.includes(kind)) throw new RangeError(`unknown lease kind ${kind}`);
    checkTtl(ttlMs);
    const { storage } = this.context;
    const now = this.context.now();
    const leaseId = newUlid(now);
    const expiresAt = now + ttlMs;
    const result = storage.transactionSync((): LeaseGrant & { written?: number } => {
      for (const packId of packIds) {
        const row = first<{ state: string }>(
          storage,
          "SELECT state FROM packs WHERE pack_id = ?",
          packId,
        );
        if (row?.state === "condemned") return { ok: false, packId, reason: "condemned" };
        // An upload's index lease, and maintenance's lease on the pack it
        // is writing, are taken while the row is still pending.
        const allowed =
          kind === "index" || kind === "maintenance"
            ? [...READABLE_STATES, "pending"]
            : READABLE_STATES;
        if (!row || !allowed.includes(row.state as (typeof READABLE_STATES)[number]))
          return { ok: false, packId, reason: "unreadable" };
      }
      let written = 0;
      for (const packId of new Set(packIds)) {
        written += run(
          storage,
          `INSERT INTO leases (lease_id, pack_id, kind, holder, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          leaseId,
          packId,
          kind,
          holder,
          now,
          expiresAt,
        );
      }
      written += touchLeased(storage, leaseId, now);
      return { ok: true, leaseId, expiresAt, written };
    });
    if (result.ok) countRowsWritten(this.context, "leases.grant", result.written ?? 0);
    return result.ok ? { ok: true, leaseId, expiresAt } : result;
  }

  /** Extends an unexpired lease. Returns the new expiry, or undefined if it has expired or gone. */
  renew(leaseId: string, ttlMs: number): number | undefined {
    checkTtl(ttlMs);
    const now = this.context.now();
    const expiresAt = now + ttlMs;
    const written = run(
      this.context.storage,
      "UPDATE leases SET expires_at = ? WHERE lease_id = ? AND expires_at > ?",
      expiresAt,
      leaseId,
      now,
    );
    countRowsWritten(
      this.context,
      "leases.renew",
      written + (written > 0 ? touchLeased(this.context.storage, leaseId, now) : 0),
    );
    return written > 0 ? expiresAt : undefined;
  }

  release(leaseId: string): void {
    const { storage } = this.context;
    const written = storage.transactionSync(
      () =>
        touchLeased(storage, leaseId, this.context.now()) +
        run(storage, "DELETE FROM leases WHERE lease_id = ?", leaseId),
    );
    countRowsWritten(this.context, "leases.release", written);
  }

  /** Releases every lease `holder` has (an upload's index lease, for example). Returns rows written. */
  releaseHolder(holder: string): number {
    return run(this.context.storage, "DELETE FROM leases WHERE holder = ?", holder);
  }

  /** The packs among `packIds` that have an unexpired lease. */
  leased(packIds: readonly PackId[]): Set<PackId> {
    const now = this.context.now();
    const out = new Set<PackId>();
    for (const batch of chunks(packIds)) {
      for (const row of rows<{ pack_id: string }>(
        this.context.storage,
        `SELECT DISTINCT pack_id FROM leases
         WHERE expires_at > ? AND pack_id IN (${placeholders(batch.length)})`,
        now,
        ...batch,
      )) {
        out.add(row.pack_id as PackId);
      }
    }
    return out;
  }

  /** Deletes expired leases. Returns rows written. */
  pruneExpired(): number {
    const written = run(
      this.context.storage,
      "DELETE FROM leases WHERE expires_at <= ?",
      this.context.now(),
    );
    countRowsWritten(this.context, "leases.prune", written);
    return written;
  }
}

/**
 * Records a lease's use as the last touch of the packs whose lifetime is
 * measured from it: materialised fetch objects (expired some time after
 * their last lease) and garbage packs (condemned some time after their last
 * touch). Other packs are not written. Returns rows written.
 */
function touchLeased(storage: GitStorageContext["storage"], leaseId: string, now: number): number {
  return run(
    storage,
    `UPDATE packs SET last_touched_at = max(last_touched_at, ?)
     WHERE pack_id IN (SELECT pack_id FROM leases WHERE lease_id = ?)
       AND (kind = 'fetch' OR state = 'garbage')`,
    now,
    leaseId,
  );
}

function checkTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new RangeError(`bad lease ttl ${ttlMs}`);
}
