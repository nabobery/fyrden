import {
  isValidRefname,
  type Oid,
  oidEquals,
  oidFromBytes,
  type PackId,
  type RefCommitRequest,
  type RefCommitResult,
  type ReflogEntry,
  type RefNamespace,
  type RefSnapshot,
  type RefStore,
  type RefUpdate,
  refnameConflicts,
} from "@fyrden/git-core";
import {
  FINISHED_STATES,
  type PackRegistry,
  type PackRow,
  type PackState,
} from "./pack-registry.js";
import {
  blob,
  blobOrNull,
  bytesOf,
  countRowsWritten,
  first,
  type GitStorageContext,
  rows,
  run,
} from "./sql.js";
import { promotePendingCommits } from "./sqlite-commit-graph.js";

/** Who moved a ref, recorded in the reflog. */
export interface RefActor {
  readonly principal: string;
  readonly grantId?: string | null;
  readonly tokenId?: string | null;
  readonly onBehalfOf?: string | null;
  /** The agents acting for `principal` (a delegated token's act chain), the current one first. */
  readonly actChain?: readonly string[];
  /** The request that made the change. */
  readonly requestId?: string | null;
  readonly via: "push" | "merge" | "api" | "import";
  /**
   * A maintainer of a pull request's base repository writing its head
   * branch here, as the pull request's author allows: the repository
   * decides in the commit's transaction whether that still holds.
   */
  readonly maintainerFor?: MaintainerFor;
}

/** The pull request a maintainer writes the head branch of. */
export interface MaintainerFor {
  readonly baseRepoId: string;
  readonly number: number;
  readonly generation: number;
}

/** What the in-transaction hooks see. */
export interface CommitContext {
  /** The version being committed (the current version plus one). */
  readonly version: number;
  readonly now: number;
  readonly request: RepoCommitRequest;
  /** The refs the owner's `deriveUpdates` moves with the request's own, old values read in the transaction. */
  readonly derived: readonly RefUpdate[];
}

/**
 * A ref the server moves because the request moves another (a pull
 * request's head ref following its branch). Only names under
 * {@link DERIVED_REF_PREFIX}.
 */
export interface DerivedRefUpdate {
  readonly name: string;
  readonly newOid: Oid;
  /**
   * The request's ref it follows: the move is a fast-forward when that
   * one's is and both refs had the same old value.
   */
  readonly follows: string;
}

/** The only refs `deriveUpdates` may move. */
export const DERIVED_REF_PREFIX = "refs/pull/";

/**
 * A ref commit with the repository's extras. Every field beyond the port's
 * is optional, so a plain `RefCommitRequest` is a valid one.
 */
export interface RepoCommitRequest extends RefCommitRequest {
  /**
   * The upload this commit completes. Its pack unit is added, its pending
   * commit rows are promoted to verified, it is marked committed and its
   * leases are released, all in the same transaction. The upload must be
   * `indexed`, and every pack its connectivity check relied on must still
   * be readable.
   */
  readonly uploadId?: string;
  /**
   * The upload's pack unit was compacted into this pack (which must be in
   * `addPacks`), together with any packs in `removePacks`: the unit is
   * superseded instead of made live. Everything else the upload's commit
   * does is unchanged. Requires `uploadId`.
   */
  readonly uploadUnitMergedInto?: PackId;
  readonly actor?: RefActor;
  /**
   * Refs whose update the caller proved to be a fast-forward (by a commit
   * graph walk before the transaction; the compare-and-set on the old value
   * keeps that proof valid). Any other update of an existing ref, and every
   * deletion, counts as non-fast-forward and bumps `nonff_version`.
   */
  readonly fastForward?: ReadonlySet<string>;
  /**
   * Runs inside the transaction, after the version and ref checks and before
   * any write. Return a message to refuse the commit; nothing is written.
   * This is where the caller re-checks authorization at the commit point
   * (the ACL snapshot is still within its validity window, the commit-time
   * rulesets allow the update) and fences its own lock. It must be
   * synchronous: anything that needs an await runs before the commit.
   */
  readonly authorize?: (context: CommitContext) => string | undefined;
  /**
   * Runs inside the transaction after every write, for rows that must commit
   * with the ref change (outbox events, audit rows, pull request heads). A
   * throw rolls the whole commit back.
   */
  readonly onCommitted?: (context: CommitContext) => void;
}

