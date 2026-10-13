import type { CommitContext, RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import { REPO_ENTITY, type RepoRow } from "@fyrden/domain";
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
    readonly row: RepoRow;
  }[];
}

/** Who the repository is, as the Worker that creates it knows it. */
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

const META_COLUMNS =
  "repo_id, owner_gen, epoch_gen, version, owner_id, name, visibility, pushed_at, created_at";

type MetaRow = {
  repo_id: string;
  owner_gen: number;
  epoch_gen: number;
  version: number;
  owner_id: string | null;
  name: string | null;
  visibility: RepoRow["visibility"] | null;
  pushed_at: number | null;
  created_at: number;
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
   * reuse the ids the old history used. Emits a snapshot under the new
   * epoch. Once per instance; a repository without an identity has nothing
   * to check.
   */
  checkEpoch(read: () => Promise<number | null>): Promise<void> {
    if (this.#epochChecked || !this.#meta()) return Promise.resolve();
    this.#epochCheck ??= this.#checkEpoch(read).finally(() => {
      this.#epochCheck = undefined;
    });
    return this.#epochCheck;
  }

  async #checkEpoch(read: () => Promise<number | null>): Promise<void> {
    const current = await read();
    this.#storage.transactionSync(() => {
      const meta = this.#meta();
      if (meta && current !== null && current > meta.epoch_gen) {
        this.#exec(
          "events.epoch",
          "UPDATE repo_meta SET epoch_gen = ?, epoch_uuid = ? WHERE id = 1",
          current,
          crypto.randomUUID(),
        );
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
          deleted: false,
          row: this.#row(meta),
        },
      ],
    };
  }

  /** In a commit's transaction: the new snapshot, the ref updates and the audit row. */
  onCommit(context: CommitContext): void {
    const { refUpdates, actor } = context.request;
    if (refUpdates.length === 0 || !this.#meta()) return;
    if (!this.#epochChecked)
      throw new Error("the repository's epoch must be checked before it commits");
    this.#exec("events.pushed_at", "UPDATE repo_meta SET pushed_at = ? WHERE id = 1", context.now);
    const who = { actor: actor?.principal ?? null, actChain: [] };
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
    meta = meta as MetaRow;
    this.#exec(
      "events.audit",
      `INSERT INTO audit_log (epoch_gen, at, actor_id, on_behalf_of, token_id, grant_id, action,
         target_id, result, details)
       VALUES (?, ?, ?, ?, ?, ?, 'refs.update', ?, 'ok', ?)`,
      meta.epoch_gen,
      context.now,
      actor?.principal ?? null,
      actor?.onBehalfOf ?? null,
      actor?.tokenId ?? null,
      actor?.grantId ?? null,
      meta.repo_id,
      JSON.stringify({ via: actor?.via ?? null, refs: refUpdates.length }),
    );
  }

  /**
   * After HEAD moved outside a commit (an import names the source's default
   * branch): the snapshot with the new default branch, in the caller's
   * transaction.
   */
  onHeadChanged(): void {
    if (!this.#meta()) return;
    if (!this.#epochChecked)
      throw new Error("the repository's epoch must be checked before it changes");
    this.#emit("repo.updated", { actor: null, actChain: [], data: null }, true);
  }

  /**
   * Appends one event, taking the next sequence number; with `snapshot`,
   * also bumps the entity version and carries the full row. Returns the
   * metadata after the allocation.
   */
  #emit(
    type: string,
    event: Pick<NewEvent, "actor" | "actChain" | "data">,
    snapshot = false,
  ): MetaRow {
    const cursor = this.#storage.sql.exec<MetaRow & { source_seq: number }>(
      `UPDATE repo_meta SET source_seq = source_seq + 1, version = version + ?
       WHERE id = 1 RETURNING source_seq, ${META_COLUMNS}`,
      snapshot ? 1 : 0,
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
        entity: snapshot
          ? {
              type: REPO_ENTITY,
              id: meta.repo_id,
              version: meta.version,
              deleted: false,
              row: this.#row(meta),
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
      defaultBranch: this.git.refStore.head(),
      pushedAt: meta.pushed_at,
      createdAt: meta.created_at,
    };
  }
}
