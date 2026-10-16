import { createLogger, createMetrics } from "@fyrden/adapters-cloudflare/obs";
import {
  atLeast,
  type OrgRole,
  orgRepoRole,
  REPO_ROLES,
  type RepoRole,
  strongestRole,
} from "@fyrden/domain";
import { MigratingDO } from "./base/MigratingDO.js";
import { Outbox } from "./base/outbox.js";
import {
  AccountQuotas,
  CONFIRMED_KEEP_MS,
  defaultLimits,
  type QuotaLimits,
  type StorageStatus,
} from "./org/quotas.js";
import { orgSchema } from "./schema/org.js";

/** An account as its object records it. */
export interface AccountInit {
  readonly accountId: string;
  readonly kind: "org" | "user";
  /** An organization's first owner; a user owns its own account. */
  readonly owner: { readonly id: string; readonly handle: string };
  /** Allocated from the directory before the object is created. */
  readonly epochGen: number;
}

/** Who asks for a change, for its authorization and its audit row. */
export interface ChangeActor {
  readonly principalId: string;
  readonly requestId?: string;
}

/** The outcome of an access change. */
export type AclChange =
  | {
      readonly ok: true;
      readonly epochGen: number;
      readonly version: number;
      readonly changed: boolean;
      /** The repositories whose access changed; absent: possibly all of the account's. */
      readonly repos?: readonly string[];
    }
  | {
      readonly ok: false;
      readonly code:
        | "not_an_org"
        | "not_recorded"
        | "forbidden"
        | "last_owner"
        | "not_a_member"
        | "team_not_found"
        | "team_taken"
        | "too_many"
        | "repo_gone";
      readonly error: string;
    };

/** A principal with a role on one repository, as listed. */
export interface CollaboratorRow {
  readonly id: string;
  readonly handle: string;
  readonly role: RepoRole;
}

export interface TeamRow {
  readonly slug: string;
  readonly name: string;
}

export interface MemberRow {
  readonly id: string;
  readonly handle: string;
  readonly role: OrgRole;
}

/**
 * Who may do what on one repository of the account, at one ACL version: each
 * principal's strongest role there. A repository object caches it.
 */
export interface AclSnapshot {
  readonly accountId: string;
  readonly epochGen: number;
  readonly version: number;
  /** Principal id → role. */
  readonly roles: Readonly<Record<string, RepoRole>>;
}

/** The role members of an organization get on its repositories (GitHub's default; not configurable yet). */
export const BASE_ROLE: RepoRole = "read";

/** Most entries one snapshot carries (an organization's members, for now). Proposed. */
export const MAX_SNAPSHOT_ENTRIES = 10_000;

/**
 * A transfer's room in its new account never lapses: it is held until the
 * transfer ends (adopted, or called off), which every transfer does, its
 * steps tried again until one or the other.
 */
const HELD_UNTIL_ENDED = Number.MAX_SAFE_INTEGER;

/** How long an ended arrival is remembered, so a late runner makes no room for it. Proposed. */
const ENDED_ARRIVAL_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

type Meta = {
  account_id: string;
  kind: "org" | "user";
  acl_version: number;
  epoch_gen: number;
};

/** Repositories one `access.revoked` event names at most (a removal can name thousands). */
const REVOKED_REPOS = 100;

/** Audit rows one delivery sends at most. */
const AUDIT_BATCH = 50;
/** Wait before the alarm retries a delivery that failed. Proposed. */
const AUDIT_RETRY_MS = 60_000;

/**
 * One account (an organization, or a user's own namespace): the source of
 * truth for access to its repositories. Every change of access is checked
 * against the actor's role, bumps the ACL version and records its audit row
 * in one transaction, and returns only after it; the caller then tells the
 * repositories, whose cached snapshots expire anyway (writes within 60
 * seconds). Audit rows are then delivered to the directory.
 */
export class OrgDO extends MigratingDO {
  static readonly schema = orgSchema;