export type RepoCommitResult =
  | RefCommitResult
  | { readonly ok: false; readonly reason: "refused"; readonly message: string }
  | {
      readonly ok: false;
      readonly reason: "upload-not-ready";
      readonly uploadId: string;
      readonly state: string | null;
    }
  | { readonly ok: false; readonly reason: "dependency-gone"; readonly packId: PackId };

type RefRow = {
  name: string;
  kind: string;
  oid: ArrayBuffer | null;
  target: string | null;
};

type ReflogRow = {
  version: number;
  old_oid: ArrayBuffer | null;
  new_oid: ArrayBuffer | null;
  at: number;
};

type UploadRow = { state: string; pack_id: string | null; deps: string };

const textEncoder = new TextEncoder();

/**
 * Refs, the pack registry's live set and the reflog in Durable Object
 * SQLite. `commitSync` is the single commit point: one `transactionSync`
 * with no await inside, so no other request can run between its checks and
 * its writes, whatever the input gate does.
 */
export class SqliteRefStore implements RefStore {
  /**
   * Called after every successful commit, outside its transaction (for
   * scheduling background work such as maintenance). Must not throw.
   */
  afterCommit: ((commit: { version: number; nonFastForward: boolean }) => void) | undefined;

  /**
   * Runs inside every commit's transaction, after the request's own
   * `onCommitted`: the owner's rows that must commit with any ref change,
   * whichever path made it (events, audit rows). A throw rolls the commit
   * back.
   */
  inCommit: ((context: CommitContext) => void) | undefined;

  /**
   * The owner's derived updates of every commit: refs that move with the
   * request's own, in the same transaction and version, or not at all. Runs
   * after the version check and before the compare-and-set; `readRef` reads
   * inside the transaction. A derived ref already at its new value is left
   * alone; a request that names a derived ref is refused. A throw rolls the
   * commit back.
   */
  deriveUpdates:
    | ((
        updates: readonly RefUpdate[],
        readRef: (name: string) => Oid | null,
      ) => readonly DerivedRefUpdate[])
    | undefined;

  /**
   * The owner's check of every commit, in its transaction before any write,
   * after the request's own `authorize`: a refusal message refuses the
   * commit as that one does (the repository's access control).
   */
  authorizeCommit: ((context: CommitContext) => string | undefined) | undefined;

  /**
   * Runs after `setHead` moved HEAD to another target, in the caller's
   * transaction when there is one (the owner's snapshot of the default
   * branch). A throw undoes the move inside a transaction.
   */
  onHeadChanged: ((target: string) => void) | undefined;

  constructor(
    private readonly context: GitStorageContext,
    private readonly registry: PackRegistry,
  ) {}

  async readRefs(): Promise<RefSnapshot> {
    return this.readRefsSync();
  }

