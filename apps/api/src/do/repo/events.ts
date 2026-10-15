import {
  type CommitContext,
  DERIVED_REF_PREFIX,
  type RefActor,
  type RepoGitStorage,
} from "@fyrden/adapters-cloudflare/git";
import { type EntitySnapshot, REPO_ENTITY, type RepoRow } from "@fyrden/domain";
import { oidToHex } from "@fyrden/git-core";
import type { NewEvent, Outbox } from "../base/outbox.js";

/** A repository's snapshot as a read-model rebuild takes it. */
export interface RepoExport {
  readonly sourceId: string;
  readonly epochGen: number;
  readonly ownerGen: number;
  /** The last event sequence the export includes. */
  readonly watermark: number;
  readonly entities: readonly {
    readonly type: string;
    readonly id: string;
    readonly version: number;
    readonly deleted: boolean;
    /** Null once the repository is deleted. */
    readonly row: RepoRow | null;
  }[];
}

/** Who the repository is, as the Worker that creates it knows it. */
/** What the directory says of a repository when its object checks its epoch. */
export interface EpochCheck {
  /** The epoch it allocated (null for none yet). */
  readonly epochGen: number | null;
  /**
   * Read only when that epoch is newer than the object's (a restore): who
   * owns it and its name, the read model's owner generation fence, and a
   * transfer the directory has not finished (it lands the repository).
   */
  readonly owner?: {
    readonly ownerId: string;
    readonly name: string;
    readonly nameGen: number;
    readonly ownerFence: number;
    readonly transfer: { readonly id: string; readonly from: string; readonly to: string } | null;
  };
}

export interface RepoIdentity {
  readonly ownerId: string;
  readonly name: string;
  readonly visibility: RepoRow["visibility"];
  /** Allocated from the directory before the object is created. */
  readonly epochGen: number;
}

/**
 * Ref updates in one `refs.updated` event at most. A ref name is at most
 * 1,024 characters (up to about 3 KiB in UTF-8), so 500 stay under the
 * 2 MB row limit of Durable Object SQLite when the event is stored
 * (verified: https://developers.cloudflare.com/durable-objects/platform/limits/).
 */
export const REFS_PER_EVENT = 500;

/**
 * Who started a job that changes the repository later (a deletion, a
 * transfer): the principal, the agents acting for it and the request, as
 * the job recorded them. A bare id is a principal with neither.
 */
export interface JobActor {
  readonly principal: string;
  readonly actChain?: readonly string[];
  readonly requestId?: string | null;
}

/** The commit actor for `actor`, as a job's change records it. */
function jobRefActor(actor: JobActor | string | null): RefActor | null {
  if (actor === null) return null;
  return typeof actor === "string"
    ? { principal: actor, via: "api" }
    : {
        principal: actor.principal,
        actChain: actor.actChain ?? [],
        requestId: actor.requestId ?? null,
        via: "api",
      };
}

/** What a repository being deleted answers every write (and, once erased, every call). */
export const REPO_DELETED = "the repository is being deleted";
/** Why a repository takes no change while it moves to another account. */
export const REPO_TRANSFERRING = "the repository is being transferred; try again in a moment";

/** Whether `error` is a repository object refusing because its deletion started. */
export function isRepoDeleted(error: unknown): boolean {
  return error instanceof Error && error.message === REPO_DELETED;
}

/** One update of a repository's settings; fields left out are kept. */
export interface RepoUpdate {
  /**
   * The directory's name and its rename count: a name older than the one
   * recorded (a rename that arrives late) is ignored.
   */
  readonly name?: { readonly value: string; readonly gen: number };
  readonly description?: string | null;
  /** A branch ref (`refs/heads/...`) that exists. */
  readonly head?: string;
  readonly actor: RefActor | null;
}

const META_COLUMNS =
  "repo_id, owner_gen, epoch_gen, version, owner_id, name, name_gen, visibility, description, pushed_at, created_at, write_frozen, deleting_at, transfer_id, transfer_to";

