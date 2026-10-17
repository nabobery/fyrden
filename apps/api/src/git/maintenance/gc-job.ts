import type { Job, JobHandler, RepoGitStorage, SliceResult } from "@fyrden/adapters-cloudflare/git";
import type { Logger } from "@fyrden/adapters-cloudflare/obs";
import {
  type BitSet,
  type BlockCache,
  MissingObjectError,
  type Oid,
  oidFromBytes,
  type PackId,
} from "@fyrden/git-core";
import { type GcSwapPlan, gcSwap } from "./gc-swap.js";
import { newRunId } from "./ids.js";
import { decodeBitSets, encodeBitSets, MarkSession, markName } from "./mark.js";
import type { MaintenancePolicy } from "./policy.js";
import { type RewriteState, releaseOutputLease, rewriteSlice } from "./rewrite.js";
import { GC_JOB_ID } from "./schedule.js";
import {
  type CallCounter,
  decodeJson,
  deleteRun,
  discardOutput,
  encodeJson,
  getScratch,
  putScratch,
  swapped,
} from "./storage.js";

/*
 * Garbage collection of one repository, as resumable alarm
 * slices:
 *
 * 1. Snapshot: the live packs and garbage packs are the sources (borrowed
 *    ones too: a fork network's packs this repository reads); the roots
 *    are the refs, then the reflog entries within the retention and the
 *    further roots the repository names (its pull requests' recorded bases).
 * 2. Mark: every object reachable from the refs, then from the reflog, in
 *    one bit set per source (the refs-only marks are kept: they decide
 *    which packs are all-reachable).
 * 3. Decide: a live pack fully marked is left alone; one with unmarked
 *    objects is split into its reachable objects (into one new `gc` pack)
 *    and its unreachable ones (into one `garbage` pack per run, so a
 *    rescued object's closure is in that pack or in live packs). Objects of
 *    garbage packs found reachable again are copied into the `gc` pack and
 *    the garbage pack is touched. Borrowed packs are marked (so objects of
 *    own packs reached only through them are found) but never rewritten:
 *    their bytes are the network's. A borrowed pack nothing reaches leaves
 *    the view as garbage, comes back if something reaches it again, and is
 *    condemned after the garbage time to live (its claim is then released
 *    to the network, see pack-retire.ts).
 * 4. Write the outputs (resumable, see rewrite.ts).
 * 5. Swap, under the commit lock, after a final walk from refs that moved
 *    during the run (which restarts the decision if it finds an object the
 *    run was about to treat as garbage): the outputs go in, the split packs
 *    are superseded, garbage packs past their time to live since their last
 *    touch with nothing reachable are condemned, and packs every object of
 *    which the refs reach are flagged all-reachable.
 *
 * Physical deletion is the retire job's (30 days after, see pack-retire.ts).
 */

interface Output {
  readonly packId: PackId;
  readonly objects: number;
  readonly bytes: number;
}

export interface GcCursor {
  readonly v: 1;
  readonly runId: string;
  readonly phase: "mark-refs" | "mark-all" | "write-gc" | "write-garbage" | "swap";
  readonly version: number;
  readonly nonff: number;
  /** Largest reflog sequence at the snapshot: later entries are refs that moved during the run. */
  readonly reflogSeq: number;
  readonly sources: readonly {
    readonly id: PackId;
    readonly garbage: boolean;
    readonly count: number;
    /** A fork network's pack: marked, never rewritten. */
    readonly borrowed?: boolean;
  }[];
  /** The mark checkpoint (`mark-<seq>`); 0 before the first save. */
  readonly seq: number;
  /** Roots marked after the refs: the reflog's and the further ones the repository names. */
  readonly reflogRoots: number;
  /** Indexes into `sources`: what the `gc` output keeps (reachable objects). */
  readonly gcSources?: readonly number[];
  /** Indexes into `sources`: live packs split (their unreachable objects go to the garbage output). */
  readonly splitSources?: readonly number[];
  readonly gcRewrite?: RewriteState | undefined;
  readonly gcOutput?: Output | undefined;
  readonly garbageRewrite?: RewriteState | undefined;
  readonly garbageOutput?: Output | undefined;
  readonly waitingSince?: number;
}

const ALL_BITS = "bits";
const REFS_BITS = "refs";
const REFLOG_ROOTS = "reflog-roots";
const MARK = "mark";

export interface GcHooks {
  /** Called with the cursor at the start of each slice. For tests. */
  readonly onSlice?: (cursor: GcCursor | undefined) => Promise<void> | void;
  /** In the swap, after the catch-up walk and before the swap is prepared (R2 reads follow). For tests. */
  readonly afterCatchUp?: () => Promise<void> | void;
}

