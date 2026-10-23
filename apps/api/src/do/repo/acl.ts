import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { atLeast, ownsUserAccount, type RepoRole } from "@fyrden/domain";
import type { AclSnapshot } from "../OrgDO.js";

/** Proposed values. */
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
  /** Bumped by every transfer: a pull started before one answers for another ownership. */
  readonly ownerGen: number;
}

export interface RepoAclDeps {
  readonly storage: Pick<DurableObjectStorage, "sql">;
  readonly now: () => number;
  readonly metrics: Metrics;
  /** Undefined for an object without an identity (created before identities existed). */
  readonly account: () => RepoAccount | undefined;
  /** The account object's snapshot for this repository. */
  readonly pull: (accountId: string) => Promise<AclSnapshot>;
  /** In the caller's transaction: account `accountId`'s restore generation `epochGen` was seen. */
  readonly observed?: (accountId: string, epochGen: number) => void;
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

const sameOwnership = (a: RepoAccount | undefined, b: RepoAccount | undefined) =>
  a !== undefined && b !== undefined && a.accountId === b.accountId && a.ownerGen === b.ownerGen;

/** `(epoch, version)` pairs compare as a restore generation, then a version within it. */
const below = (e1: number, v1: number, e2: number, v2: number) => e1 < e2 || (e1 === e2 && v1 < v2);

/**
 * A repository's access decisions, from a stored snapshot of its account's
 * ACL. A write needs a snapshot pulled within the write
 * window, a read one within the read TTL; past that it is pulled again, and
 * when the pull fails the decision is a denial (fail closed). The stored
 * floor is the newest `(epoch, version)` seen from a pull or an
 * invalidation: a snapshot below it is never used, and a pull below it (one
 * that started before an invalidation, or from an older restore
 * generation) is refused. The owner of a user account administers its
 * repositories without one.
 */
export class RepoAcl {
  /** The pull in flight, and the ownership (account, owner generation) it pulls for. */
  #pulling: { account: RepoAccount; row: Promise<Row> } | undefined;
  /** The parsed roles of the stored snapshot, reused while it is the same one. */
  #parsed: { key: string; roles: Map<string, RepoRole> } | undefined;

  constructor(private readonly deps: RepoAclDeps) {}