type MetaRow = {
  repo_id: string;
  owner_gen: number;
  epoch_gen: number;
  version: number;
  owner_id: string | null;
  name: string | null;
  name_gen: number;
  visibility: RepoRow["visibility"] | null;
  description: string | null;
  pushed_at: number | null;
  created_at: number;
  write_frozen: number;
  deleting_at: number | null;
  transfer_id: string | null;
  transfer_to: string | null;
};

/**
 * The repository's events: its snapshot (the `repo` entity), activity such
 * as ref updates, and the audit row of each change, written in the
 * transaction of the change. `repo_meta` is the entity's source; an object
 * created before it existed (only test fixtures) has none and emits nothing.
 */
export class RepoEvents {
  /**
   * Whether this instance has checked its epoch against the directory. A
   * restored object starts as a new instance with the epoch it had before;
   * until it has taken the directory's newer one, a commit would reuse
   * event ids, so commits are refused before the check.
   */
  #epochChecked = false;

  /** The check in flight, shared by concurrent first writers. */
  #epochCheck: Promise<void> | undefined;

  /** An update is moving HEAD: its own snapshot carries the new default branch. */
  #updating = false;

  constructor(
    private readonly git: RepoGitStorage,
    private readonly outbox: Outbox,
    private readonly repoId: () => string,
  ) {}