export function gcHandler(
  git: RepoGitStorage,
  policy: () => MaintenancePolicy,
  log: Logger,
  blocks?: () => BlockCache,
  hooks: GcHooks = {},
  /** Further roots, walked with the reflog's. */
  roots: () => readonly Oid[] = () => [],
): JobHandler {
  return {
    runSlice: async (job) => {
      const cursor = decodeJson<GcCursor>(job.cursor);
      await hooks.onSlice?.(cursor?.v === 1 ? cursor : undefined);
      return new GcSlice(git, policy(), log, blocks?.(), hooks, roots).run(
        job,
        cursor?.v === 1 ? cursor : undefined,
      );
    },
  };
}

class GcSlice {
  readonly counter: CallCounter = { calls: 0 };
  readonly deadline: number;

  constructor(
    readonly git: RepoGitStorage,
    readonly policy: MaintenancePolicy,
    readonly log: Logger,
    readonly blocks: BlockCache | undefined,
    readonly hooks: GcHooks = {},
    readonly roots: () => readonly Oid[] = () => [],
  ) {
    this.deadline = git.context.now() + policy.sliceMs;
  }

  async run(job: Job, cursor: GcCursor | undefined): Promise<SliceResult> {
    try {
      if (!cursor) return await this.#snapshot();
      switch (cursor.phase) {
        case "mark-refs":
        case "mark-all":
          return await this.#mark(cursor);
        case "write-gc":
        case "write-garbage":
          return await this.#write(job, cursor);
        case "swap":
          return await this.#swap(cursor);
      }
    } catch (error) {
      if (error instanceof MissingObjectError) {
        // An incomplete mark must never decide what is garbage: stop here.
        this.log.error("garbage collection stopped: a reachable object is missing", { error });
        if (cursor) await this.#cleanup(cursor);
        return { done: true };
      }
      // A step that keeps failing from its saved state (a checkpoint lost
      // with a reset): start the run again rather than fail the job.
      if (cursor && job.attempts >= 2) {
        this.log.warn("garbage collection restarted after repeated failures", { error });
        return this.#restart(cursor);
      }
      throw error;
    }
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

  async #snapshot(): Promise<SliceResult> {
    const { git, policy } = this;
    const { storage } = git.context;
    const now = git.context.now();
    const sources = storage.sql
      .exec<{ pack_id: string; state: string; object_count: number | null; origin: string }>(
        `SELECT pack_id, state, object_count, origin FROM packs
         WHERE state IN ('live', 'garbage') AND bytes IS NOT NULL
         ORDER BY state DESC, created_at, pack_id`,
      )
      .toArray();
    if (!sources.some((s) => s.state === "live")) return { done: true };
    const state = git.refStore.state();
    const reflog = storage.sql
      .exec<{ old_oid: ArrayBuffer | null; new_oid: ArrayBuffer | null }>(
        "SELECT old_oid, new_oid FROM reflog WHERE at >= ?",
        now - policy.reflogRetentionMs,
      )
      .toArray();
    const reflogSeq =
      (storage.sql.exec<{ seq: number | null }>("SELECT max(seq) AS seq FROM reflog").one().seq as
        | number
        | null) ?? 0;
    const runId = newRunId(git);
    const roots = new Map<string, Uint8Array>();
    for (const row of reflog) {
      for (const value of [row.old_oid, row.new_oid]) {
        if (!value) continue;
        const bytes = new Uint8Array(value);
        roots.set(Array.from(bytes).join(","), bytes);
      }
    }
    // Further roots the repository keeps (pull requests' recorded bases) go with the reflog's.
    // One recorded after this read was a branch's tip when recorded: the refs this run marks
    // from, or an update after `reflogSeq` the swap's catch-up walks from, reach it. And a
    // later run reads it before condemning anything this run leaves garbage.
    for (const oid of this.roots()) roots.set(Array.from(oid).join(","), oid);
    const packed = new Uint8Array(roots.size * 20);
    let at = 0;
    for (const oid of roots.values()) {
      packed.set(oid, at);
      at += 20;
    }
    if (roots.size > 0) await putScratch(git, runId, REFLOG_ROOTS, packed, this.counter);
    // Sources: live packs ('live' > 'garbage', so first), then garbage packs, each oldest first.
    const cursor: GcCursor = {
      v: 1,
      runId,
      phase: "mark-refs",
      version: state.version,
      nonff: state.nonffVersion,
      reflogSeq,
      sources: sources.map((s) => ({
        id: s.pack_id as PackId,
        garbage: s.state === "garbage",
        count: s.object_count ?? -1,
        ...(s.origin === "borrowed" ? { borrowed: true } : {}),
      })),
      seq: 0,
      reflogRoots: roots.size,
    };
    return this.#mark(cursor, [...git.refStore.readRefsSync().refs.values()]);
  }