  /**
   * `principalId`'s role on the repository, or null (also when no usable
   * snapshot exists). An object without an identity has no account to ask:
   * only the owner `directoryOwner` names administers it.
   */
  async roleOf(
    principalId: string,
    purpose: AclPurpose,
    directoryOwner?: string,
  ): Promise<RepoRole | null> {
    const account = this.deps.account();
    // An object without an identity: only the owner the directory named administers it.
    if (!account)
      return directoryOwner !== undefined && principalId === directoryOwner ? "admin" : null;
    // The account itself (an agent's owner, capping it) administers its repositories.
    if (principalId === account.accountId) return "admin";
    if (ownsUserAccount(principalId, account.ownerId)) return "admin";
    const row = await this.#snapshot(account, purpose);
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
    if (ownsUserAccount(principalId, account.ownerId) || principalId === account.accountId)
      return true;
    const row = this.#usable(account.accountId, ACL_POLICY.writeWindowMs);
    return row !== undefined && atLeast(this.#roles(row).get(principalId) ?? null, min);
  }

  /**
   * Pulls a snapshot unless one within the read TTL is stored, so that
   * `lastRoleOf` answers from it (a failed pull leaves the stored one).
   */
  async refresh(): Promise<void> {
    const account = this.deps.account();
    if (account) await this.#snapshot(account, "read");
  }

  /**
   * `principalId`'s role from the snapshot as last pulled, however long
   * ago (never one below the floor), or null: for what may be a little
   * stale without harm (who a feed tells, which feeds check again when
   * read). Pulls nothing.
   */
  lastRoleOf(principalId: string): RepoRole | null {
    const account = this.deps.account();
    if (!account) return null;
    if (principalId === account.accountId || ownsUserAccount(principalId, account.ownerId))
      return "admin";
    const row = this.#usable(account.accountId, Number.POSITIVE_INFINITY);
    return row ? (this.#roles(row).get(principalId) ?? null) : null;
  }

  /**
   * `lastRoleOf` for many principals from one read of the snapshot (a
   * feed's audience), and what that snapshot is (`key`, changing whenever
   * its account, restore generation or version does; null for none).
   */
  lastRoles(): {
    readonly roleOf: (principalId: string) => RepoRole | null;
    readonly key: string | null;
  } {
    const account = this.deps.account();
    if (!account) return { roleOf: () => null, key: null };
    const row = this.#usable(account.accountId, Number.POSITIVE_INFINITY);
    const roles = row ? this.#roles(row) : new Map<string, RepoRole>();
    return {
      roleOf: (principalId) =>
        principalId === account.accountId || ownsUserAccount(principalId, account.ownerId)
          ? "admin"
          : (roles.get(principalId) ?? null),
      key: row ? `${row.account_id}:${row.epoch_gen}:${row.version}` : null,
    };
  }

  /**
   * What decisions made now (as `allows` makes them) rest on: the snapshot
   * within the write window, its account, `(epochGen, version)` and when it
   * was pulled; `unknown` when there is none to use (a pull failed: a
   * denial then is no answer); `none` for an object without an account,
   * whose decisions rest on no snapshot.
   */
  basis():
    | {
        readonly accountId: string;
        readonly epochGen: number;
        readonly version: number;
        readonly pulledAt: number;
      }
    | "unknown"
    | "none" {
    const account = this.deps.account();
    if (!account) return "none";
    const row = this.#usable(account.accountId, ACL_POLICY.writeWindowMs);
    if (!row) return "unknown";
    return {
      accountId: row.account_id,
      epochGen: row.epoch_gen,
      version: row.version,
      pulledAt: row.pulled_at,
    };
  }

  /**
   * The repository moved to another account: the old account's snapshot
   * and version floor mean nothing there; the next decision pulls afresh.
   */
  reset(): void {
    this.deps.storage.sql.exec("DELETE FROM acl_snapshot");
  }

  /**
   * Account `accountId` committed ACL `(epochGen, version)`: no snapshot
   * below it is used, or accepted from a pull, again. A notice from an
   * account the repository no longer belongs to changes nothing.
   */
  invalidate(accountId: string, epochGen: number, version: number): void {
    if (this.deps.account()?.accountId !== accountId) return;
    this.deps.observed?.(accountId, epochGen);
    const row = this.#row(accountId);
    if (row && !below(row.floor_epoch, row.floor_version, epochGen, version)) return;
    // Another account's snapshot and floor go with it.
    this.deps.storage.sql.exec(
      `INSERT INTO acl_snapshot (id, account_id, floor_epoch, floor_version) VALUES (1, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET floor_epoch = excluded.floor_epoch,
         floor_version = excluded.floor_version,
         pulled_at = CASE WHEN account_id = excluded.account_id THEN pulled_at ELSE 0 END,
         account_id = excluded.account_id`,
      accountId,
      epochGen,
      version,
    );
  }

  async #snapshot(account: RepoAccount, purpose: AclPurpose): Promise<Row | undefined> {
    const { accountId } = account;
    const limit = purpose === "write" ? ACL_POLICY.writeWindowMs : ACL_POLICY.readTtlMs;
    const usable = this.#usable(accountId, limit);
    if (usable) {
      this.#record(purpose, "cached", this.deps.now() - usable.pulled_at);
      return usable;
    }
    try {
      // Concurrent decisions share one pull (for the same ownership).
      let pulling = this.#pulling;
      if (!pulling || !sameOwnership(pulling.account, account)) {
        const started: NonNullable<typeof pulling> = {
          account,
          row: this.#pull(account).finally(() => {
            if (this.#pulling === started) this.#pulling = undefined;
          }),
        };
        this.#pulling = pulling = started;
      }
      await pulling.row;
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

  async #pull(account: RepoAccount): Promise<Row> {
    const { accountId } = account;
    // Its age counts from before the call: a slow answer is no fresher.
    const startedAt = this.deps.now();
    const snapshot = await this.deps.pull(accountId);
    // An account not recorded yet answers an empty snapshot (version 0).
    if (snapshot.version > 0 && snapshot.accountId !== accountId)
      throw new Error("the snapshot is another account's");
    // The repository was transferred meanwhile (even back): this answer is for another ownership.
    if (!sameOwnership(this.deps.account(), account))
      throw new Error("the repository's ownership changed during the pull");
    // Read after the await: an invalidation or another pull may have raised the floor.
    const row = this.#row(accountId);
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
    this.deps.observed?.(accountId, snapshot.epochGen);
    return stored;
  }

  /** The stored snapshot, if it is the account's, not below the floor, and younger than `limitMs`. */
  #usable(accountId: string, limitMs: number): Row | undefined {
    const row = this.#row(accountId);
    if (!row || row.pulled_at === 0) return undefined;
    if (below(row.epoch_gen, row.version, row.floor_epoch, row.floor_version)) return undefined;
    if (this.deps.now() - row.pulled_at >= limitMs) return undefined;
    return row;
  }

  /** The stored snapshot and floor, if they are `accountId`'s (another account's mean nothing). */
  #row(accountId: string): Row | undefined {
    return this.deps.storage.sql
      .exec<Row>(
        `SELECT account_id, epoch_gen, version, pulled_at, roles, floor_epoch, floor_version
         FROM acl_snapshot WHERE id = 1 AND account_id = ?`,
        accountId,
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
