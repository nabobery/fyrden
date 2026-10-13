import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { atLeast, ownsUserAccount, type RepoRole } from "@fyrden/domain";
import type { AclSnapshot } from "../OrgDO.js";

/** Proposed values (design §4.4). */
export const ACL_POLICY = {
  /** A write is decided from a snapshot pulled at most this long ago. */
  writeWindowMs: 60_000,
  /** A read may use a snapshot this old. */
  readTtlMs: 5 * 60_000,
};

export type AclPurpose = "read" | "write";

/** The account a repository belongs to, from its identity. */
export interface RepoAccount {
  readonly accountId: string;
  readonly ownerId: string;
}

export interface RepoAclDeps {
  readonly storage: Pick<DurableObjectStorage, "sql">;
  readonly now: () => number;
  readonly metrics: Metrics;
  /** Undefined for an object without an identity (created before identities existed). */
  readonly account: () => RepoAccount | undefined;
  /** The account object's snapshot for this repository. */
  readonly pull: (accountId: string) => Promise<AclSnapshot>;
}

type Row = {
  account_id: string;
  epoch_gen: number;
  version: number;
  pulled_at: number;
  roles: string;
  floor_epoch: number;
  floor_version: number;
};

/** `(epoch, version)` pairs compare as a restore generation, then a version within it. */
const below = (e1: number, v1: number, e2: number, v2: number) => e1 < e2 || (e1 === e2 && v1 < v2);

/**
 * A repository's access decisions, from a stored snapshot of its account's
 * ACL (design §4.4). A write needs a snapshot pulled within the write
 * window, a read one within the read TTL; past that it is pulled again, and
 * when the pull fails the decision is a denial (fail closed). The stored
 * floor is the newest `(epoch, version)` seen from a pull or an
 * invalidation: a snapshot below it is never used, and a pull below it (one
 * that started before an invalidation, or from an older restore
 * generation) is refused. The owner of a user account administers its
 * repositories without one.
 */
export class RepoAcl {
  #pulling: Promise<Row> | undefined;
  /** The parsed roles of the stored snapshot, reused while it is the same one. */
  #parsed: { key: string; roles: Map<string, RepoRole> } | undefined;

  constructor(private readonly deps: RepoAclDeps) {}

