import { createLogger } from "@fyrden/adapters-cloudflare/obs";
import { type OrgRole, orgRepoRole, type RepoRole } from "@fyrden/domain";
import { MigratingDO } from "./base/MigratingDO.js";
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

export type MemberChange =
  | {
      readonly ok: true;
      readonly epochGen: number;
      readonly version: number;
      readonly changed: boolean;
    }
  | {
      readonly ok: false;
      readonly code: "not_an_org" | "forbidden" | "last_owner" | "not_a_member";
      readonly error: string;
    };

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

type Meta = {
  account_id: string;
  kind: "org" | "user";
  acl_version: number;
  epoch_gen: number;
};

/** Audit rows one delivery sends at most. */
const AUDIT_BATCH = 50;
/** Wait before the alarm retries a delivery that failed. Proposed. */
const AUDIT_RETRY_MS = 60_000;

/**
 * One account (an organization, or a user's own namespace): the source of
 * truth for access to its repositories. Every change of access is checked
 * against the actor's role, bumps the ACL version and records its audit row
 * in one transaction, and returns only after it, so a revocation is in force
 * when its call returns. Audit rows are then delivered to the directory.
 */
export class OrgDO extends MigratingDO {
  static readonly schema = orgSchema;

  #now(): number {
    return Date.now();
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
    const roles: Record<string, RepoRole> = {};
    if (meta.kind === "org") {
      const members = this.ctx.storage.sql
        .exec<{ principal_id: string; role: OrgRole }>(
          "SELECT principal_id, role FROM members LIMIT ?",
          MAX_SNAPSHOT_ENTRIES + 1,
        )
        .toArray();
      if (members.length > MAX_SNAPSHOT_ENTRIES)
        throw new Error(`the account has more than ${MAX_SNAPSHOT_ENTRIES} entries for ${repoId}`);
      for (const m of members) {
        const role = orgRepoRole(m.role, BASE_ROLE);
        if (role) roles[m.principal_id] = role;
      }
    }
    return {
      accountId: meta.account_id,
      epochGen: meta.epoch_gen,
      version: meta.acl_version,
      roles,
    };
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
  ): Promise<MemberChange> {
    await this.#checkEpoch();
    const change = this.ctx.storage.transactionSync((): MemberChange => {
      const refused = this.#refuse(actor);
      if (refused) return refused;
      const meta = this.#meta() as Meta;
      const current = this.accountRole(member.id);
      if (current === role)
        return { ok: true, epochGen: meta.epoch_gen, version: meta.acl_version, changed: false };
      if (current === "owner" && this.#owners() === 1) return LAST_OWNER;
      this.ctx.storage.sql.exec(
        `INSERT INTO members (principal_id, handle, role, added_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (principal_id) DO UPDATE SET role = excluded.role, handle = excluded.handle`,
        member.id,
        member.handle,
        role,
        this.#now(),
      );
      const version = this.#bump();
      this.#audit(actor, "org.member.set", { user: member.id, role, acl_version: version });
      return { ok: true, epochGen: (this.#meta() as Meta).epoch_gen, version, changed: true };
    });
    this.#scheduleDelivery(change);
    return change;
  }

  /** Removes a member, if `actor` is an owner now; the last owner cannot leave. */
  async removeMember(actor: ChangeActor, memberId: string): Promise<MemberChange> {
    await this.#checkEpoch();
    const change = this.ctx.storage.transactionSync((): MemberChange => {
      const refused = this.#refuse(actor);
      if (refused) return refused;
      const current = this.accountRole(memberId);
      if (current === null)
        return { ok: false, code: "not_a_member", error: "Not a member of the organization." };
      if (current === "owner" && this.#owners() === 1) return LAST_OWNER;
      this.ctx.storage.sql.exec("DELETE FROM members WHERE principal_id = ?", memberId);
      const version = this.#bump();
      this.#audit(actor, "org.member.remove", { user: memberId, acl_version: version });
      return { ok: true, epochGen: (this.#meta() as Meta).epoch_gen, version, changed: true };
    });
    this.#scheduleDelivery(change);
    return change;
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
    try {
      await this.deliverAudit();
    } catch (error) {
      createLogger({ op: "org.audit", doClass: "OrgDO" }).warn("delivering audit rows failed", {
        error,
      });
      await this.ctx.storage.setAlarm(this.#now() + AUDIT_RETRY_MS);
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
  #refuse(actor: ChangeActor): MemberChange | undefined {
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
  #scheduleDelivery(change: MemberChange): void {
    if (!(change.ok && change.changed)) return;
    const at = this.#now() + AUDIT_RETRY_MS;
    void this.ctx.storage.getAlarm().then((current) => {
      if (current === null || current > at) return this.ctx.storage.setAlarm(at);
    });
  }
}

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

const LAST_OWNER = {
  ok: false,
  code: "last_owner",
  error: "An organization keeps at least one owner.",
} as const;