  get #storage() {
    return this.git.context.storage;
  }

  #meta(): MetaRow | undefined {
    return this.#storage.sql
      .exec<MetaRow>(`SELECT ${META_COLUMNS} FROM repo_meta WHERE id = 1`)
      .toArray()[0];
  }

  #exec(op: string, query: string, ...bindings: unknown[]): void {
    const cursor = this.#storage.sql.exec(query, ...bindings);
    cursor.toArray();
    if (cursor.rowsWritten > 0)
      this.git.context.metrics.count(
        "do.rows_written",
        { class: this.git.context.doClass, op },
        cursor.rowsWritten,
      );
  }

  /** The description, or null (also before the identity is recorded). */
  description(): string | null {
    return this.#meta()?.description ?? null;
  }

  /**
   * The account the repository belongs to, its owner and owner generation
   * (one per transfer); undefined before its identity is recorded.
   */
  account(): { accountId: string; ownerId: string; ownerGen: number } | undefined {
    const row = this.#storage.sql
      .exec<{ org_id: string; owner_id: string | null; owner_gen: number }>(
        "SELECT org_id, owner_id, owner_gen FROM repo_meta WHERE id = 1",
      )
      .toArray()[0];
    return row?.owner_id
      ? { accountId: row.org_id, ownerId: row.owner_id, ownerGen: row.owner_gen }
      : undefined;
  }

  /** The organization (or account) the repository belongs to, or null before its creation is recorded. */
  orgId(): string | null {
    return (
      this.#storage.sql
        .exec<{ org_id: string }>("SELECT org_id FROM repo_meta WHERE id = 1")
        .toArray()[0]?.org_id ?? null
    );
  }

  /**
   * Throws if the repository was created with another identity; call it
   * before any other write of a creation, so a mistaken call changes
   * nothing.
   */
  assertIdentity(identity: RepoIdentity): void {
    const existing = this.#meta();
    if (existing && (existing.owner_id !== identity.ownerId || existing.name !== identity.name))
      throw new Error("the repository was created with another identity");
  }

  /**
   * Records the repository's identity and emits its creation. Idempotent:
   * a retried call with the identity already recorded does nothing.
   */
  init(identity: RepoIdentity, actor: string | null): void {
    this.#storage.transactionSync(() => {
      this.assertIdentity(identity);
      if (this.#meta()) return;
      const now = this.git.context.now();
      this.#exec(
        "events.init",
        `INSERT INTO repo_meta (id, repo_id, org_id, owner_gen, epoch_gen, epoch_uuid, created_at,
           owner_id, name, visibility)
         VALUES (1, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
        this.repoId(),
        // Until organizations exist, the owner's namespace is the account.
        identity.ownerId,
        identity.epochGen,
        crypto.randomUUID(),
        now,
        identity.ownerId,
        identity.name,
        identity.visibility,
      );
      this.#emit("repo.created", { actor, actChain: [], data: null }, true);
      // The epoch was just allocated from the directory.
      this.#epochChecked = true;
    });
  }

  /**
   * Takes the directory's epoch for this repository (`read`) if it is newer
   * than the one recorded: a restore happened, so later events must not
   * reuse the ids the old history used. The restored object may predate a
   * transfer or a rename: it takes the owner and name the directory names
   * now (`owner`), the owner in a generation past the read model's fence,
   * so a former owner's account no longer answers for it. Emits a snapshot
   * under the new epoch. Once per instance; a repository without an
   * identity has nothing to check.
   */
  checkEpoch(read: (recorded: number) => Promise<EpochCheck>): Promise<void> {
    if (this.#epochChecked || !this.#meta()) return Promise.resolve();
    this.#epochCheck ??= this.#checkEpoch(read).finally(() => {
      this.#epochCheck = undefined;
    });
    return this.#epochCheck;
  }

  async #checkEpoch(read: (recorded: number) => Promise<EpochCheck>): Promise<void> {
    const { epochGen: current, owner } = await read(this.#meta()?.epoch_gen ?? 0);
    this.#storage.transactionSync(() => {
      const meta = this.#meta();
      if (meta && current !== null && current > meta.epoch_gen) {
        this.#exec(
          "events.epoch",
          "UPDATE repo_meta SET epoch_gen = ?, epoch_uuid = ? WHERE id = 1",
          current,
          crypto.randomUUID(),
        );
        // Never below the fence: the read model takes nothing of an older owner generation.
        if (owner?.transfer)
          // A transfer under way: the account handing it over, frozen, until the transfer
          // lands it (its saga goes on from the step it is at).
          this.#exec(
            "events.epoch_transfer",
            `UPDATE repo_meta SET org_id = ?1, owner_id = ?1, owner_gen = max(owner_gen, ?2),
               transfer_id = ?3, transfer_to = ?4, write_frozen = 1 WHERE id = 1`,
            owner.transfer.from,
            owner.ownerFence,
            owner.transfer.id,
            owner.transfer.to,
          );
        else if (owner) {
          this.#exec(
            "events.epoch_owner",
            `UPDATE repo_meta SET org_id = ?1, owner_id = ?1, owner_gen = max(owner_gen, ?2),
               transfer_id = NULL, transfer_to = NULL,
               write_frozen = CASE WHEN deleting_at IS NULL THEN 0 ELSE 1 END WHERE id = 1`,
            owner.ownerId,
            owner.ownerFence,
          );
          this.#exec(
            "events.epoch_name",
            "UPDATE repo_meta SET name = ?, name_gen = ? WHERE id = 1 AND name_gen < ?",
            owner.name,
            owner.nameGen,
            owner.nameGen,
          );
        }
        this.#emit("repo.updated", { actor: null, actChain: [], data: null }, true);
      }
    });
    this.#epochChecked = true;
  }

  /**
   * The repository's current snapshot for a read-model rebuild, with the
   * sequence the export starts at; null without an identity.
   */
  exportSnapshot(): RepoExport | null {
    const meta = this.#meta();
    if (!meta) return null;
    const { source_seq: watermark } = this.#storage.sql
      .exec<{ source_seq: number }>("SELECT source_seq FROM repo_meta WHERE id = 1")
      .one();
    return {
      sourceId: meta.repo_id,
      epochGen: meta.epoch_gen,
      ownerGen: meta.owner_gen,
      watermark,
      entities: [
        {
          type: REPO_ENTITY,
          id: meta.repo_id,
          version: meta.version,
          deleted: meta.deleting_at !== null,
          row: meta.deleting_at === null ? this.#row(meta) : null,
        },
      ],
    };
  }

  /**
   * Freezes the repository for its deletion: from now on no ref, HEAD or
   * setting changes; emits its tombstone and the audit row, once.
   */
  markDeleted(actor: JobActor | string | null): void {
    this.#storage.transactionSync(() => {
      const meta = this.#meta();
      if (!meta || meta.deleting_at !== null) return;
      if (!this.#epochChecked)
        throw new Error("the repository's epoch must be checked before it changes");
      const now = this.git.context.now();
      this.#exec(
        "events.delete",
        "UPDATE repo_meta SET write_frozen = 1, deleting_at = ? WHERE id = 1",
        now,
      );
      const who = jobRefActor(actor);
      const after = this.#emit(
        "repo.deleted",
        { actor: who?.principal ?? null, actChain: [...(who?.actChain ?? [])], data: null },
        true,
      );
      this.#audit(after, "repo.delete", who, now, { name: meta.name });
    });
  }

  /** Whether the repository's identity is recorded (objects created before identities existed have none). */
  hasIdentity(): boolean {
    return this.#meta() !== undefined;
  }

  /** Whether the deletion froze the repository (its tombstone was emitted). */
  isDeleted(): boolean {
    return (this.#meta()?.deleting_at ?? null) !== null;
  }

  /** Throws when the repository is frozen (being deleted or transferred): nothing may change it. */
  #assertWritable(meta: MetaRow | undefined): void {
    const reason = frozenReason(meta);
    if (reason) throw new Error(reason);
  }

  /** The repository's visibility; null before its identity is recorded. */
  visibility(): RepoRow["visibility"] | null {
    return (this.#meta()?.visibility as RepoRow["visibility"] | undefined) ?? null;
  }

  /** Why nothing may change the repository now, if anything stops it. */
  frozen(): string | undefined {
    return frozenReason(this.#meta());
  }

  /** Whether a transfer is moving the repository. */
  isTransferring(): boolean {
    return (this.#meta()?.transfer_id ?? null) !== null;
  }

  /**
   * Freezes the repository for transfer `transferId` (from `from`, the
   * owner its caller was authorized for, to `to`): from now on no ref, HEAD
   * or setting changes until it lands or is called off. The same transfer
   * again changes nothing; one that ended (a late runner) freezes nothing.
   */
  freezeForTransfer(transfer: {
    readonly transferId: string;
    readonly from: string;
    readonly to: string;
  }): "frozen" | "deleted" | "other_transfer" | "not_owner" | "no_identity" | "landed" | "ended" {
    return this.#storage.transactionSync(() => {
      const meta = this.#meta();
      if (!meta) return "no_identity";
      const ended = this.#ended(transfer.transferId);
      if (ended) return ended.landed ? "landed" : "ended";
      if (meta.transfer_id !== null)
        return meta.transfer_id === transfer.transferId ? "frozen" : "other_transfer";
      if (meta.deleting_at !== null) return "deleted";
      if (meta.owner_id !== transfer.from) return "not_owner";
      this.#exec(
        "events.transfer_freeze",
        "UPDATE repo_meta SET write_frozen = 1, transfer_id = ?, transfer_to = ? WHERE id = 1",
        transfer.transferId,
        transfer.to,
      );
      return "frozen";
    });
  }

  /**
   * Calls transfer `transferId` off: the repository takes changes again
   * (unless it is being deleted), and a late freeze of that transfer
   * freezes nothing. A transfer that landed is not called off.
   */
  unfreezeTransfer(transferId: string): void {
    this.#storage.transactionSync(() => {
      const meta = this.#meta();
      if (!meta || this.#ended(transferId)) return;
      this.#endTransfer(transferId, false, meta.owner_gen);
      if (meta.transfer_id !== transferId) return;
      this.#exec(
        "events.transfer_unfreeze",
        `UPDATE repo_meta SET transfer_id = NULL, transfer_to = NULL,
           write_frozen = CASE WHEN deleting_at IS NULL THEN 0 ELSE 1 END WHERE id = 1`,
      );
    });
  }

  /** The owner generation transfer `transferId` lands the repository in. */
  transferGeneration(transferId: string): number {
    const meta = this.#meta();
    const ended = this.#ended(transferId);
    if (ended?.landed) return ended.owner_gen;
    if (!ended && meta?.transfer_id === transferId) return meta.owner_gen + 1;
    throw new Error("the repository is not in this transfer");
  }

  /**
   * Lands transfer `transferId`: the repository now belongs to `to`, under
   * `name` (`nameGen`, the directory's count of its names), in a new owner
   * generation, so events of the old one are refused by the read model.
   * Emits its snapshot and the audit row, and takes changes again (a
   * deletion that started meanwhile keeps it frozen). Landed already,
   * nothing changes (`changed` false).
   */
  completeTransfer(
    to: {
      readonly transferId: string;
      readonly ownerId: string;
      readonly name: string;
      readonly nameGen: number;
    },
    actor: JobActor | string | null,
  ): { ownerGen: number; changed: boolean } {
    return this.#storage.transactionSync(() => {
      const meta = this.#meta();
      if (!meta) throw new Error("the repository has no identity to transfer");
      const ended = this.#ended(to.transferId);
      if (ended?.landed) return { ownerGen: ended.owner_gen, changed: false };
      if (ended || meta.transfer_id !== to.transferId || meta.transfer_to !== to.ownerId)
        throw new Error("the repository is not in this transfer");
      if (!this.#epochChecked)
        throw new Error("the repository's epoch must be checked before it changes");
      this.#exec(
        "events.transfer_complete",
        `UPDATE repo_meta SET org_id = ?1, owner_id = ?1, name = ?2,
           name_gen = max(name_gen, ?3), owner_gen = owner_gen + 1,
           transfer_id = NULL, transfer_to = NULL,
           write_frozen = CASE WHEN deleting_at IS NULL THEN 0 ELSE 1 END WHERE id = 1`,
        to.ownerId,
        to.name,
        to.nameGen,
      );
      const who = jobRefActor(actor);
      const after = this.#emit(
        "repo.updated",
        { actor: who?.principal ?? null, actChain: [...(who?.actChain ?? [])], data: null },
        true,
      );
      this.#endTransfer(to.transferId, true, after.owner_gen);
      this.#audit(after, "repo.transfer", who, this.git.context.now(), {
        from: meta.owner_id,
        to: to.ownerId,
        name: to.name,
      });
      return { ownerGen: after.owner_gen, changed: true };
    });
  }

  #ended(transferId: string): { landed: number; owner_gen: number } | undefined {
    return this.#storage.sql
      .exec<{ landed: number; owner_gen: number }>(
        "SELECT landed, owner_gen FROM ended_transfers WHERE transfer_id = ?",
        transferId,
      )
      .toArray()[0];
  }

  #endTransfer(transferId: string, landed: boolean, ownerGen: number): void {
    this.#exec(
      "events.transfer_end",
      "INSERT INTO ended_transfers (transfer_id, landed, owner_gen, ended_at) VALUES (?, ?, ?, ?)",
      transferId,
      landed ? 1 : 0,
      ownerGen,
      this.git.context.now(),
    );
  }

  /**
   * In a commit's transaction: the new snapshot, the ref updates and the
   * audit row. Pull request refs are the server's: their moves are told as
   * pull request events, not as ref updates.
   */
  onCommit(context: CommitContext): void {
    const { actor } = context.request;
    if (context.request.refUpdates.length === 0) return;
    const current = this.#meta();
    this.#assertWritable(current);
    if (!current) return;
    if (!this.#epochChecked)
      throw new Error("the repository's epoch must be checked before it commits");
    const refUpdates = context.request.refUpdates.filter(
      (u) => !u.name.startsWith(DERIVED_REF_PREFIX),
    );
    if (refUpdates.length === 0) return;
    this.#exec("events.pushed_at", "UPDATE repo_meta SET pushed_at = ? WHERE id = 1", context.now);
    const who = { actor: actor?.principal ?? null, actChain: [...(actor?.actChain ?? [])] };
    this.#emit("repo.updated", { ...who, data: null }, true);
    // A commit may move thousands of refs (a fork's first commit): one event
    // per slice keeps a stored payload under the 2 MB row limit.
    const parts = Math.ceil(refUpdates.length / REFS_PER_EVENT);
    let meta: MetaRow | undefined;
    for (let part = 0; part < parts; part++) {
      const slice = refUpdates.slice(part * REFS_PER_EVENT, (part + 1) * REFS_PER_EVENT);
      meta = this.#emit("refs.updated", {
        ...who,
        data: {
          via: actor?.via ?? null,
          part: part + 1,
          parts,
          refs: slice.map((u) => ({
            ref: u.name,
            old: u.oldOid && oidToHex(u.oldOid),
            new: u.newOid && oidToHex(u.newOid),
          })),
        },
      });
    }
    this.#audit(meta as MetaRow, "refs.update", actor ?? null, context.now, {
      via: actor?.via ?? null,
      refs: refUpdates.length,
    });
  }

  /**
   * Applies an update in one transaction: the new settings and HEAD, one
   * snapshot and the audit row of what changed; nothing when nothing
   * changes. A repository without an identity only moves HEAD.
   */
  update(update: RepoUpdate): void {
    this.#storage.transactionSync(() => {
      const meta = this.#meta();
      this.#assertWritable(meta);
      if (meta && !this.#epochChecked)
        throw new Error("the repository's epoch must be checked before it changes");
      const changes: Record<string, unknown> = {};
      const head = this.git.refStore.head();
      if (update.head !== undefined && update.head !== head) {
        this.#updating = true;
        try {
          this.git.refStore.setHead(update.head);
        } finally {
          this.#updating = false;
        }
        changes.default_branch = { from: head, to: update.head };
      }
      if (!meta) return;
      if (update.name && update.name.gen > meta.name_gen) {
        this.#exec(
          "events.rename",
          "UPDATE repo_meta SET name = ?, name_gen = ? WHERE id = 1",
          update.name.value,
          update.name.gen,
        );
        if (update.name.value !== meta.name)
          changes.name = { from: meta.name, to: update.name.value };
      }
      if (update.description !== undefined && update.description !== meta.description) {
        this.#exec(
          "events.describe",
          "UPDATE repo_meta SET description = ? WHERE id = 1",
          update.description,
        );
        changes.description = true;
      }
      if (Object.keys(changes).length === 0) return;
      const who = update.actor?.principal ?? null;
      const actChain = [...(update.actor?.actChain ?? [])];
      const after = this.#emit("repo.updated", { actor: who, actChain, data: null }, true);
      this.#audit(after, "repo.update", update.actor, this.git.context.now(), changes);
    });
  }

  /**
   * In the caller's transaction: an event about another of the
   * repository's entities (a pull request), carrying its snapshot. The
   * repository must be writable, with its epoch checked.
   */
  emitEntity(
    type: string,
    actor: RefActor | null,
    entity: Omit<EntitySnapshot, "deleted">,
    data: Record<string, unknown> | null = null,
    /** The entity is gone: its snapshot carries no row. */
    deleted = false,
  ): void {
    this.#assertCanEmit();
    this.#emit(
      type,
      { actor: actor?.principal ?? null, actChain: [...(actor?.actChain ?? [])], data },
      { ...entity, deleted, row: deleted ? null : entity.row },
    );
  }

  /**
   * In the caller's transaction: an activity event with no entity (a review
   * requested of someone). The repository must be writable, with its epoch
   * checked.
   */
  emitActivity(type: string, actor: RefActor | null, data: Record<string, unknown>): void {
    this.#assertCanEmit();
    this.#emit(type, {
      actor: actor?.principal ?? null,
      actChain: [...(actor?.actChain ?? [])],
      data,
    });
  }

  /** Whether an event about the repository's entities may be emitted now (see `#assertCanEmit`). */
  canEmit(): boolean {
    const meta = this.#meta();
    return meta !== undefined && frozenReason(meta) === undefined && this.#epochChecked;
  }

  /** An event about the repository's entities needs it writable, with an identity and its epoch checked. */
  #assertCanEmit(): void {
    const meta = this.#meta();
    this.#assertWritable(meta);
    if (!meta) throw new Error("the repository has no identity yet");
    if (!this.#epochChecked)
      throw new Error("the repository's epoch must be checked before it changes");
  }

  /**
   * Audits a change of the repository's own settings (rulesets) in the
   * caller's transaction; nothing before the identity is recorded.
   */
  auditChange(action: string, actor: RefActor | null, details: Record<string, unknown>): void {
    const meta = this.#meta();
    if (meta) this.#audit(meta, action, actor, this.git.context.now(), details);
  }

  #audit(
    meta: MetaRow,
    action: string,
    actor: RefActor | null,
    at: number,
    details: Record<string, unknown>,
  ): void {
    this.#exec(
      "events.audit",
      `INSERT INTO audit_log (epoch_gen, at, actor_id, on_behalf_of, act_chain, token_id, grant_id,
         action, target_id, result, details, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?)`,
      meta.epoch_gen,
      at,
      actor?.principal ?? null,
      actor?.onBehalfOf ?? null,
      actor?.actChain?.length ? JSON.stringify(actor.actChain) : null,
      actor?.tokenId ?? null,
      actor?.grantId ?? null,
      action,
      meta.repo_id,
      JSON.stringify(details),
      actor?.requestId ?? null,
    );
  }

  /**
   * After HEAD moved outside a commit (an import names the source's default
   * branch): the snapshot with the new default branch, in the caller's
   * transaction.
   */
  onHeadChanged(): void {
    if (this.#updating) return;
    const meta = this.#meta();
    this.#assertWritable(meta);
    if (!meta) return;
    if (!this.#epochChecked)
      throw new Error("the repository's epoch must be checked before it changes");
    this.#emit("repo.updated", { actor: null, actChain: [], data: null }, true);
  }

  /**
   * Appends one event, taking the next sequence number; with `snapshot`,
   * also bumps the repository's version and carries its full row; with
   * another entity's snapshot, carries that one. Returns the metadata after
   * the allocation.
   */
  #emit(
    type: string,
    event: Pick<NewEvent, "actor" | "actChain" | "data">,
    snapshot: boolean | EntitySnapshot = false,
  ): MetaRow {
    const cursor = this.#storage.sql.exec<MetaRow & { source_seq: number }>(
      `UPDATE repo_meta SET source_seq = source_seq + 1, version = version + ?
       WHERE id = 1 RETURNING source_seq, ${META_COLUMNS}`,
      snapshot === true ? 1 : 0,
    );
    const meta = cursor.one();
    this.git.context.metrics.count(
      "do.rows_written",
      { class: this.git.context.doClass, op: "events.sequence" },
      cursor.rowsWritten,
    );
    this.outbox.append(
      { sourceId: meta.repo_id, epochGen: meta.epoch_gen, sourceSeq: meta.source_seq },
      {
        ...event,
        type,
        at: this.git.context.now(),
        ownerGen: meta.owner_gen,
        entity:
          typeof snapshot === "object"
            ? snapshot
            : snapshot
              ? {
                  type: REPO_ENTITY,
                  id: meta.repo_id,
                  version: meta.version,
                  deleted: meta.deleting_at !== null,
                  row: meta.deleting_at === null ? this.#row(meta) : null,
                }
              : null,
      },
    );
    return meta;
  }

  #row(meta: MetaRow): RepoRow {
    return {
      ownerId: meta.owner_id as string,
      name: meta.name as string,
      visibility: meta.visibility as RepoRow["visibility"],
      description: meta.description,
      defaultBranch: this.git.refStore.head(),
      pushedAt: meta.pushed_at,
      createdAt: meta.created_at,
    };
  }
}

function frozenReason(meta: MetaRow | undefined): string | undefined {
  if (!meta?.write_frozen) return undefined;
  return meta.deleting_at === null && meta.transfer_id !== null ? REPO_TRANSFERRING : REPO_DELETED;
}