  /** `principalId`'s role on the repository, or null (also when no usable snapshot exists). */
  async roleOf(principalId: string, purpose: AclPurpose): Promise<RepoRole | null> {
    const account = this.deps.account();
    if (!account) return null;
    if (ownsUserAccount(principalId, account.ownerId)) return "admin";
    const row = await this.#snapshot(account.accountId, purpose);
    return row ? (this.#roles(row).get(principalId) ?? null) : null;
  }

  /**
   * Synchronously, for a check that must not await (a commit's transaction,
   * or right before a change): whether `principalId` has `min` now, from a
   * snapshot still within the write window. Call `roleOf(principalId,
   * "write")` first to pull one. An object without an identity has no
   * account to check against: allowed (its callers checked the owner).
   */
  allows(principalId: string, min: RepoRole): boolean {
    const account = this.deps.account();
    if (!account) return true;
    if (ownsUserAccount(principalId, account.ownerId)) return true;
    const row = this.#usable(account.accountId, ACL_POLICY.writeWindowMs);
    return row !== undefined && atLeast(this.#roles(row).get(principalId) ?? null, min);
  }

  /**
   * The account committed ACL `(epochGen, version)`: no snapshot below it is
   * used, or accepted from a pull, again.
   */
  invalidate(epochGen: number, version: number): void {
    const row = this.#row();
    if (row && !below(row.floor_epoch, row.floor_version, epochGen, version)) return;
    this.deps.storage.sql.exec(
      `INSERT INTO acl_snapshot (id, floor_epoch, floor_version) VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET floor_epoch = excluded.floor_epoch,
         floor_version = excluded.floor_version`,
      epochGen,
      version,
    );
  }

  async #snapshot(accountId: string, purpose: AclPurpose): Promise<Row | undefined> {
    const limit = purpose === "write" ? ACL_POLICY.writeWindowMs : ACL_POLICY.readTtlMs;
    const usable = this.#usable(accountId, limit);
    if (usable) {
      this.#record(purpose, "cached", this.deps.now() - usable.pulled_at);
      return usable;
    }
    try {
      // Concurrent decisions share one pull.
      this.#pulling ??= this.#pull(accountId).finally(() => {
        this.#pulling = undefined;
      });
      await this.#pulling;
      // Read again: an invalidation may have raised the floor meanwhile.
      const fresh = this.#usable(accountId, limit);
      if (!fresh) throw new Error("the pulled snapshot is no longer usable");
      this.#record(purpose, "pulled", this.deps.now() - fresh.pulled_at);
      return fresh;
    } catch {
      this.deps.metrics.count("acl.snapshot", { purpose, outcome: "denied" });
      return undefined;
    }
  }

  async #pull(accountId: string): Promise<Row> {
    // Its age counts from before the call: a slow answer is no fresher.
    const startedAt = this.deps.now();
    const snapshot = await this.deps.pull(accountId);
    // An account not recorded yet answers an empty snapshot (version 0).
    if (snapshot.version > 0 && snapshot.accountId !== accountId)
      throw new Error("the snapshot is another account's");
    // Read after the await: an invalidation or another pull may have raised the floor.
    const row = this.#row();
    if (row && below(snapshot.epochGen, snapshot.version, row.floor_epoch, row.floor_version))
      throw new Error("the snapshot is older than one already seen");
    const stored: Row = {
      account_id: accountId,
      epoch_gen: snapshot.epochGen,
      version: snapshot.version,
      pulled_at: startedAt,
      roles: JSON.stringify(snapshot.roles),
      // Now the newest seen.
      floor_epoch: snapshot.epochGen,
      floor_version: snapshot.version,
    };
    this.deps.storage.sql.exec(
      `INSERT INTO acl_snapshot (id, account_id, epoch_gen, version, pulled_at, roles,
         floor_epoch, floor_version)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET account_id = excluded.account_id,
         epoch_gen = excluded.epoch_gen, version = excluded.version,
         pulled_at = excluded.pulled_at, roles = excluded.roles,
         floor_epoch = excluded.floor_epoch, floor_version = excluded.floor_version`,
      stored.account_id,
      stored.epoch_gen,
      stored.version,
      stored.pulled_at,
      stored.roles,
      stored.floor_epoch,
      stored.floor_version,
    );
    return stored;
  }

  /** The stored snapshot, if it is the account's, not below the floor, and younger than `limitMs`. */
  #usable(accountId: string, limitMs: number): Row | undefined {
    const row = this.#row();
    if (!row || row.pulled_at === 0 || row.account_id !== accountId) return undefined;
    if (below(row.epoch_gen, row.version, row.floor_epoch, row.floor_version)) return undefined;
    if (this.deps.now() - row.pulled_at >= limitMs) return undefined;
    return row;
  }

  #row(): Row | undefined {
    return this.deps.storage.sql
      .exec<Row>(
        `SELECT account_id, epoch_gen, version, pulled_at, roles, floor_epoch, floor_version
         FROM acl_snapshot WHERE id = 1`,
      )
      .toArray()[0];
  }

  #roles(row: Row): Map<string, RepoRole> {
    const key = `${row.account_id}:${row.epoch_gen}:${row.version}:${row.pulled_at}`;
    if (this.#parsed?.key !== key) {
      const roles = JSON.parse(row.roles) as Record<string, RepoRole>;
      this.#parsed = { key, roles: new Map(Object.entries(roles)) };
    }
    return this.#parsed.roles;
  }

  #record(purpose: AclPurpose, outcome: "cached" | "pulled", ageMs: number): void {
    this.deps.metrics.count("acl.snapshot", { purpose, outcome });
    this.deps.metrics.count("acl.snapshot_age_ms", { purpose }, ageMs);
  }
}