  async #mark(cursor: GcCursor, refRoots?: readonly Oid[]): Promise<SliceResult> {
    const { git } = this;
    if (!this.#sourcesReadable(cursor)) return this.#restart(cursor);
    const session = await MarkSession.open(
      this.#context(cursor.runId),
      cursor.sources.map((s) => s.id),
      { outside: "error", ...(cursor.seq > 0 ? { from: markName(MARK, cursor.seq) } : {}) },
    );
    try {
      let phase = cursor.phase;
      if (refRoots) session.mark.push(refRoots);
      for (;;) {
        if (!(await session.run())) {
          const next: GcCursor = { ...cursor, phase, seq: cursor.seq + 1 };
          await session.save(markName(MARK, next.seq));
          if (cursor.seq > 1) await session.dropCheckpoint(markName(MARK, cursor.seq - 1));
          return this.#next(next);
        }
        if (phase === "mark-all") break;
        // Refs done: keep their marks, then walk from the reflog entries.
        await putScratch(git, cursor.runId, REFS_BITS, encodeBitSets(session.bits), this.counter);
        phase = "mark-all";
        if (cursor.reflogRoots > 0) {
          const packed = await getScratch(git, cursor.runId, REFLOG_ROOTS, this.counter);
          const oids: Oid[] = [];
          for (let at = 0; at < packed.length; at += 20) oids.push(oidFromBytes(packed, at));
          session.mark.push(oids);
        }
      }
      await putScratch(git, cursor.runId, ALL_BITS, encodeBitSets(session.bits), this.counter);
      // The final mark is kept too: the swap's catch-up walk continues it.
      const next: GcCursor = { ...cursor, phase: "mark-all", seq: cursor.seq + 1 };
      await session.save(markName(MARK, next.seq));
      if (cursor.seq > 1) await session.dropCheckpoint(markName(MARK, cursor.seq - 1));
      const counts = session.sources.map((p) => p.idx.count);
      return this.#decide(
        { ...next, sources: next.sources.map((s, i) => ({ ...s, count: counts[i] as number })) },
        session.bits,
      );
    } finally {
      session.release();
    }
  }

  /** Chooses what to rewrite from the marks, and moves on to writing (or straight to the swap). */
  #decide(cursor: GcCursor, bits: readonly BitSet[]): SliceResult {
    const gcSources: number[] = [];
    const splitSources: number[] = [];
    let rewriteObjects = 0;
    cursor.sources.forEach((source, i) => {
      const marked = (bits[i] as BitSet).count();
      // Borrowed packs are never rewritten; the swap decides whether they stay in the view.
      if (source.borrowed) return;
      if (source.garbage) {
        if (marked > 0) gcSources.push(i);
      } else if (marked < source.count) {
        gcSources.push(i);
        splitSources.push(i);
      }
      if (gcSources.includes(i)) rewriteObjects += source.count;
    });
    if (rewriteObjects > this.policy.maxRewriteObjects) {
      // Over the budget for one run: leave the packs as they are rather than
      // rewrite part of a split (collections this large are not done yet).
      this.log.warn("garbage collection skipped: too many objects to rewrite in one run", {
        objects: rewriteObjects,
      });
      return this.#next({
        ...cursor,
        phase: "swap",
        gcSources: [],
        splitSources: [],
        waitingSince: this.git.context.now(),
      });
    }
    // A live pack nothing reaches is split into garbage alone.
    const kept = gcSources.filter((i) => (bits[i] as BitSet).count() > 0);
    const phase = kept.length > 0 ? "write-gc" : splitSources.length > 0 ? "write-garbage" : "swap";
    return this.#next({
      ...cursor,
      gcSources: kept,
      splitSources,
      phase,
      ...(phase === "swap" ? { waitingSince: this.git.context.now() } : {}),
    });
  }

  async #write(job: Job, cursor: GcCursor): Promise<SliceResult> {
    const { git } = this;
    if (!this.#sourcesReadable(cursor)) return this.#restart(cursor);
    const sizes = cursor.sources.map((s) => s.count);
    const bits = decodeBitSets(await getScratch(git, cursor.runId, ALL_BITS, this.counter), sizes);
    const garbage = cursor.phase === "write-garbage";
    const indexes = (garbage ? cursor.splitSources : cursor.gcSources) ?? [];
    const state = garbage ? cursor.garbageRewrite : cursor.gcRewrite;
    let outcome: Awaited<ReturnType<typeof rewriteSlice>>;
    try {
      outcome = await rewriteSlice(
        { ...this.#context(cursor.runId), holder: GC_JOB_ID },
        {
          kind: garbage ? "garbage" : "gc",
          sources: indexes.map((i) => (cursor.sources[i] as GcCursor["sources"][number]).id),
          keep: indexes.map((i) =>
            garbage ? (bits[i] as BitSet).complement() : (bits[i] as BitSet),
          ),
        },
        state,
      );
    } catch (error) {
      if (job.attempts < 2) throw error;
      this.log.warn("garbage collection output restarted", { error });
      if (state) await discardOutput(git, state.packId);
      return this.#next(
        garbage ? { ...cursor, garbageRewrite: undefined } : { ...cursor, gcRewrite: undefined },
      );
    }
    if (!outcome.done)
      return this.#next(
        garbage
          ? { ...cursor, garbageRewrite: outcome.state }
          : { ...cursor, gcRewrite: outcome.state },
      );
    const output: Output = {
      packId: outcome.packId,
      objects: outcome.objectCount,
      bytes: outcome.bytes,
    };
    if (garbage)
      return this.#next({
        ...cursor,
        phase: "swap",
        garbageOutput: output,
        waitingSince: git.context.now(),
      });
    const split = (cursor.splitSources ?? []).length > 0;
    return this.#next({
      ...cursor,
      gcOutput: output,
      phase: split ? "write-garbage" : "swap",
      ...(split ? {} : { waitingSince: git.context.now() }),
    });
  }

  async #swap(cursor: GcCursor): Promise<SliceResult> {
    const { git } = this;
    const plan: GcSwapPlan = {
      cursor,
      allBits: ALL_BITS,
      refsBits: REFS_BITS,
      mark: markName(MARK, cursor.seq),
      nextMark: markName(MARK, cursor.seq + 1),
    };
    const result = await gcSwap(this.#context(cursor.runId), plan, this.log, this.hooks);
    switch (result.kind) {
      case "busy":
      case "waiting":
        return { done: false, cursor: encodeJson(cursor), runAfterMs: result.retryMs };
      case "packs-changed":
        // Swapped already (the cursor saying so was lost): the run is over.
        if (swapped(git, cursor.gcOutput?.packId) || swapped(git, cursor.garbageOutput?.packId)) {
          git.leases.releaseHolder(GC_JOB_ID);
          await deleteRun(git, cursor.runId);
          return { done: false, cursor: null, runAfterMs: this.policy.retryMs };
        }
        return this.#restart(cursor);
      case "remark":
        // Refs moved to objects this run treated as garbage: decide again from the new marks.
        await this.#discardOutputs(cursor);
        return this.#decide(
          {
            ...cursor,
            seq: cursor.seq + 1,
            gcRewrite: undefined,
            gcOutput: undefined,
            garbageRewrite: undefined,
            garbageOutput: undefined,
          },
          result.bits,
        );
      case "done": {
        git.leases.releaseHolder(GC_JOB_ID);
        await deleteRun(git, cursor.runId);
        if (result.nextAt === undefined) return { done: true };
        // The job reschedules itself: scheduling it from inside its own slice would not.
        return {
          done: false,
          cursor: null,
          runAfterMs: Math.max(0, result.nextAt - git.context.now()),
        };
      }
    }
  }

  /** Whether every source can still be read (a source deleted under the run would make it fail). */
  #sourcesReadable(cursor: GcCursor): boolean {
    return cursor.sources.every((s) => {
      const state = this.git.registry.get(s.id)?.state;
      return (
        state === "live" || state === "garbage" || state === "superseded" || state === "condemned"
      );
    });
  }

  async #discardOutputs(cursor: GcCursor): Promise<void> {
    for (const packId of [
      cursor.gcOutput?.packId ?? cursor.gcRewrite?.packId,
      cursor.garbageOutput?.packId ?? cursor.garbageRewrite?.packId,
    ]) {
      if (packId) await discardOutput(this.git, packId);
    }
  }

  async #cleanup(cursor: GcCursor): Promise<void> {
    releaseOutputLease(this.git, cursor.gcRewrite);
    releaseOutputLease(this.git, cursor.garbageRewrite);
    this.git.leases.releaseHolder(GC_JOB_ID);
    await this.#discardOutputs(cursor);
    await deleteRun(this.git, cursor.runId);
  }

  /** Starts the collection again from a new snapshot. */
  async #restart(cursor: GcCursor): Promise<SliceResult> {
    this.git.context.metrics.count("git.maintenance", { job: "gc", what: "restarts" }, 1);
    await this.#cleanup(cursor);
    return { done: false, cursor: null, runAfterMs: 0 };
  }

  #next(cursor: GcCursor): SliceResult {
    return { done: false, cursor: encodeJson(cursor), runAfterMs: 0 };
  }
}
