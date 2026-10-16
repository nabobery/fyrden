import {
  type Job,
  type JobHandler,
  LOCK_REF_COMMIT,
  type LockHandle,
  type RepoGitStorage,
  type SliceResult,
  schedulePackRetire,
} from "@fyrden/adapters-cloudflare/git";
import type { Logger } from "@fyrden/adapters-cloudflare/obs";
import {
  BitSet,
  type BlockCache,
  MissingObjectError,
  type Oid,
  oidFromBytes,
  type PackId,
} from "@fyrden/git-core";
import { newRunId } from "../git/maintenance/ids.js";
import { decodeBitSets, encodeBitSets, MarkSession, markName } from "../git/maintenance/mark.js";
import type { MaintenancePolicy } from "../git/maintenance/policy.js";
import { type RewriteState, rewriteSlice } from "../git/maintenance/rewrite.js";
import {
  type CallCounter,
  decodeJson,
  deleteRun,
  discardOutput,
  encodeJson,
  getScratch,
  LoadedPacks,
  putScratch,
} from "../git/maintenance/storage.js";

/*
 * Detach: a repository leaves its fork network by
 * rewriting its reachable closure into packs of its own under a new
 * network, never by copying shared packs (a shared pack holds other
 * members' objects, private ones included). As one resumable job:
 *
 * 1. Mark, from the refs, every object reachable through the current view,
 *    one bit set per pack.
 * 2. Write the marked objects that only packs of the old network hold into
 *    a new pack under the new network (an object some pack of the new
 *    network already holds, written by a push since the detach began or by
 *    an earlier round, is not copied again).
 * 3. Verify, slice by slice within the slice budget, that the new
 *    network's packs hold the whole closure (a mark through them alone);
 *    then list, again slice by slice, the commit-graph rows of commits they
 *    do not hold (they leave with the old network) into scratch objects.
 * 4. Swap, under the commit lock (a write freeze: pushes wait, then are
 *    refused as busy): if the refs moved since the mark, or a pack of the
 *    mark was replaced, run another round (a catch-up: only objects not yet
 *    in the new network are written); after a few rounds the freeze is kept
 *    across the catch-up so it ends. Otherwise, in one transaction (which
 *    checks the lock and the refs again): the outputs go live, every pack
 *    of the old network leaves the view (superseded; the retire job
 *    releases the network's claims or deletes unshared bytes after the
 *    retention), the commit graph keeps only commits the new packs hold,
 *    and the job's cursor moves to the next step, so a replay after any
 *    failure from here on never swaps again.
 * 5. Clean up the run's scratch objects and leases, and tell the networks
 *    (the old one: detached; the new one: its root) and the directory,
 *    retried until done; every part of it is safe to repeat.
 *
 * Packs pushed while the job runs go to the new network already (the
 * repository's network id changed when the detach began).
 */

export const DETACH_JOB_ID = "detach";
/** Rounds before the swap keeps the write freeze across a catch-up. Proposed. */
const FREEZE_AFTER_ROUNDS = 3;
/** How long the freeze (the commit lock) is held without renewal. Proposed. */
const FREEZE_MS = 10 * 60 * 1000;
const SWAP_LOCK_MS = 30_000;
const BUSY_RETRY_MS = 5_000;

interface Source {
  readonly id: PackId;
  readonly count: number;
  /** Stored under the network being left. */
  readonly old: boolean;
}

export interface DetachCursor {
  readonly v: 1;
  readonly runId: string;
  readonly phase: "mark" | "write" | "verify" | "prune" | "swap" | "notify";
  readonly oldNetworkId: string;
  readonly newNetworkId: string;
  readonly round: number;
  readonly version: number;
  readonly sources: readonly Source[];
  readonly seq: number;
  /** Finished outputs of earlier rounds and this one (new network, waiting for the swap). */
  readonly outputs: readonly PackId[];
  readonly rewrite?: RewriteState | undefined;
  /** The write freeze kept across slices in the last rounds. */
  readonly freeze?: LockHandle | undefined;
  /** Verify: the checkpoint the closure mark continues from (0: not started). */
  readonly check?: number | undefined;
  /** Prune: the last commit-graph row scanned (hex), and the scratch objects listing rows to drop. */
  readonly after?: string | undefined;
  readonly drops?: number | undefined;
}

export interface DetachHooks {
  /** At the start of each slice, with its cursor. For tests. */
  readonly onSlice?: (cursor: DetachCursor) => Promise<void> | void;
  /** Right after the swap transaction committed; throwing fails the slice. For tests. */
  readonly afterSwap?: () => Promise<void> | void;
}