  #now(): number {
    return Date.now();
  }

  #outboxOf: Outbox | undefined;
  get #outbox(): Outbox {
    this.#outboxOf ??= new Outbox(this.ctx.storage, {
      now: () => this.#now(),
      send: async (envelope) => {
        await this.env.EVENTS.send(envelope, { contentType: "json" });
      },
      metrics: createMetrics(this.env.METRICS),
      doClass: "OrgDO",
    });
    return this.#outboxOf;
  }

  /**
   * In a change's transaction: `principals` no longer read `repos` of the
   * account, as of ACL `version`. Events say so, for their activity feeds,
   * each naming at most `REVOKED_REPOS` repositories.
   */
  #revoked(
    actor: ChangeActor | null,
    principals: readonly string[],
    repos: readonly string[],
    version: number,
  ): void {
    if (principals.length === 0) return;
    for (let at = 0; at < repos.length; at += REVOKED_REPOS) {
      const meta = this.ctx.storage.sql
        .exec<{ account_id: string; epoch_gen: number; source_seq: number }>(
          `UPDATE org_meta SET source_seq = source_seq + 1 WHERE id = 1
           RETURNING account_id, epoch_gen, source_seq`,
        )
        .one();
      this.#outbox.append(
        { sourceId: meta.account_id, epochGen: meta.epoch_gen, sourceSeq: meta.source_seq },
        {
          type: "access.revoked",
          at: this.#now(),
          actor: actor?.principalId ?? null,
          actChain: [],
          ownerGen: 1,
          entity: null,
          data: {
            principals: [...principals],
            repos: repos.slice(at, at + REVOKED_REPOS),
            acl_version: version,
          },
        },
      );
    }
  }

  /**
   * The data of an event too large for its queue message, as the JSON
   * `{ row, data }`, by event key; null once its retention has passed.
   */
  eventPayload(key: string): string | null {
    const stored = this.ctx.storage.sql
      .exec<{ payload: string }>("SELECT payload FROM event_payloads WHERE event_key = ?", key)
      .toArray()[0];
    return stored?.payload ?? null;
  }

  /** Arms the alarm for the outbox's next drain or prune, unless it is due sooner. */
  async #armOutbox(): Promise<void> {
    const due = this.#outbox.dueAt();
    if (due !== null) await this.#armBy(due);
  }

  /** The alarm goes off by `at` at the latest (an earlier one stands). */
  async #armBy(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  #meta(): Meta | undefined {
    return this.ctx.storage.sql
      .exec<Meta>("SELECT account_id, kind, acl_version, epoch_gen FROM org_meta WHERE id = 1")
      .toArray()[0];
  }

  /** Records the account and, for an organization, its first owner. Idempotent for the same account. */
  init(input: AccountInit): { ok: true } | { ok: false; error: string } {
    return this.ctx.storage.transactionSync(() => {
      const meta = this.#meta();
      if (meta) {
        return meta.account_id === input.accountId && meta.kind === input.kind
          ? { ok: true as const }
          : { ok: false as const, error: "the object records another account" };
      }
      const now = this.#now();
      this.ctx.storage.sql.exec(
        `INSERT INTO org_meta (id, account_id, kind, epoch_gen, epoch_uuid, created_at)
         VALUES (1, ?, ?, ?, ?, ?)`,
        input.accountId,
        input.kind,
        input.epochGen,
        crypto.randomUUID(),
        now,
      );
      if (input.kind === "org")
        this.ctx.storage.sql.exec(
          "INSERT INTO members (principal_id, handle, role, added_at) VALUES (?, ?, 'owner', ?)",
          input.owner.id,
          input.owner.handle,
          now,
        );
      // The generation was just allocated from the directory.
      this.#epochChecked = true;
      return { ok: true as const };
    });
  }

  /** `principalId`'s role in the account: a user owns its own account; null for none. */
  accountRole(principalId: string): OrgRole | null {
    const meta = this.#meta();
    if (!meta) return null;
    if (meta.kind === "user") return principalId === meta.account_id ? "owner" : null;
    return (
      this.ctx.storage.sql
        .exec<{ role: OrgRole }>("SELECT role FROM members WHERE principal_id = ?", principalId)
        .toArray()[0]?.role ?? null
    );
  }

  /** The current ACL version (0 before the account is recorded). */
  aclVersion(): number {
    return this.#meta()?.acl_version ?? 0;
  }

  /**
   * The snapshot of who may do what on repository `repoId` of the account.
   * An account not recorded yet (a user's, before anything needed its
   * object) has version 0 and no entries: its owner's access needs none.
   * Throws when the account has more entries than a snapshot may carry.
   */
  async snapshotFor(repoId: string): Promise<AclSnapshot> {
    await this.#checkEpoch();
    const meta = this.#meta();
    if (!meta) return { accountId: "", epochGen: 0, version: 0, roles: {} };
    return {
      accountId: meta.account_id,
      epochGen: meta.epoch_gen,
      version: meta.acl_version,
      roles: Object.fromEntries(this.#rolesFor(repoId, meta)),
    };
  }

  /** Whether the account is recorded (a user's is created when something first needs it). */
  isRecorded(): boolean {
    return this.#meta() !== undefined;
  }

  /**
   * Each principal's strongest role on `repoId`: the account's owner (a
   * user's) or its organization roles, its teams' grants, its collaborators.
   * Throws past the snapshot's limit.
   */
  #rolesFor(repoId: string, meta: Meta): Map<string, RepoRole> {
    const roles = new Map<string, RepoRole>();
    const grant = (principal: string, role: RepoRole | null) => {
      const strongest = strongestRole([roles.get(principal) ?? null, role]);
      if (strongest) roles.set(principal, strongest);
    };
    const sql = this.ctx.storage.sql;
    const cap = MAX_SNAPSHOT_ENTRIES + 1;
    if (meta.kind === "user") grant(meta.account_id, "admin");
    else
      for (const m of sql
        .exec<{ principal_id: string; role: OrgRole }>(
          "SELECT principal_id, role FROM members LIMIT ?",
          cap,
        )
        .toArray())
        grant(m.principal_id, orgRepoRole(m.role, BASE_ROLE));
    // Each principal's strongest team grant, so the limit counts principals, not grants.
    for (const g of sql
      .exec<{ principal_id: string; rank: number }>(
        `SELECT tm.principal_id, MAX(${RANK}) AS rank FROM team_repos tr
         JOIN team_members tm ON tm.team_id = tr.team_id WHERE tr.repo_id = ?
         GROUP BY tm.principal_id LIMIT ?`,
        repoId,
        cap,
      )
      .toArray())
      grant(g.principal_id, REPO_ROLES[g.rank] as RepoRole);
    for (const c of sql
      .exec<{ principal_id: string; role: RepoRole }>(
        "SELECT principal_id, role FROM collaborators WHERE repo_id = ? LIMIT ?",
        repoId,
        cap,
      )
      .toArray())
      grant(c.principal_id, c.role);
    if (roles.size > MAX_SNAPSHOT_ENTRIES)
      throw new Error(`more than ${MAX_SNAPSHOT_ENTRIES} principals have access to ${repoId}`);
    return roles;
  }

  /** `principalId`'s strongest role on `repoId`, as `#rolesFor` gives it, without listing the others. */
  #roleOn(repoId: string, principalId: string, meta: Meta): RepoRole | null {
    const team = this.ctx.storage.sql
      .exec<{ rank: number | null }>(
        `SELECT MAX(${RANK}) AS rank FROM team_repos tr
         JOIN team_members tm ON tm.team_id = tr.team_id
         WHERE tr.repo_id = ? AND tm.principal_id = ?`,
        repoId,
        principalId,
      )
      .one().rank;
    return strongestRole([
      meta.kind === "user"
        ? principalId === meta.account_id
          ? "admin"
          : null
        : orgRepoRole(this.accountRole(principalId), BASE_ROLE),
      team === null ? null : (REPO_ROLES[team] as RepoRole),
      this.#collaboratorRole(repoId, principalId),
    ]);
  }

  /**
   * The most principals with access to one repository of the account (to
   * `repoId` alone if given): its owner or members, and collaborators (team
   * members are members).
   */
  #widestAccess(meta: Meta, repoId?: string): number {
    const base =
      meta.kind === "user"
        ? 1
        : this.ctx.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM members").one().n;
    // Collaborators who are neither the owner nor members; one repository's by its index.
    const outside = `c.principal_id <> ?
      AND NOT EXISTS (SELECT 1 FROM members m WHERE m.principal_id = c.principal_id)`;
    const others = (
      repoId === undefined
        ? this.ctx.storage.sql.exec<{ n: number | null }>(
            `SELECT MAX(n) AS n FROM (
               SELECT count(*) AS n FROM collaborators c WHERE ${outside} GROUP BY c.repo_id)`,
            meta.account_id,
          )
        : this.ctx.storage.sql.exec<{ n: number | null }>(
            `SELECT count(*) AS n FROM collaborators c WHERE c.repo_id = ? AND ${outside}`,
            repoId,
            meta.account_id,
          )
    ).one().n;
    // A repository on its way in brings its collaborators who are not members (now).
    const arriving = this.ctx.storage.sql
      .exec<{ n: number | null }>(
        `SELECT MAX(n) AS n FROM (
           SELECT count(*) AS n FROM transfer_arrival_collaborators c
           JOIN transfer_arrivals a ON a.transfer_id = c.transfer_id
           WHERE a.state = 'held' AND ${outside}
           GROUP BY c.transfer_id)`,
        meta.account_id,
      )
      .one().n;
    return base + Math.max(others ?? 0, arriving ?? 0);
  }

  /** In a change's transaction: undoes it (by throwing) if a snapshot would grow past its limit. */
  #keepWithinLimit(meta: Meta, repoId?: string): void {
    if (this.#widestAccess(meta, repoId) > MAX_SNAPSHOT_ENTRIES) throw new TooMany();
  }

  /** An organization's members after handle `after` (ignoring case), at most `limit`. */
  members(after: string, limit: number): MemberRow[] {
    return this.ctx.storage.sql
      .exec<{ principal_id: string; handle: string; role: OrgRole }>(
        `SELECT principal_id, handle, role FROM members WHERE handle > ? COLLATE NOCASE
         ORDER BY handle COLLATE NOCASE LIMIT ?`,
        after,
        limit,
      )
      .toArray()
      .map((row) => ({ id: row.principal_id, handle: row.handle, role: row.role }));
  }

  /**
   * Adds a member or changes its role, if `actor` is an owner now. The last
   * owner cannot be demoted. Unchanged, it bumps nothing.
   */
  async setMember(
    actor: ChangeActor,
    member: { readonly id: string; readonly handle: string },
    role: OrgRole,
  ): Promise<AclChange> {
    return this.#change(actor, { owner: true }, (meta) => {
      const current = this.accountRole(member.id);
      if (current === role) return this.#unchanged(meta);
      if (current === "owner" && this.#owners() === 1) return LAST_OWNER;
      this.ctx.storage.sql.exec(
        `INSERT INTO members (principal_id, handle, role, added_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (principal_id) DO UPDATE SET role = excluded.role, handle = excluded.handle`,
        member.id,
        member.handle,
        role,
        this.#now(),
      );
      if (current === null) this.#keepWithinLimit(meta);
      return this.#changed(actor, "org.member.set", { user: member.id, role });
    });
  }

  /**
   * Removes a member, if `actor` is an owner now; the last owner cannot
   * leave. Gone already, it bumps nothing. `held`: the repositories the
   * account holds, as the caller read them from the directory just before
   * (see `heldRepos`); the member's feed forgets them all but those it is a
   * collaborator of. Read then, they are the ones that matter: one
   * transferred away since is named all the same (the member lost it
   * anyway); one transferred in since was never the member's through the
   * account; one created since is forgotten when the member's feed is next
   * read (it finds the member cannot read it); one whose transfer ended
   * before was forgotten with that transfer's own revocation.
   */
  async removeMember(
    actor: ChangeActor,
    memberId: string,
    held: readonly string[],
  ): Promise<AclChange> {
    return this.#change(actor, { owner: true }, (meta) => {
      const current = this.accountRole(memberId);
      if (current === null) return this.#unchanged(meta);
      if (current === "owner" && this.#owners() === 1) return LAST_OWNER;
      this.ctx.storage.sql.exec("DELETE FROM members WHERE principal_id = ?", memberId);
      // Teams are the organization's: leaving it leaves them.
      this.ctx.storage.sql.exec("DELETE FROM team_members WHERE principal_id = ?", memberId);
      const changed = this.#changed(actor, "org.member.remove", { user: memberId });
      const kept = new Set(this.collaboratorRepos(memberId, "read"));
      this.#revoked(
        actor,
        [memberId],
        held.filter((id) => !kept.has(id)),
        (changed as { version: number }).version,
      );
      return changed;
    });
  }

  /**
   * Gives `user` a role on repository `repoId` of the account, if `actor`
   * administers that repository now (the caller checked the repository is
   * the account's).
   */
  async setCollaborator(
    actor: ChangeActor,
    repoId: string,
    user: { readonly id: string; readonly handle: string },
    role: RepoRole,
  ): Promise<AclChange> {
    return this.#change(actor, { repoAdmin: repoId }, (meta) => {
      if (this.#notHere(repoId)) return REPO_GONE;
      const current = this.#collaboratorRole(repoId, user.id);
      if (current === role) return this.#unchanged(meta, [repoId]);
      this.ctx.storage.sql.exec(
        `INSERT INTO collaborators (repo_id, principal_id, handle, role, added_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (repo_id, principal_id) DO UPDATE SET role = excluded.role,
           handle = excluded.handle`,
        repoId,
        user.id,
        user.handle,
        role,
        this.#now(),
      );
      if (current === null) this.#keepWithinLimit(meta, repoId);
      return this.#changed(actor, "repo.collaborator.set", { repo: repoId, user: user.id, role }, [
        repoId,
      ]);
    });
  }

  /**
   * Takes `userId`'s collaborator role on `repoId` away, if `actor`
   * administers it now. Gone already, it bumps nothing.
   */
  async removeCollaborator(actor: ChangeActor, repoId: string, userId: string): Promise<AclChange> {
    return this.#change(actor, { repoAdmin: repoId }, (meta) => {
      const removed = this.ctx.storage.sql.exec(
        "DELETE FROM collaborators WHERE repo_id = ? AND principal_id = ?",
        repoId,
        userId,
      ).rowsWritten;
      if (removed === 0) return this.#unchanged(meta, [repoId]);
      const changed = this.#changed(
        actor,
        "repo.collaborator.remove",
        { repo: repoId, user: userId },
        [repoId],
      );
      if (this.#roleOn(repoId, userId, meta) === null)
        this.#revoked(actor, [userId], [repoId], (changed as { version: number }).version);
      return changed;
    });
  }

  /**
   * Repository `repoId` was deleted: its collaborators and team grants go
   * with it, and a grant that reaches this object later is refused.
   */
  forgetRepo(repoId: string): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO forgotten_repos (repo_id, forgotten_at) VALUES (?, ?) ON CONFLICT DO NOTHING",
        repoId,
        this.#now(),
      );
      this.ctx.storage.sql.exec("DELETE FROM collaborators WHERE repo_id = ?", repoId);
      this.ctx.storage.sql.exec("DELETE FROM team_repos WHERE repo_id = ?", repoId);
      this.#quotas().forgetRepo(repoId);
    });
  }

  #quotas(): AccountQuotas {
    return new AccountQuotas(this.ctx.storage, defaultLimits(this.env), () => this.#now());
  }

  /** The account's quota limits in force. */
  quotaLimits(): QuotaLimits {
    return this.#quotas().limits();
  }

  /** The account's limits and storage use. */
  quotaStatus(): StorageStatus {
    return this.#quotas().status();
  }

  /**
   * Sets the account's limits (an instance administrator; the Worker
   * checked it), with its audit row in the same transaction; the row is
   * delivered to the directory like any other.
   */
  setQuotaLimits(
    change: { readonly maxRepos?: number | null; readonly maxStorageBytes?: number | null },
    audit: { readonly accountId: string; readonly actor: ChangeActor },
  ): QuotaLimits {
    const limits = this.#quotas().setLimits(change, () =>
      this.ctx.storage.sql.exec(
        `INSERT INTO pending_audit (at, actor_id, action, target_id, details, request_id)
         VALUES (?, ?, 'quota.set', ?, ?, ?)`,
        this.#now(),
        audit.actor.principalId,
        audit.accountId,
        // Only what the change names: null is a return to the instance default.
        JSON.stringify({
          ...(change.maxRepos !== undefined && { max_repos: change.maxRepos }),
          ...(change.maxStorageBytes !== undefined && {
            max_storage_bytes: change.maxStorageBytes,
          }),
        }),
        audit.actor.requestId ?? null,
      ),
    );
    void this.ctx.storage.getAlarm().then((current) => {
      const at = this.#now() + AUDIT_RETRY_MS;
      if (current === null || current > at) return this.ctx.storage.setAlarm(at);
    });
    return limits;
  }

  /** Reserves storage for an upload being stored (see `AccountQuotas.reserve`). */
  reserveStorage(input: Parameters<AccountQuotas["reserve"]>[0]): {
    reserved: number;
    freeBytes: number;
  } {
    if (this.#notHere(input.repoId)) return { reserved: 0, freeBytes: 0 };
    return this.#quotas().reserve(input);
  }

  /** Holds a committing upload's bytes (see `AccountQuotas.charge`); false when they do not fit. */
  chargeStorage(input: Parameters<AccountQuotas["charge"]>[0]): boolean {
    // A deleted or moved repository's storage is not counted here again.
    if (this.#notHere(input.repoId)) return false;
    return this.#quotas().charge(input);
  }

  /**
   * An upload committed: its bytes become its repository's usage (see
   * `AccountQuotas.confirm`). False when the repository is not this
   * account's (moved, or deleted): nothing is counted here, so the caller
   * still owes it.
   */
  confirmStorage(input: Parameters<AccountQuotas["confirm"]>[0]): boolean {
    if (this.#notHere(input.repoId)) return false;
    this.#quotas().confirm(input);
    return true;
  }

  /** An upload ended without committing: what it holds is free again. */
  releaseStorage(uploadId: string): void {
    this.#quotas().release(uploadId);
  }

  /**
   * A repository leaving this account (a transfer): its collaborators and
   * the storage its uploads use. Team grants stay behind: they are this
   * account's.
   */
  repoForTransfer(repoId: string): {
    collaborators: { principalId: string; handle: string; role: RepoRole }[];
    usageBytes: number;
  } {
    const collaborators = this.ctx.storage.sql
      .exec<{ principal_id: string; handle: string; role: RepoRole }>(
        "SELECT principal_id, handle, role FROM collaborators WHERE repo_id = ? ORDER BY principal_id",
        repoId,
      )
      .toArray()
      .map((r) => ({ principalId: r.principal_id, handle: r.handle, role: r.role }));
    const usage = this.ctx.storage.sql
      .exec<{ bytes: number }>("SELECT bytes FROM quota_usage WHERE repo_id = ?", repoId)
      .toArray()[0];
    return { collaborators, usageBytes: usage?.bytes ?? 0 };
  }

  /**
   * A repository arriving from another account in transfer `transferId`:
   * the collaborators and storage usage the old account handed over
   * (`releaseRepo`), once for the transfer (again, nothing changes); a
   * grant made here since it arrived wins. Returns the ACL version to tell
   * the repository of.
   */
  adoptRepo(
    transferId: string,
    repoId: string,
    from: ReturnType<OrgDO["repoForTransfer"]>,
  ): { epochGen: number; version: number } {
    // Its admission made its room (`reserveArrival`); it is not refused here, where the
    // repository has moved already.
    return this.ctx.storage.transactionSync(() => {
      const meta = this.#meta();
      if (!meta) throw new Error("the account is not recorded");
      if (!this.#firstTime(transferId, "adopt"))
        return { epochGen: meta.epoch_gen, version: meta.acl_version };
      // The room its admission made is taken now.
      this.#endArrival(transferId, true);
      // A repository that left before may come back.
      this.ctx.storage.sql.exec("DELETE FROM forgotten_repos WHERE repo_id = ?", repoId);
      this.ctx.storage.sql.exec("DELETE FROM released_repos WHERE repo_id = ?", repoId);
      const now = this.#now();
      for (const c of from.collaborators)
        this.ctx.storage.sql.exec(
          `INSERT INTO collaborators (repo_id, principal_id, handle, role, added_at)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT (repo_id, principal_id) DO NOTHING`,
          repoId,
          c.principalId,
          c.handle,
          c.role,
          now,
        );
      if (from.usageBytes > 0)
        this.ctx.storage.sql.exec(
          `INSERT INTO quota_usage (repo_id, bytes) VALUES (?, ?)
           ON CONFLICT (repo_id) DO UPDATE SET bytes = excluded.bytes`,
          repoId,
          from.usageBytes,
        );
      return { epochGen: meta.epoch_gen, version: this.#bump() };
    });
  }

  /**
   * A repository leaving for another account in transfer `transferId`: in
   * one transaction, what it hands over (its collaborators and storage
   * usage) and its removal here (collaborators, team grants, storage), so
   * no grant changed meanwhile is lost; from then on no grant, storage
   * charge or confirmation of it is taken here. It is not forgotten (it
   * lives on). Done once per transfer: again, it answers the same.
   */
  async releaseRepo(
    transferId: string,
    repoId: string,
  ): Promise<
    ReturnType<OrgDO["repoForTransfer"]> & {
      acl: { epochGen: number; version: number } | undefined;
    }
  > {
    // The event it writes takes the directory's restore generation (also first after a restore).
    await this.#checkEpoch();
    const released = this.ctx.storage.transactionSync(() => {
      const meta = this.#meta();
      const acl = meta && { epochGen: meta.epoch_gen, version: meta.acl_version };
      const done = this.ctx.storage.sql
        .exec<{ handed_over: string | null }>(
          "SELECT handed_over FROM transfer_ops WHERE transfer_id = ? AND op = 'release'",
          transferId,
        )
        .toArray()[0];
      if (done?.handed_over)
        return { ...(JSON.parse(done.handed_over) as ReturnType<OrgDO["repoForTransfer"]>), acl };
      const handedOver = this.repoForTransfer(repoId);
      this.ctx.storage.sql.exec(
        "INSERT INTO transfer_ops (transfer_id, op, handed_over, done_at) VALUES (?, 'release', ?, ?)",
        transferId,
        JSON.stringify(handedOver),
        this.#now(),
      );
      // Who read it here and does not go with it (its collaborators do) no longer reads it:
      // their activity feeds forget it (one who reads it again where it lands hears anew).
      const moving = new Set(handedOver.collaborators.map((c) => c.principalId));
      let readers: string[] = [];
      try {
        if (meta) readers = [...this.#rolesFor(repoId, meta).keys()].filter((p) => !moving.has(p));
      } catch {
        // Past the snapshot's limit: feeds check access when read, so the release goes on.
      }
      this.ctx.storage.sql.exec("DELETE FROM collaborators WHERE repo_id = ?", repoId);
      this.ctx.storage.sql.exec("DELETE FROM team_repos WHERE repo_id = ?", repoId);
      this.#quotas().forgetRepo(repoId);
      this.ctx.storage.sql.exec(
        `INSERT INTO released_repos (repo_id, transfer_id, released_at) VALUES (?, ?, ?)
         ON CONFLICT (repo_id) DO UPDATE SET transfer_id = excluded.transfer_id,
           released_at = excluded.released_at`,
        repoId,
        transferId,
        this.#now(),
      );
      const bumped = meta && { epochGen: meta.epoch_gen, version: this.#bump() };
      if (bumped) this.#revoked(null, readers, [repoId], bumped.version);
      return { ...handedOver, acl: bumped };
    });
    // An access.revoked it wrote goes out with the alarm.
    void this.#armOutbox();
    return released;
  }

  /**
   * Whether a repository could arrive in account `accountId` (this one,
   * recorded or not yet) with `collaborators`: its snapshot (the owner or
   * members, and those collaborators) stays within its limit.
   */
  canAdopt(accountId: string, collaborators: readonly { readonly principalId: string }[]): boolean {
    const meta = this.#meta();
    const sql = this.ctx.storage.sql;
    const isMember = (id: string) =>
      sql.exec("SELECT 1 FROM members WHERE principal_id = ?", id).toArray().length > 0;
    const base =
      meta?.kind === "org"
        ? sql.exec<{ n: number }>("SELECT count(*) AS n FROM members").one().n
        : 1;
    const outside = collaborators.filter(
      (c) => c.principalId !== accountId && !isMember(c.principalId),
    );
    return base + outside.length <= MAX_SNAPSHOT_ENTRIES;
  }

  /**
   * Makes room for a repository on its way in (transfer `transferId`,
   * before the directory moves it here): its storage, held under the
   * transfer's id, and its outside collaborators, counted against members
   * added meanwhile; or why it does not fit. Once per transfer: asked
   * again, it answers "ok". `adoptRepo` takes the room; `releaseArrival`
   * gives it back.
   */
  reserveArrival(input: {
    readonly transferId: string;
    readonly accountId: string;
    readonly repoId: string;
    readonly usageBytes: number;
    /** Uploads it committed whose confirmations it still owes (told here once it lands). */
    readonly owed?: readonly { readonly uploadId: string; readonly bytes: number }[];
    readonly collaborators: readonly { readonly principalId: string }[];
  }): "ok" | "quota_exceeded" | "too_many_collaborators" {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const now = this.#now();
      sql.exec("DELETE FROM transfer_arrivals WHERE state = 'done' AND expires_at < ?", now);
      const arrival = sql
        .exec<{ state: string }>(
          "SELECT state FROM transfer_arrivals WHERE transfer_id = ?",
          input.transferId,
        )
        .toArray()[0];
      // Adopted or called off already (a late runner): no room is made again.
      const adopted =
        sql
          .exec(
            "SELECT 1 FROM transfer_ops WHERE transfer_id = ? AND op = 'adopt'",
            input.transferId,
          )
          .toArray().length > 0;
      // Held already (a step tried again), adopted or called off (a late runner): as it was.
      if (adopted || arrival) return "ok";
      if (!this.canAdopt(input.accountId, input.collaborators)) return "too_many_collaborators";
      const owed = input.owed ?? [];
      // Its usage until it lands; each owed upload charged until it is confirmed here (or for
      // as long as a confirmation is remembered, should it be told elsewhere).
      const held = this.#quotas().holdAll([
        {
          uploadId: input.transferId,
          repoId: input.repoId,
          kind: "reserved",
          bytes: input.usageBytes,
          expiresAt: HELD_UNTIL_ENDED,
        },
        ...owed.map((o) => ({
          uploadId: o.uploadId,
          repoId: input.repoId,
          kind: "charged" as const,
          bytes: o.bytes,
          expiresAt: now + CONFIRMED_KEEP_MS,
        })),
      ]);
      if (!held) return "quota_exceeded";
      sql.exec(
        `INSERT INTO transfer_arrivals (transfer_id, repo_id, state, owed, expires_at)
         VALUES (?, ?, 'held', ?, ?)`,
        input.transferId,
        input.repoId,
        JSON.stringify(owed.map((o) => o.uploadId)),
        HELD_UNTIL_ENDED,
      );
      for (const c of input.collaborators)
        sql.exec(
          `INSERT INTO transfer_arrival_collaborators (transfer_id, principal_id) VALUES (?, ?)
           ON CONFLICT DO NOTHING`,
          input.transferId,
          c.principalId,
        );
      return "ok";
    });
  }

  /** A transfer called off: the room it made here is free again, and none is made for it again. */
  releaseArrival(transferId: string): void {
    this.ctx.storage.transactionSync(() => this.#endArrival(transferId, false));
  }

  /**
   * In a transaction: the arrival of `transferId` ends here, adopted (its
   * owed uploads stay charged until they are confirmed here) or called off.
   */
  #endArrival(transferId: string, adopted: boolean): void {
    if (!adopted) {
      const row = this.ctx.storage.sql
        .exec<{ owed: string }>(
          "SELECT owed FROM transfer_arrivals WHERE transfer_id = ?",
          transferId,
        )
        .toArray()[0];
      for (const uploadId of JSON.parse(row?.owed ?? "[]") as string[])
        this.#quotas().release(uploadId);
    }
    this.#dropArrival(transferId);
    this.ctx.storage.sql.exec(
      "INSERT INTO transfer_arrivals (transfer_id, repo_id, state, expires_at) VALUES (?, '', 'done', ?)",
      transferId,
      this.#now() + ENDED_ARRIVAL_KEEP_MS,
    );
  }

  /** In a transaction: forgets the arrival of `transferId` and the room it held. */
  #dropArrival(transferId: string): void {
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM transfer_arrivals WHERE transfer_id = ?", transferId);
    sql.exec("DELETE FROM transfer_arrival_collaborators WHERE transfer_id = ?", transferId);
    this.#quotas().release(transferId);
  }

  /** Records transfer step `op` of `transferId`; false when it was done before. */
  #firstTime(transferId: string, op: "adopt" | "release"): boolean {
    const done = this.ctx.storage.sql.exec(
      `INSERT INTO transfer_ops (transfer_id, op, done_at) VALUES (?, ?, ?)
       ON CONFLICT (transfer_id, op) DO NOTHING`,
      transferId,
      op,
      this.#now(),
    );
    return done.rowsWritten > 0;
  }

  /** Whether `repoId` is not this account's any more (deleted, or moved away): no grant or storage is taken for it. */
  #notHere(repoId: string): boolean {
    return (
      this.#forgotten(repoId) ||
      this.ctx.storage.sql.exec("SELECT 1 FROM released_repos WHERE repo_id = ?", repoId).toArray()
        .length > 0
    );
  }

  #forgotten(repoId: string): boolean {
    return (
      this.ctx.storage.sql.exec("SELECT 1 FROM forgotten_repos WHERE repo_id = ?", repoId).toArray()
        .length > 0
    );
  }

  /**
   * The repositories of the account `principalId` collaborates on with
   * `min` or stronger (in a user's account, the only roles another
   * principal can hold).
   */
  collaboratorRepos(principalId: string, min: RepoRole): string[] {
    return this.ctx.storage.sql
      .exec<{ repo_id: string; role: RepoRole }>(
        "SELECT repo_id, role FROM collaborators WHERE principal_id = ?",
        principalId,
      )
      .toArray()
      .filter((row) => atLeast(row.role, min))
      .map((row) => row.repo_id);
  }

  /** The collaborators of `repoId` after handle `after` (ignoring case), at most `limit`. */
  collaborators(repoId: string, after: string, limit: number): CollaboratorRow[] {
    return this.ctx.storage.sql
      .exec<{ principal_id: string; handle: string; role: RepoRole }>(
        `SELECT principal_id, handle, role FROM collaborators
         WHERE repo_id = ? AND handle > ? COLLATE NOCASE
         ORDER BY handle COLLATE NOCASE LIMIT ?`,
        repoId,
        after,
        limit,
      )
      .toArray()
      .map((r) => ({ id: r.principal_id, handle: r.handle, role: r.role }));
  }

  /** Creates a team (no members, no repositories), if `actor` owns the organization now. */
  async createTeam(actor: ChangeActor, slug: string, name: string): Promise<AclChange> {
    return this.#change(actor, { owner: true }, (meta) => {
      if (this.#teamId(slug))
        return { ok: false, code: "team_taken", error: `A team ${slug} already exists.` };
      this.ctx.storage.sql.exec(
        "INSERT INTO teams (team_id, slug, name, created_at) VALUES (?, ?, ?, ?)",
        crypto.randomUUID(),
        slug,
        name,
        this.#now(),
      );
      // No access changed: no new version, but the creation is audited.
      this.#audit(actor, "org.team.create", { slug, name });
      return {
        ok: true,
        epochGen: meta.epoch_gen,
        version: meta.acl_version,
        changed: true,
        repos: [],
      };
    });
  }

  /** The organization's teams after slug `after`, at most `limit`. */
  teams(after: string, limit: number): TeamRow[] {
    return this.ctx.storage.sql
      .exec<{ slug: string; name: string }>(
        "SELECT slug, name FROM teams WHERE slug > ? ORDER BY slug LIMIT ?",
        after,
        limit,
      )
      .toArray()
      .map((r) => ({ slug: r.slug, name: r.name }));
  }

  /** Adds a member of the organization to a team, if `actor` owns the organization now. */
  async setTeamMember(actor: ChangeActor, slug: string, userId: string): Promise<AclChange> {
    return this.#change(actor, { owner: true }, (meta) => {
      const teamId = this.#teamId(slug);
      if (!teamId) return teamNotFound(slug);
      if (this.accountRole(userId) === null)
        return {
          ok: false,
          code: "not_a_member",
          error: "Only members of the organization join its teams.",
        };
      const added = this.ctx.storage.sql.exec(
        "INSERT INTO team_members (team_id, principal_id, added_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
        teamId,
        userId,
        this.#now(),
      ).rowsWritten;
      const repos = this.#teamRepos(teamId);
      if (added === 0) return this.#unchanged(meta, repos);
      return this.#changed(actor, "org.team.member.add", { team: slug, user: userId }, repos);
    });
  }

  /** Removes a member from a team, if `actor` owns the organization now. */
  async removeTeamMember(actor: ChangeActor, slug: string, userId: string): Promise<AclChange> {
    return this.#change(actor, { owner: true }, (meta) => {
      const teamId = this.#teamId(slug);
      if (!teamId) return teamNotFound(slug);
      const removed = this.ctx.storage.sql.exec(
        "DELETE FROM team_members WHERE team_id = ? AND principal_id = ?",
        teamId,
        userId,
      ).rowsWritten;
      const repos = this.#teamRepos(teamId);
      if (removed === 0) return this.#unchanged(meta, repos);
      const changed = this.#changed(
        actor,
        "org.team.member.remove",
        { team: slug, user: userId },
        repos,
      );
      const lost = repos.filter((repoId) => this.#roleOn(repoId, userId, meta) === null);
      this.#revoked(actor, [userId], lost, (changed as { version: number }).version);
      return changed;
    });
  }

  /** Gives a team a role on repository `repoId` of the organization, if `actor` owns it now. */
  async setTeamRepo(
    actor: ChangeActor,
    slug: string,
    repoId: string,
    role: RepoRole,
  ): Promise<AclChange> {
    return this.#change(actor, { owner: true }, (meta) => {
      const teamId = this.#teamId(slug);
      if (!teamId) return teamNotFound(slug);
      if (this.#notHere(repoId)) return REPO_GONE;
      const current = this.ctx.storage.sql
        .exec<{ role: RepoRole }>(
          "SELECT role FROM team_repos WHERE team_id = ? AND repo_id = ?",
          teamId,
          repoId,
        )
        .toArray()[0]?.role;
      if (current === role) return this.#unchanged(meta, [repoId]);
      this.ctx.storage.sql.exec(
        `INSERT INTO team_repos (team_id, repo_id, role, added_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (team_id, repo_id) DO UPDATE SET role = excluded.role`,
        teamId,
        repoId,
        role,
        this.#now(),
      );
      return this.#changed(actor, "org.team.repo.set", { team: slug, repo: repoId, role }, [
        repoId,
      ]);
    });
  }

  /** Takes a team's role on `repoId` away, if `actor` owns the organization now. */
  async removeTeamRepo(actor: ChangeActor, slug: string, repoId: string): Promise<AclChange> {
    return this.#change(actor, { owner: true }, (meta) => {
      const teamId = this.#teamId(slug);
      if (!teamId) return teamNotFound(slug);
      const removed = this.ctx.storage.sql.exec(
        "DELETE FROM team_repos WHERE team_id = ? AND repo_id = ?",
        teamId,
        repoId,
      ).rowsWritten;
      if (removed === 0) return this.#unchanged(meta, [repoId]);
      const changed = this.#changed(actor, "org.team.repo.remove", { team: slug, repo: repoId }, [
        repoId,
      ]);
      const lost = this.ctx.storage.sql
        .exec<{ principal_id: string }>(
          "SELECT principal_id FROM team_members WHERE team_id = ?",
          teamId,
        )
        .toArray()
        .map((m) => m.principal_id)
        .filter((principal) => this.#roleOn(repoId, principal, meta) === null);
      this.#revoked(actor, lost, [repoId], (changed as { version: number }).version);
      return changed;
    });
  }

  /**
   * One access change: in one transaction, `actor`'s authority is checked
   * (an owner of the organization, or an administrator of the repository),
   * then `apply` runs; its audit row is delivered afterwards. A change that
   * would take a snapshot past its limit is undone.
   */
  async #change(
    actor: ChangeActor,
    needs: { readonly owner: true } | { readonly repoAdmin: string },
    apply: (meta: Meta) => AclChange,
  ): Promise<AclChange> {
    await this.#checkEpoch();
    let change: AclChange;
    try {
      change = this.ctx.storage.transactionSync((): AclChange => {
        const meta = this.#meta();
        if ("owner" in needs) {
          const refused = this.#refuse(actor);
          if (refused) return refused;
        } else {
          if (!meta) return NOT_RECORDED;
          if (!atLeast(this.#roleOn(needs.repoAdmin, actor.principalId, meta), "admin"))
            return FORBIDDEN;
        }
        return apply(this.#meta() as Meta);
      });
    } catch (error) {
      if (error instanceof TooMany) return TOO_MANY;
      throw error;
    }
    this.#scheduleDelivery(change);
    await this.#armOutbox();
    return change;
  }

  /** Nothing changed; `repos` (absent: all of the account's) are still told the current version, so a retry repeats a lost notice. */
  #unchanged(meta: Meta, repos?: readonly string[]): AclChange {
    return {
      ok: true,
      epochGen: meta.epoch_gen,
      version: meta.acl_version,
      changed: false,
      ...(repos && { repos }),
    };
  }

  /** In a change's transaction: a new version and the audit row. */
  #changed(
    actor: ChangeActor,
    action: string,
    details: Record<string, unknown>,
    repos?: readonly string[],
  ): AclChange {
    const version = this.#bump();
    this.#audit(actor, action, { ...details, acl_version: version });
    return {
      ok: true,
      epochGen: (this.#meta() as Meta).epoch_gen,
      version,
      changed: true,
      ...(repos && { repos }),
    };
  }

  #collaboratorRole(repoId: string, principalId: string): RepoRole | null {
    return (
      this.ctx.storage.sql
        .exec<{ role: RepoRole }>(
          "SELECT role FROM collaborators WHERE repo_id = ? AND principal_id = ?",
          repoId,
          principalId,
        )
        .toArray()[0]?.role ?? null
    );
  }

  #teamId(slug: string): string | undefined {
    return this.ctx.storage.sql
      .exec<{ team_id: string }>("SELECT team_id FROM teams WHERE slug = ?", slug)
      .toArray()[0]?.team_id;
  }

  #teamRepos(teamId: string): string[] {
    return this.ctx.storage.sql
      .exec<{ repo_id: string }>("SELECT repo_id FROM team_repos WHERE team_id = ?", teamId)
      .toArray()
      .map((r) => r.repo_id);
  }

  /**
   * Delivers waiting audit rows to the directory, oldest first, deleting
   * each batch once written (at least once: a batch written whose delete
   * was lost is written again). A failure leaves them for the alarm.
   * Concurrent callers share one delivery.
   */
  deliverAudit(): Promise<void> {
    this.#delivering ??= this.#deliver().finally(() => {
      this.#delivering = undefined;
    });
    return this.#delivering;
  }

  #delivering: Promise<void> | undefined;

  async #deliver(): Promise<void> {
    for (;;) {
      const rows = this.ctx.storage.sql
        .exec<AuditRow>(
          `SELECT seq, at, actor_id, action, target_id, details, request_id FROM pending_audit
           ORDER BY seq LIMIT ?`,
          AUDIT_BATCH,
        )
        .toArray();
      if (rows.length === 0) return;
      // The directory's own table, so its archiver keeps them with the other auth events.
      const db = this.env.DIRECTORY;
      await db.batch(
        rows.map((row) =>
          db
            .prepare(
              `INSERT INTO audit_log (at, actor_id, action, target_id, details, request_id)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .bind(row.at, row.actor_id, row.action, row.target_id, row.details, row.request_id),
        ),
      );
      const last = rows.at(-1)?.seq as number;
      this.ctx.storage.sql.exec("DELETE FROM pending_audit WHERE seq <= ?", last);
    }
  }

  override async alarm(): Promise<void> {
    // Events first (a failure backs off and never stops the audit delivery).
    try {
      const outbox = this.#outbox;
      const now = this.#now();
      const sendAt = outbox.sendDueAt();
      const accountId = this.#meta()?.account_id;
      if (accountId && sendAt !== null && sendAt <= now) {
        const sent = await outbox.drain(accountId);
        if (!sent.ok)
          createLogger({ op: "org.outbox", doClass: "OrgDO" }).warn("sending events failed", {
            error: sent.error,
          });
      } else {
        // Nothing to send: stored payloads past their retention go.
        const due = outbox.dueAt();
        if (due !== null && due <= now) outbox.prunePayloads();
      }
      await this.#armOutbox();
    } catch (error) {
      createLogger({ op: "org.outbox", doClass: "OrgDO" }).warn("draining the outbox failed", {
        error,
      });
    }
    try {
      await this.deliverAudit();
    } catch (error) {
      createLogger({ op: "org.audit", doClass: "OrgDO" }).warn("delivering audit rows failed", {
        error,
      });
      // Tried again later, unless the outbox needs the alarm sooner.
      await this.#armBy(this.#now() + AUDIT_RETRY_MS);
    }
  }

  /**
   * Whether this instance has taken the directory's restore generation. A
   * restored object starts as a new instance with the generation it had;
   * until it takes the directory's newer one, its ACL versions could repeat
   * ones repositories have seen, and they would refuse its snapshots.
   */
  #epochChecked = false;
  #epochCheck: Promise<void> | undefined;

  #checkEpoch(): Promise<void> {
    if (this.#epochChecked) return Promise.resolve();
    this.#epochCheck ??= this.#takeEpoch().finally(() => {
      this.#epochCheck = undefined;
    });
    return this.#epochCheck;
  }

  async #takeEpoch(): Promise<void> {
    const meta = this.#meta();
    // Nothing recorded yet: `init` records the generation just allocated.
    if (!meta) return;
    const row = await this.env.DIRECTORY.withSession("first-primary")
      .prepare("SELECT epoch_gen FROM source_epochs WHERE source_id = ?")
      .bind(meta.account_id)
      .first<{ epoch_gen: number }>();
    if (row && row.epoch_gen > (this.#meta() as Meta).epoch_gen)
      this.ctx.storage.sql.exec(
        "UPDATE org_meta SET epoch_gen = ?, epoch_uuid = ? WHERE id = 1",
        row.epoch_gen,
        crypto.randomUUID(),
      );
    this.#epochChecked = true;
  }

  /** Why `actor` may not change the account's access now, if it may not. */
  #refuse(actor: ChangeActor): AclChange | undefined {
    const meta = this.#meta();
    if (meta?.kind !== "org") return NOT_AN_ORG;
    if (this.accountRole(actor.principalId) !== "owner") return FORBIDDEN;
    return undefined;
  }

  #owners(): number {
    return this.ctx.storage.sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM members WHERE role = 'owner'")
      .one().n;
  }

  #bump(): number {
    return this.ctx.storage.sql
      .exec<{ v: number }>(
        "UPDATE org_meta SET acl_version = acl_version + 1 WHERE id = 1 RETURNING acl_version AS v",
      )
      .one().v;
  }

  #audit(actor: ChangeActor, action: string, details: Record<string, unknown>): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO pending_audit (at, actor_id, action, target_id, details, request_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      this.#now(),
      actor.principalId,
      action,
      (this.#meta() as Meta).account_id,
      JSON.stringify(details),
      actor.requestId ?? null,
    );
  }

  /**
   * A change wrote an audit row: the alarm delivers it soon if the caller
   * does not. An earlier alarm (a retry already due) is kept, so frequent
   * changes cannot postpone delivery.
   */
  #scheduleDelivery(change: AclChange): void {
    if (!(change.ok && change.changed)) return;
    const at = this.#now() + AUDIT_RETRY_MS;
    void this.ctx.storage.getAlarm().then((current) => {
      if (current === null || current > at) return this.ctx.storage.setAlarm(at);
    });
  }
}

/** SQL ranking a team grant's role (`tr.role`) as its index in `REPO_ROLES`. */
const RANK = `CASE tr.role ${REPO_ROLES.map((r, i) => `WHEN '${r}' THEN ${i}`).join(" ")} END`;

/** Thrown in a change's transaction to undo it: a snapshot would grow past its limit. */
class TooMany extends Error {}

type AuditRow = {
  seq: number;
  at: number;
  actor_id: string | null;
  action: string;
  target_id: string;
  details: string;
  request_id: string | null;
};

const NOT_AN_ORG = {
  ok: false,
  code: "not_an_org",
  error: "The account is not an organization.",
} as const;

const FORBIDDEN = {
  ok: false,
  code: "forbidden",
  error: "Only an owner of the organization may change its members.",
} as const;

const NOT_RECORDED = {
  ok: false,
  code: "not_recorded",
  error: "The account has no access records yet.",
} as const;

const TOO_MANY = {
  ok: false,
  code: "too_many",
  error: `A repository of the account would have more than ${MAX_SNAPSHOT_ENTRIES} principals with access.`,
} as const;

const REPO_GONE = { ok: false, code: "repo_gone", error: "The repository was deleted." } as const;

const teamNotFound = (slug: string): AclChange => ({
  ok: false,
  code: "team_not_found",
  error: `No team ${slug} was found.`,
});

const LAST_OWNER = {
  ok: false,
  code: "last_owner",
  error: "An organization keeps at least one owner.",
} as const;