  readRefsSync(): RefSnapshot {
    const { storage } = this.context;
    // One transaction, so the version and the refs are one consistent snapshot.
    return storage.transactionSync(() => {
      const refs = new Map<string, Oid>();
      let head: string | null = null;
      for (const row of rows<RefRow>(
        storage,
        "SELECT name, kind, oid, target FROM refs ORDER BY name",
      )) {
        if (row.kind === "symbolic") {
          if (row.name === "HEAD") head = row.target;
        } else if (row.oid) {
          refs.set(row.name, oidFromBytes(bytesOf(row.oid)));
        }
      }
      return { version: this.#version(), refs, head };
    });
  }

  async readReflog(name: string, limit: number): Promise<readonly ReflogEntry[]> {
    if (!Number.isSafeInteger(limit) || limit < 0)
      throw new RangeError(`bad reflog limit ${limit}`);
    if (limit === 0) return [];
    return rows<ReflogRow>(
      this.context.storage,
      "SELECT version, old_oid, new_oid, at FROM reflog WHERE ref = ? ORDER BY seq DESC LIMIT ?",
      name,
      limit,
    ).map((row) => ({
      version: row.version,
      oldOid: row.old_oid ? oidFromBytes(bytesOf(row.old_oid)) : null,
      newOid: row.new_oid ? oidFromBytes(bytesOf(row.new_oid)) : null,
      at: row.at,
    }));
  }

  /** Where HEAD points (the default branch), or null when it is not set; one row read. */
  head(): string | null {
    return (
      first<{ target: string | null }>(
        this.context.storage,
        "SELECT target FROM refs WHERE name = 'HEAD' AND kind = 'symbolic'",
      )?.target ?? null
    );
  }

  /** Whether the branch or tag `name` (a full ref name) exists; one row read. */
  hasRef(name: string): boolean {
    return (
      first<{ one: number }>(
        this.context.storage,
        "SELECT 1 AS one FROM refs WHERE name = ? AND kind = 'direct'",
        name,
      ) !== undefined
    );
  }

  /** Sets where HEAD points (the default branch). Does not move any ref. */
  setHead(target: string): void {
    checkRefName(target);
    const now = this.context.now();
    const { storage } = this.context;
    const before = this.head();
    const written = run(
      storage,
      `INSERT INTO refs (name, kind, oid, target, version, updated_at)
       VALUES ('HEAD', 'symbolic', NULL, ?, (SELECT version FROM ref_state WHERE id = 1), ?)
       ON CONFLICT (name) DO UPDATE SET target = excluded.target, updated_at = excluded.updated_at`,
      target,
      now,
    );
    countRowsWritten(this.context, "refs.set_head", written);
    if (before !== target) this.onHeadChanged?.(target);
  }

  async commit(request: RefCommitRequest): Promise<RefCommitResult> {
    // Without an upload or hooks, only the port's failure reasons can occur.
    const { addPacks, removePacks, refUpdates, expectedVersion } = request;
    return this.commitSync({
      addPacks,
      removePacks,
      refUpdates,
      expectedVersion,
    }) as RefCommitResult;
  }

  /**
   * Applies every ref update, pack addition and removal, and reflog entry
   * together, or none of them. Throws RangeError for a malformed request.
   */
  commitSync(request: RepoCommitRequest): RepoCommitResult {
    validate(request);
    const { storage } = this.context;
    const outcome = storage.transactionSync(() => {
      const version = this.#version();
      if (request.expectedVersion !== version)
        return { result: { ok: false, reason: "version-conflict", version } as const, written: 0 };

      const readRef = (name: string): Oid | null => {
        const row = first<RefRow>(
          storage,
          "SELECT name, kind, oid, target FROM refs WHERE name = ?",
          name,
        );
        return row?.oid ? oidFromBytes(bytesOf(row.oid)) : null;
      };
      const derivation = this.#derive(request, readRef);
      if (typeof derivation === "string")
        return {
          result: { ok: false, reason: "refused", message: derivation } as const,
          written: 0,
        };
      const { derived, follows } = derivation;

      const current = new Map<string, Oid | null>();
      for (const { name, oldOid } of request.refUpdates) {
        const currentOid = readRef(name);
        if (!sameOid(currentOid, oldOid))
          return { result: { ok: false, reason: "ref-conflict", ref: name } as const, written: 0 };
        current.set(name, currentOid);
      }
      const updates = [...request.refUpdates, ...derived];
      const [collision] = refnameConflicts(updates, this.#namespace());
      if (collision) {
        const { ref, conflictsWith } = collision;
        return {
          result: { ok: false, reason: "refname-conflict", ref, conflictsWith } as const,
          written: 0,
        };
      }

      const adding: PackRow[] = [];
      /** The upload's unit, when it was compacted into an added pack. */
      const absorbed: PackRow[] = [];
      let rescue: PackId[] = [];
      if (request.uploadId !== undefined) {
        const upload = first<UploadRow>(
          storage,
          "SELECT state, pack_id, deps FROM uploads WHERE upload_id = ?",
          request.uploadId,
        );
        if (upload?.state !== "indexed") {
          return {
            result: {
              ok: false,
              reason: "upload-not-ready",
              uploadId: request.uploadId,
              state: upload?.state ?? null,
            } as const,
            written: 0,
          };
        }
        for (const dep of JSON.parse(upload.deps) as PackId[]) {
          const state = this.registry.get(dep)?.state;
          if (state === "garbage") rescue.push(dep);
          else if (state !== "live")
            return {
              result: { ok: false, reason: "dependency-gone", packId: dep } as const,
              written: 0,
            };
        }
        const pack = upload.pack_id === null ? undefined : this.registry.get(upload.pack_id);
        if (pack) {
          for (const member of unitMembers(this.registry, pack)) {
            if (member.state !== "indexed")
              return {
                result: { ok: false, reason: "unknown-pack", packId: member.packId } as const,
                written: 0,
              };
            if (request.uploadUnitMergedInto === undefined) adding.push(member);
            else absorbed.push(member);
          }
        }
      }
      for (const packId of request.addPacks) {
        const pack = this.registry.get(packId);
        if (!pack || !FINISHED_STATES.includes(pack.state))
          return { result: { ok: false, reason: "unknown-pack", packId } as const, written: 0 };
        checkWholeUnit(unitMembers(this.registry, pack), request.addPacks, packId);
        if (!adding.some((p) => p.packId === packId)) adding.push(pack);
      }
      for (const packId of request.removePacks) {
        const pack = this.registry.get(packId);
        if (pack?.state !== "live")
          return { result: { ok: false, reason: "unknown-pack", packId } as const, written: 0 };
        checkWholeUnit(unitMembers(this.registry, pack), request.removePacks, packId);
      }
      rescue = rescue.filter((id) => !request.removePacks.includes(id));

      const next = version + 1;
      const now = this.context.now();
      const context: CommitContext = { version: next, now, request, derived };
      const refusal = request.authorize?.(context) ?? this.authorizeCommit?.(context);
      if (refusal !== undefined)
        return { result: { ok: false, reason: "refused", message: refusal } as const, written: 0 };

      let written = 0;
      let nonFastForward = false;
      const actor = request.actor;
      for (const { name, newOid, oldOid: derivedOld } of updates) {
        const source = follows.get(name);
        const oldOid = source === undefined ? (current.get(name) ?? null) : derivedOld;
        const fastForward =
          source === undefined
            ? request.fastForward?.has(name) === true
            : request.fastForward?.has(source) === true &&
              sameOid(oldOid, current.get(source) ?? null);
        if (oldOid !== null && (newOid === null || !fastForward)) nonFastForward = true;
        written +=
          newOid === null
            ? run(storage, "DELETE FROM refs WHERE name = ?", name)
            : run(
                storage,
                `INSERT INTO refs (name, kind, oid, peeled_oid, target, version, updated_at)
                 VALUES (?, 'direct', ?, NULL, NULL, ?, ?)
                 ON CONFLICT (name) DO UPDATE SET oid = excluded.oid, peeled_oid = NULL,
                   version = excluded.version, updated_at = excluded.updated_at`,
                name,
                blob(newOid),
                next,
                now,
              );
        written += run(
          storage,
          `INSERT INTO reflog (ref, version, old_oid, new_oid, actor, on_behalf_of, grant_id,
             token_id, via, upload_id, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          name,
          next,
          blobOrNull(oldOid),
          blobOrNull(newOid),
          actor?.principal ?? null,
          actor?.onBehalfOf ?? null,
          actor?.grantId ?? null,
          actor?.tokenId ?? null,
          actor?.via ?? null,
          request.uploadId ?? null,
          now,
        );
      }
      for (const pack of adding) {
        written += this.registry.transition(pack.packId, FINISHED_STATES, "live");
      }
      // Pack units were checked to be named whole.
      for (const packId of request.removePacks) {
        written += this.registry.transition(packId, ["live"], "superseded");
      }
      for (const pack of absorbed) {
        written += this.registry.transition(pack.packId, FINISHED_STATES, "superseded");
      }
      for (const packId of rescue) {
        written += this.registry.transition(packId, ["garbage"], "live");
        written += run(storage, "UPDATE packs SET all_reachable = 0 WHERE pack_id = ?", packId);
      }
      if (nonFastForward) {
        // Objects may have become unreachable: no pack is known all-reachable any more.
        written += run(storage, "UPDATE packs SET all_reachable = 0 WHERE all_reachable = 1");
      }
      if (request.uploadId !== undefined) {
        written += promotePendingCommits(this.context, request.uploadId);
        written += run(
          storage,
          "UPDATE uploads SET state = 'committed' WHERE upload_id = ?",
          request.uploadId,
        );
        written += run(storage, "DELETE FROM leases WHERE holder = ?", request.uploadId);
      }
      written += run(
        storage,
        `UPDATE ref_state SET version = ?, nonff_version = nonff_version + ?, updated_at = ?
         WHERE id = 1`,
        next,
        nonFastForward ? 1 : 0,
        now,
      );
      request.onCommitted?.(context);
      this.inCommit?.(context);
      return { result: { ok: true, version: next } as const, written, nonFastForward };
    });
    countRowsWritten(this.context, "refs.commit", outcome.written);
    if (outcome.result.ok)
      this.afterCommit?.({
        version: outcome.result.version,
        nonFastForward: "nonFastForward" in outcome && outcome.nonFastForward === true,
      });
    return outcome.result;
  }

  /**
   * The owner's derived updates of `request`, with old values read now, and
   * the request's ref each follows; or a refusal when the request names one
   * of them itself.
   */
  #derive(
    request: RepoCommitRequest,
    readRef: (name: string) => Oid | null,
  ): { derived: RefUpdate[]; follows: Map<string, string> } | string {
    const derived: RefUpdate[] = [];
    const follows = new Map<string, string>();
    if (!this.deriveUpdates) return { derived, follows };
    const named = new Set(request.refUpdates.map((u) => u.name));
    for (const update of this.deriveUpdates(request.refUpdates, readRef)) {
      if (!update.name.startsWith(DERIVED_REF_PREFIX)) {
        throw new RangeError(
          `a derived update may only move ${DERIVED_REF_PREFIX} refs, not ${update.name}`,
        );
      }
      checkRefName(update.name);
      if (named.has(update.name)) return `${update.name} is moved by the server only`;
      if (follows.has(update.name)) throw new RangeError(`ref ${update.name} is derived twice`);
      if (!named.has(update.follows))
        throw new RangeError(
          `${update.name} follows ${update.follows}, which the request does not move`,
        );
      follows.set(update.name, update.follows);
      const oldOid = readRef(update.name);
      if (!sameOid(oldOid, update.newOid))
        derived.push({ name: update.name, oldOid, newOid: update.newOid });
    }
    return { derived, follows };
  }

  /** The current `ref_state` (version and non-fast-forward version). */
  state(): { version: number; nonffVersion: number } {
    const row = first<{ version: number; nonff_version: number }>(
      this.context.storage,
      "SELECT version, nonff_version FROM ref_state WHERE id = 1",
    );
    if (!row) throw new Error("ref_state is missing: the git storage migration has not run");
    return { version: row.version, nonffVersion: row.nonff_version };
  }

  /** Direct refs as the namespace check reads them (index lookups and range scans on the name). */
  #namespace(): RefNamespace {
    const { storage } = this.context;
    return {
      has: (name) =>
        first<{ name: string }>(
          storage,
          "SELECT name FROM refs WHERE name = ? AND kind = 'direct'",
          name,
        ) !== undefined,
      // "/" is 0x2F and "0" is 0x30: the names below `name/` sort between the two bounds.
      below: (name, limit) =>
        rows<{ name: string }>(
          storage,
          "SELECT name FROM refs WHERE name >= ? AND name < ? AND kind = 'direct' LIMIT ?",
          `${name}/`,
          `${name}0`,
          limit,
        ).map((row) => row.name),
    };
  }

  #version(): number {
    return this.state().version;
  }
}

function sameOid(a: Oid | null, b: Oid | null): boolean {
  return a === null || b === null ? a === b : oidEquals(a, b);
}

function checkRefName(name: string): void {
  // Only refs under refs/ move through commits; HEAD is symbolic and set by setHead.
  if (!name.startsWith("refs/") || !isValidRefname(textEncoder.encode(name)))
    throw new RangeError(`invalid ref name: ${name}`);
}

/**
 * States of a pack-unit row that is not part of the unit: an attempt never
 * written (an empty pack) or replaced by a later attempt, and its row once
 * the reaper removed its bytes. Only the upload's own writers discard a
 * member of an upload that reached `indexed`.
 */
const NOT_IN_UNIT: readonly PackState[] = ["discarded", "deleted"];

/** The packs that make up `pack`'s unit: the ones committed, superseded and compacted together. */
function unitMembers(registry: PackRegistry, pack: PackRow): PackRow[] {
  return registry.unitOf(pack).filter((member) => !NOT_IN_UNIT.includes(member.state));
}

function checkWholeUnit(unit: readonly PackRow[], named: readonly PackId[], packId: PackId): void {
  if (unit.some((member) => !named.includes(member.packId)))
    throw new RangeError(`pack ${packId} belongs to a pack unit that must be named whole`);
}

function validate(request: RepoCommitRequest): void {
  if (!Number.isSafeInteger(request.expectedVersion) || request.expectedVersion < 0)
    throw new RangeError(`bad expected version ${request.expectedVersion}`);
  const names = new Set<string>();
  for (const update of request.refUpdates as readonly RefUpdate[]) {
    checkRefName(update.name);
    if (names.has(update.name)) throw new RangeError(`ref ${update.name} is updated twice`);
    names.add(update.name);
  }
  const packs = [...request.addPacks, ...request.removePacks];
  if (new Set(packs).size !== packs.length) throw new RangeError("a pack is named twice");
  const mergedInto = request.uploadUnitMergedInto;
  if (mergedInto !== undefined) {
    if (request.uploadId === undefined)
      throw new RangeError("a merged upload unit needs the upload");
    if (!request.addPacks.includes(mergedInto))
      throw new RangeError(`pack ${mergedInto} the upload was merged into is not added`);
  }
}