export interface DetachWiring {
  readonly policy: () => MaintenancePolicy;
  readonly log: Logger;
  readonly blocks?: () => BlockCache;
  readonly hooks?: () => DetachHooks;
  /** After the swap: tell both networks and the directory. Throws to be retried. */
  readonly notify: (oldNetworkId: string, newNetworkId: string) => Promise<void>;
}

const MARK = "dmark";
const BITS = "dbits";
const KEEP = "dkeep";
const VERIFY = "dverify";
const DROP = "ddrop";
/** Commit-graph rows read per query while pruning. */
const PRUNE_PAGE = 1_000;
const OID_BYTES = 20;

/** Starts a detach into `newNetworkId`; new packs go there from now on. */
export function beginDetach(
  git: RepoGitStorage,
  newNetworkId: string,
): { ok: true } | { ok: false; error: string } {
  const job = git.jobs.get(DETACH_JOB_ID);
  if (job && (job.state === "queued" || job.state === "running"))
    return { ok: false, error: "a detach is already running" };
  const oldNetworkId = git.networkId();
  if (oldNetworkId === newNetworkId) return { ok: false, error: "already in that network" };
  const cursor: DetachCursor = {
    v: 1,
    runId: newRunId(git),
    phase: "mark",
    oldNetworkId,
    newNetworkId,
    round: 0,
    version: -1,
    sources: [],
    seq: 0,
    outputs: [],
  };
  git.context.storage.transactionSync(() => {
    git.initialize(newNetworkId);
    git.jobs.ensure("detach", DETACH_JOB_ID, { cursor: encodeJson(cursor) });
  });
  return { ok: true };
}

export function detachHandler(git: RepoGitStorage, wiring: DetachWiring): JobHandler {
  return {
    runSlice: async (job) => {
      const cursor = decodeJson<DetachCursor>(job.cursor);
      if (cursor?.v !== 1) return { done: true };
      await wiring.hooks?.().onSlice?.(cursor);
      return new DetachSlice(git, wiring, wiring.blocks?.()).run(job, cursor);
    },
  };
}

class DetachSlice {
  readonly counter: CallCounter = { calls: 0 };
  readonly policy: MaintenancePolicy;
  readonly deadline: number;

  constructor(
    readonly git: RepoGitStorage,
    readonly wiring: DetachWiring,
    readonly blocks: BlockCache | undefined,
  ) {
    this.policy = wiring.policy();
    this.deadline = git.context.now() + this.policy.sliceMs;
  }

  #context(runId: string) {
    return {
      git: this.git,
      policy: this.policy,
      runId,
      counter: this.counter,
      ...(this.blocks ? { blocks: this.blocks } : {}),
      deadline: this.deadline,
    };
  }

  async run(job: Job, cursor: DetachCursor): Promise<SliceResult> {
    switch (cursor.phase) {
      case "mark":
        return cursor.version < 0 ? this.#newRound(cursor) : this.#mark(cursor);
      case "write":
        return this.#write(cursor);
      case "verify":
        return this.#verify(cursor);
      case "prune":
        return this.#prune(cursor);
      case "swap":
        return this.#swap(job, cursor);
      case "notify":
        // Everything after the swap, each part idempotent (a replay repeats it).
        this.git.leases.releaseHolder(DETACH_JOB_ID);
        await deleteRun(this.git, cursor.runId);
        schedulePackRetire(this.git.jobs, this.git.context.now());
        await this.wiring.notify(cursor.oldNetworkId, cursor.newNetworkId);
        this.wiring.log.info("repository detached", {
          oldNetworkId: cursor.oldNetworkId,
          newNetworkId: cursor.newNetworkId,
          rounds: cursor.round,
        });
        return { done: true };
    }
  }

  /** A round's snapshot: the refs' version and every live pack, then the mark from the refs. */
  #newRound(cursor: DetachCursor): Promise<SliceResult> {
    const { git } = this;
    const sources = git.context.storage.sql
      .exec<{ pack_id: string; network_id: string; object_count: number | null }>(
        `SELECT pack_id, network_id, object_count FROM packs
         WHERE state = 'live' AND bytes IS NOT NULL ORDER BY created_at DESC, pack_id DESC`,
      )
      .toArray()
      .map((r) => ({
        id: r.pack_id as PackId,
        count: r.object_count ?? -1,
        old: r.network_id !== cursor.newNetworkId,
      }));
    const refs = git.refStore.readRefsSync();
    const next: DetachCursor = {
      ...cursor,
      round: cursor.round + 1,
      version: refs.version,
      sources,
      seq: 0,
      rewrite: undefined,
      check: undefined,
      after: undefined,
      drops: undefined,
    };
    return this.#mark(next, [...refs.refs.values()]);
  }

  #readable(cursor: DetachCursor): boolean {
    return cursor.sources.every((s) => this.git.registry.get(s.id)?.state === "live");
  }

  async #mark(cursor: DetachCursor, roots?: readonly Oid[]): Promise<SliceResult> {
    const { git } = this;
    if (!this.#readable(cursor)) return this.#restartRound(cursor);
    if (cursor.sources.length === 0) return this.#next({ ...cursor, phase: "verify" });
    const session = await MarkSession.open(
      this.#context(cursor.runId),
      cursor.sources.map((s) => s.id),
      { outside: "error", ...(cursor.seq > 0 ? { from: markName(MARK, cursor.seq) } : {}) },
    );
    try {
      if (roots) session.mark.push(roots);
      const next: DetachCursor = { ...cursor, seq: cursor.seq + 1 };
      if (!(await session.run())) {
        await session.save(markName(MARK, next.seq));
        return this.#next(next);
      }
      const counts = session.sources.map((p) => p.idx.count);
      const sources = cursor.sources.map((s, i) => ({ ...s, count: counts[i] as number }));
      await putScratch(git, cursor.runId, BITS, encodeBitSets(session.bits), this.counter);
      const keep = await this.#keep(sources, cursor.outputs, session.bits);
      await putScratch(git, cursor.runId, KEEP, encodeBitSets(keep), this.counter);
      const kept = keep.reduce((n, b) => n + b.count(), 0);
      return this.#next({ ...next, sources, phase: kept > 0 ? "write" : "verify" });
    } finally {
      session.release();
    }
  }

  /**
   * Per source, what to write: for a pack of the old network, the marked
   * objects no pack of the new network (nor an earlier output) holds; for
   * a pack of the new network, nothing.
   */
  async #keep(
    sources: readonly Source[],
    outputs: readonly PackId[],
    bits: readonly BitSet[],
  ): Promise<BitSet[]> {
    const inNew = [...sources.filter((s) => !s.old).map((s) => s.id), ...outputs];
    const loaded = await LoadedPacks.load(this.git, inNew, this.counter);
    const all = await LoadedPacks.load(
      this.git,
      sources.map((s) => s.id),
      this.counter,
    );
    try {
      return sources.map((source, i) => {
        const keep = new BitSet(source.count);
        if (!source.old) return keep;
        const idx = (all.packs[i] as (typeof all.packs)[number]).idx;
        for (const p of (bits[i] as BitSet).indices()) {
          const oid = idx.oidAt(p);
          if (!loaded.packs.some((pack) => pack.idx.find(oid) >= 0)) keep.set(p);
        }
        return keep;
      });
    } finally {
      loaded.release();
      all.release();
    }
  }

  async #write(cursor: DetachCursor): Promise<SliceResult> {
    const { git } = this;
    if (!this.#readable(cursor)) return this.#restartRound(cursor);
    const old = cursor.sources.map((s, i) => ({ s, i })).filter(({ s }) => s.old);
    const keep = decodeBitSets(
      await getScratch(git, cursor.runId, KEEP, this.counter),
      cursor.sources.map((s) => s.count),
    );
    const outcome = await rewriteSlice(
      { ...this.#context(cursor.runId), holder: DETACH_JOB_ID },
      {
        kind: "compact",
        sources: old.map(({ s }) => s.id),
        keep: old.map(({ i }) => keep[i] as BitSet),
      },
      cursor.rewrite,
    );
    if (!outcome.done) return this.#next({ ...cursor, rewrite: outcome.state });
    const kept = old.reduce((n, { i }) => n + (keep[i] as BitSet).count(), 0);
    if (outcome.objectCount > kept)
      throw new Error(`detach output ${outcome.packId} holds more objects than the closure`);
    return this.#next({
      ...cursor,
      phase: "verify",
      rewrite: undefined,
      outputs: [...cursor.outputs, outcome.packId],
    });
  }

  /** The packs the repository keeps: the new network's sources and the outputs. */
  #newPacks(cursor: DetachCursor): PackId[] {
    return [...cursor.sources.filter((s) => !s.old).map((s) => s.id), ...cursor.outputs];
  }

  /** Whether the refs moved or a pack of the mark was replaced: the swap starts another round. */
  #moved(cursor: DetachCursor): boolean {
    return this.git.refStore.state().version !== cursor.version || !this.#readable(cursor);
  }

  /**
   * One slice of the check that the new network's packs alone hold
   * everything the refs reach (a mark through them that finds nothing
   * missing), saved to scratch when the slice's budget runs out.
   */
  async #verify(cursor: DetachCursor): Promise<SliceResult> {
    const { git } = this;
    if (this.#moved(cursor)) return this.#next({ ...cursor, phase: "swap" });
    const check = cursor.check ?? 0;
    const prune: DetachCursor = { ...cursor, phase: "prune", after: undefined, drops: 0 };
    const refs = [...git.refStore.readRefsSync().refs.values()];
    if (refs.length === 0) return this.#next(prune);
    const packs = this.#newPacks(cursor);
    if (packs.length === 0) return this.#closureMissing(cursor);
    let session: MarkSession | undefined;
    try {
      session = await MarkSession.open(this.#context(cursor.runId), packs, {
        outside: "error",
        ...(check > 0 ? { from: markName(VERIFY, check) } : {}),
      });
      if (check === 0) session.mark.push(refs);
      if (!(await session.run())) {
        await session.save(markName(VERIFY, check + 1));
        return this.#next({ ...cursor, check: check + 1 });
      }
    } catch (error) {
      if (error instanceof MissingObjectError) return this.#closureMissing(cursor);
      throw error;
    } finally {
      session?.release();
    }
    return this.#next(prune);
  }

  async #closureMissing(cursor: DetachCursor): Promise<SliceResult> {
    this.wiring.log.warn("detach outputs miss part of the closure; marking again");
    if (cursor.freeze) this.git.locks.release(cursor.freeze);
    await deleteRun(this.git, cursor.runId);
    return this.#next(this.#round(cursor, undefined));
  }

  /**
   * One slice of listing the commit-graph rows of commits none of the new
   * network's packs holds (they leave with the old network): at most the
   * slice's object budget of rows, saved as one scratch object per slice.
   */
  async #prune(cursor: DetachCursor): Promise<SliceResult> {
    const { git, policy } = this;
    if (this.#moved(cursor)) return this.#next({ ...cursor, phase: "swap" });
    const loaded = await LoadedPacks.load(git, this.#newPacks(cursor), this.counter);
    const drop: Uint8Array[] = [];
    let after = cursor.after ? hexBytes(cursor.after) : new Uint8Array(0);
    let scanned = 0;
    let done = false;
    try {
      while (scanned < policy.sliceObjects && git.context.now() < this.deadline) {
        const page = git.context.storage.sql
          .exec<{ oid: ArrayBuffer }>(
            "SELECT oid FROM commits WHERE oid > ? ORDER BY oid LIMIT ?",
            after.slice().buffer,
            Math.min(PRUNE_PAGE, policy.sliceObjects - scanned),
          )
          .toArray();
        if (page.length === 0) {
          done = true;
          break;
        }
        for (const row of page) {
          const oid = oidFromBytes(new Uint8Array(row.oid));
          if (!loaded.packs.some((p) => p.idx.find(oid) >= 0)) drop.push(new Uint8Array(row.oid));
        }
        scanned += page.length;
        after = new Uint8Array((page[page.length - 1] as { oid: ArrayBuffer }).oid);
      }
    } finally {
      loaded.release();
    }
    let drops = cursor.drops ?? 0;
    if (drop.length > 0) {
      drops++;
      const bytes = new Uint8Array(drop.length * OID_BYTES);
      drop.forEach((oid, i) => {
        bytes.set(oid, i * OID_BYTES);
      });
      await putScratch(git, cursor.runId, markName(DROP, drops), bytes, this.counter);
    }
    return this.#next(
      done
        ? { ...cursor, phase: "swap", after: undefined, drops }
        : { ...cursor, after: bytesHex(after), drops },
    );
  }

  async #swap(job: Job, cursor: DetachCursor): Promise<SliceResult> {
    const { git } = this;
    let lock = cursor.freeze ? git.locks.renew(cursor.freeze, FREEZE_MS) : undefined;
    lock ??= git.locks.tryAcquire(LOCK_REF_COMMIT, DETACH_JOB_ID, SWAP_LOCK_MS);
    if (!lock) return { done: false, cursor: encodeJson(cursor), runAfterMs: BUSY_RETRY_MS };
    let keepLock = false;
    try {
      if (this.#moved(cursor)) {
        // Refs moved or packs were replaced: catch up in another round.
        const freeze =
          cursor.round >= FREEZE_AFTER_ROUNDS ? git.locks.renew(lock, FREEZE_MS) : undefined;
        keepLock = freeze !== undefined;
        await deleteRun(git, cursor.runId);
        return this.#next(this.#round(cursor, freeze));
      }
      if (this.#uploadInOldNetwork(cursor))
        return { done: false, cursor: encodeJson(cursor), runAfterMs: BUSY_RETRY_MS };
      const dropCommits: ArrayBuffer[] = [];
      for (let n = 1; n <= (cursor.drops ?? 0); n++) {
        const bytes = await getScratch(git, cursor.runId, markName(DROP, n), this.counter);
        for (let at = 0; at + OID_BYTES <= bytes.length; at += OID_BYTES)
          dropCommits.push(bytes.slice(at, at + OID_BYTES).buffer);
      }
      const notify: DetachCursor = {
        ...cursor,
        phase: "notify",
        freeze: undefined,
        check: undefined,
        after: undefined,
        drops: undefined,
      };
      if (!this.#commit(job, cursor, notify, lock, dropCommits)) {
        // The lock lapsed while the dropped rows were read: look again.
        return { done: false, cursor: encodeJson(cursor), runAfterMs: 0 };
      }
      git.context.metrics.count("git.maintenance", { job: "detach", what: "swapped" }, 1);
      await this.wiring.hooks?.().afterSwap?.();
      return this.#next(notify);
    } finally {
      if (!keepLock) git.locks.release(lock);
    }
  }

  /** The cursor of another round (a catch-up), keeping the outputs written so far. */
  #round(cursor: DetachCursor, freeze: LockHandle | undefined): DetachCursor {
    return {
      ...cursor,
      phase: "mark",
      version: -1,
      rewrite: undefined,
      freeze,
      check: undefined,
      after: undefined,
      drops: undefined,
    };
  }

  /** An upload not yet committed whose packs are stored under the old network: wait for it to end. */
  #uploadInOldNetwork(cursor: DetachCursor): boolean {
    return (
      this.git.context.storage.sql
        .exec(
          `SELECT 1 AS one FROM uploads u JOIN packs p ON p.upload_id = u.upload_id
           WHERE u.state IN ('open', 'indexing', 'indexed') AND p.network_id = ? LIMIT 1`,
          cursor.oldNetworkId,
        )
        .toArray().length > 0
    );
  }

  /**
   * The swap transaction, with the job's next cursor (`notify`): false,
   * changing nothing, when the lock lapsed or the refs moved since the
   * mark (an await in between). Throws, rolling back, when this run lost
   * the job to another.
   */
  #commit(
    job: Job,
    cursor: DetachCursor,
    notify: DetachCursor,
    lock: LockHandle,
    dropCommits: readonly ArrayBuffer[],
  ): boolean {
    const { git } = this;
    const { storage } = git.context;
    return storage.transactionSync(() => {
      if (!git.locks.isHeld(lock) || git.refStore.state().version !== cursor.version) return false;
      for (const output of cursor.outputs)
        if (git.registry.transition(output, ["indexing"], "live") === 0)
          throw new Error(`detach output ${output} is not finished`);
      const now = git.context.now();
      storage.sql
        .exec(
          `UPDATE packs SET state = 'superseded', superseded_at = ?, last_touched_at = ?
           WHERE network_id = ? AND state IN ('live', 'garbage')`,
          now,
          now,
          cursor.oldNetworkId,
        )
        .toArray();
      // The view compaction's merges were of the old network's packs: none is read any more.
      storage.sql.exec("DELETE FROM view_merged");
      for (const oid of dropCommits)
        storage.sql.exec("DELETE FROM commits WHERE oid = ?", oid).toArray();
      if (!git.jobs.checkpoint(job, encodeJson(notify)))
        throw new Error("the detach job was taken over during its swap");
      return true;
    });
  }

  async #restartRound(cursor: DetachCursor): Promise<SliceResult> {
    if (cursor.rewrite) await discardOutput(this.git, cursor.rewrite.packId);
    await deleteRun(this.git, cursor.runId);
    return this.#next(this.#round(cursor, cursor.freeze));
  }

  #next(cursor: DetachCursor): SliceResult {
    return { done: false, cursor: encodeJson(cursor), runAfterMs: 0 };
  }
}

const hexBytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
const bytesHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
