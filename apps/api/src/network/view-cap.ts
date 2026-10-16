import {
  type Job,
  type JobHandler,
  type RepoGitStorage,
  replaceUploadDependencies,
  type SliceResult,
  scheduleOrphanReaper,
  schedulePackRetire,
} from "@fyrden/adapters-cloudflare/git";
import type { BlockCache, PackId } from "@fyrden/git-core";
import { newRunId } from "../git/maintenance/ids.js";
import type { MaintenancePolicy } from "../git/maintenance/policy.js";
import {
  type RewriteOutcome,
  type RewriteState,
  releaseOutputLease,
  rewriteSlice,
} from "../git/maintenance/rewrite.js";
import {
  decodeJson,
  deleteRun,
  discardOutput,
  encodeJson,
  swapped,
} from "../git/maintenance/storage.js";
import { DETACH_JOB_ID } from "./detach.js";
import { liveViewPacks } from "./member.js";
import type { ViewPack } from "./types.js";

/*
 * The view cap: a repository's full view (own plus
 * borrowed packs) holds at most `viewCap` packs (Proposed 32). Own packs
 * are capped by the pack-count cap (16), so a fork may borrow at most
 * `viewCap - ownCap` packs. A fork of a fork can inherit more than that
 * (its parent's own and borrowed packs); before such a fork is published,
 * its oldest borrowed packs (the shared base of the chain) are compacted
 * into one new shared pack, written under the network's prefix, which
 * replaces them in the fork's view. The parent's views are not changed.
 *
 * The compaction copies entries (no delta search) and keeps whole pack
 * units together, so its output is self-contained. It contains exactly the
 * objects of the packs it replaces: the fork can read no object it could
 * not read before.
 */

/** Proposed: packs in a repository's full view (own plus borrowed). */
export const VIEW_CAP = 32;

/**
 * The borrowed packs to compact so that `packs` fits in `limit` packs:
 * whole units (a thin pack and its completion pack), oldest first, until
 * merging them into one leaves at most `limit`. Empty when it fits.
 */
export function chooseBaseCompaction(packs: readonly ViewPack[], limit: number): ViewPack[] {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new RangeError("the view limit must be at least 1");
  if (packs.length <= limit) return [];
  const units = new Map<string, ViewPack[]>();
  for (const pack of [...packs].sort(
    (a, b) => a.createdAt - b.createdAt || cmp(a.packId, b.packId),
  )) {
    const key = pack.unitId ?? pack.packId;
    units.set(key, [...(units.get(key) ?? []), pack]);
  }
  const chosen: ViewPack[] = [];
  for (const unit of units.values()) {
    if (packs.length - chosen.length + 1 <= limit && chosen.length > 1) break;
    chosen.push(...unit);
  }
  return chosen;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export interface CompactSliceInput {
  readonly sources: readonly string[];
  /** The run (its scratch objects): absent on the first slice, then as the first slice answered. */
  readonly runId?: string;
  readonly state?: RewriteState;
}

/** One slice of compacting borrowed `sources` into one new pack (resumable from `runId` and `state`). */
export async function compactBorrowedSlice(
  git: RepoGitStorage,
  policy: MaintenancePolicy,
  blocks: BlockCache | undefined,
  input: CompactSliceInput,
): Promise<{ runId: string; outcome: RewriteOutcome }> {
  const runId = input.runId ?? newRunId(git);
  const live = new Set(
    liveViewPacks(git)
      .filter((p) => p.origin === "borrowed")
      .map((p) => p.packId),
  );
  for (const id of input.sources)
    if (!live.has(id)) throw new Error(`pack ${id} is not a live borrowed pack of this view`);
  const outcome = await rewriteSlice(
    {
      git,
      policy,
      runId,
      holder: "view-cap",
      counter: { calls: 0 },
      ...(blocks ? { blocks } : {}),
      deadline: git.context.now() + policy.sliceMs,
    },
    { kind: "compact", sources: input.sources as PackId[] },
    input.state,
  );
  if (outcome.done) await deleteRun(git, runId);
  return { runId, outcome };
}

/**
 * Swaps a finished compaction into the view: the output goes live as a
 * borrowed (network-owned) pack, the sources are superseded (their claims
 * are released by the retire job). Returns the output as the network
 * records it.
 */
export function swapCompactedView(
  git: RepoGitStorage,
  output: string,
  sources: readonly string[],
): ViewPack {
  const { storage } = git.context;
  storage.transactionSync(() => {
    for (const id of sources) {
      const row = storage.sql
        .exec<{ state: string; origin: string }>(
          "SELECT state, origin FROM packs WHERE pack_id = ?",
          id,
        )
        .toArray()[0];
      if (row?.state !== "live" || row.origin !== "borrowed")
        throw new Error(`pack ${id} is no longer a live borrowed pack`);
    }
    if (git.registry.transition(output, ["indexing"], "live") === 0)
      throw new Error(`compacted pack ${output} is not finished`);
    storage.sql.exec("UPDATE packs SET origin = 'borrowed' WHERE pack_id = ?", output).toArray();
    for (const id of sources) git.registry.transition(id, ["live"], "superseded");
    // A push indexed against a source depends on the output now (it holds all their objects).
    replaceUploadDependencies(git, sources as PackId[], [output as PackId]);
    storage.sql
      .exec("DELETE FROM leases WHERE pack_id = ? AND holder = 'view-cap'", output)
      .toArray();
  });
  schedulePackRetire(git.jobs, git.context.now());
  const out = liveViewPacks(git).find((p) => p.packId === output);
  if (!out) throw new Error(`compacted pack ${output} is not in the view`);
  return out;
}

/** Packs one view compaction merges at most (their indexes are loaded per slice). Proposed. */
export const MAX_COMPACTION_SOURCES = 16;

/** What a view compaction works within: the borrowed packs the view may hold, and one run's limits. */
export interface CompactionLimits {
  readonly limit: number;
  readonly maxPacks: number;
  readonly maxObjects: number;
}

/**
 * The limits of a view whose own packs are capped at `ownCap`, compacted
 * within `maxObjects` a run (the maintenance policy's rewrite budget).
 */
export function compactionLimits(ownCap: number, maxObjects: number): CompactionLimits {
  // At least one borrowed pack, even if the own-pack cap was raised to the view cap.
  return { limit: Math.max(1, VIEW_CAP - ownCap), maxPacks: MAX_COMPACTION_SOURCES, maxObjects };
}

/**
 * One run's sources for a view of `packs` (borrowed, live) over `limit`:
 * whole units, oldest first, skipping a unit that does not fit what is
 * left of the run's limits (at most `maxPacks` packs and `maxObjects`
 * objects: each slice loads every source's index), until merging them
 * would bring the view within `limit` or the run is full. Fewer than two
 * packs is no run.
 */
export function batchOf(packs: readonly ViewPack[], limits: CompactionLimits): ViewPack[] {
  const needed = packs.length - limits.limit + 1;
  if (needed < 2) return [];
  // Units across the whole view (a unit's packs need not be next to each other), oldest first.
  const byUnit = new Map<string, ViewPack[]>();
  for (const pack of packs) {
    const key = pack.unitId ?? pack.packId;
    byUnit.set(key, [...(byUnit.get(key) ?? []), pack]);
  }
  const units = [...byUnit.values()];
  // From the oldest unit first; when a start leaves no batch (a unit too large to pair with the
  // rest), from the next one.
  for (let start = 0; start < units.length; start++) {
    const out: ViewPack[] = [];
    let objects = 0;
    for (const unit of units.slice(start)) {
      if (out.length >= needed) break;
      const unitObjects = unit.reduce((n, p) => n + (p.objectCount ?? 0), 0);
      if (out.length + unit.length > Math.max(2, limits.maxPacks)) continue;
      if (objects + unitObjects > limits.maxObjects) continue;
      out.push(...unit);
      objects += unitObjects;
    }
    if (out.length >= 2) return out;
  }
  return [];
}

/** A run of the view's compaction under way: its sources, and its output's objects once written. */
export interface RunUnderWay {
  readonly sources: readonly string[];
  readonly objects?: number;
}

/**
 * Whether the view compaction may bring a view of `packs` (borrowed, live,
 * oldest first) within `limits.limit`: the run under way first (`underWay`,
 * unless its sources left the view, which discards it), then its runs one
 * after another as the job chooses them. An output holds its sources'
 * objects without repeats: its count is known once written, and before
 * that taken at the least it can be (its largest source's), so a view is
 * refused only when even then a run would find no batch while it is still
 * over (no two units fit one run). Each run takes at least two packs and
 * gives back one, so this ends.
 */
export function fitsAfterCompaction(
  packs: readonly ViewPack[],
  limits: CompactionLimits,
  underWay?: RunUnderWay,
): boolean {
  let view = [...packs];
  const merge = (batch: readonly ViewPack[], run: number, objects?: number) => {
    const [first] = batch;
    if (!first) return;
    const merged = new Set(batch.map((p) => p.packId));
    const output: ViewPack = {
      ...first,
      packId: `compacted:${run}`,
      unitId: null,
      objectCount: objects ?? Math.max(...batch.map((p) => p.objectCount ?? 0)),
    };
    // An output is newer than every pack of the view.
    view = [...view.filter((p) => !merged.has(p.packId)), output];
  };
  const running = view.filter((p) => underWay?.sources.includes(p.packId));
  if (underWay && running.length === underWay.sources.length) merge(running, -1, underWay.objects);
  for (let run = 0; view.length > limits.limit; run++) {
    const batch = batchOf(view, limits);
    if (batch.length < 2) return false;
    merge(batch, run);
  }
  return true;
}

/**
 * The run of the view's compaction under way, if one is (its sources
 * chosen): with its output's objects once the run is written, waiting to
 * be swapped in.
 */
export function runUnderWay(git: RepoGitStorage): RunUnderWay | undefined {
  const job = git.jobs.get(VIEW_COMPACT_JOB);
  if (job?.state !== "queued" && job?.state !== "running") return undefined;
  const cursor = decodeJson<ViewCompactCursor>(job.cursor);
  if (!cursor?.sources || (cursor.phase !== "swap" && !cursor.runId)) return undefined;
  if (cursor.phase === "compact") return { sources: cursor.sources };
  const objects = git.context.storage.sql
    .exec<{ object_count: number | null }>(
      "SELECT object_count FROM packs WHERE pack_id = ?",
      cursor.outputId ?? "",
    )
    .toArray()[0]?.object_count;
  return { sources: cursor.sources, ...(typeof objects === "number" && { objects }) };
}

/** A view over its cap that no compaction run fits (no two of its units within a run's limits). */
export class ViewOverCap extends Error {
  override name = "ViewOverCap";
}

/** The one job compacting a view over its cap (packs borrowed from pull requests' heads). */
export const VIEW_COMPACT_JOB = "view-compact";

/** Where the view's compaction is: the run under way, or its output waiting to be recorded. */
interface ViewCompactCursor {
  readonly phase: "compact" | "swap" | "record";
  readonly sources?: readonly string[];
  readonly runId?: string;
  readonly rewrite?: RewriteState;
  /** The finished run's output, waiting to be swapped in. */
  readonly outputId?: string;
  /** Runs that failed in a row (each discarded). */
  readonly failures?: number;
  /** The network the run's scratch objects are under (a detach moves the repository to another). */
  readonly networkId?: string;
  readonly output?: ViewPack;
}

/** When to try the swap again while a push is being indexed (or a failed run again). Proposed. */
const SWAP_RETRY_MS = 5_000;
/** When the orphan reaper looks for outputs a discarded run could not delete (past its age). */
const ORPHAN_REAP_AFTER_MS = 25 * 60 * 60_000;

/** Failed runs in a row after which the compaction gives up until it is asked for again. */
const MAX_RUN_FAILURES = 3;

/** Asks for the view's compaction (it picks its sources when it starts; one under way is left). */
export function scheduleViewCompaction(git: RepoGitStorage): void {
  git.jobs.ensure("view_compact", VIEW_COMPACT_JOB, {
    cursor: encodeJson({ phase: "compact" } satisfies ViewCompactCursor),
  });
}

/**
 * The view's compaction as a job: while the view is over its cap, its
 * oldest borrowed packs are compacted into one (slice by slice, the run's
 * state in the job's cursor), swapped in with the cursor saying so in the
 * same transaction, and recorded with the network. A run whose sources
 * left the view meanwhile is discarded (its output and scratch deleted)
 * and the compaction starts again from the view as it is.
 */
export function viewCompactionHandler(deps: {
  readonly git: RepoGitStorage;
  readonly policy: () => MaintenancePolicy;
  readonly blocks: () => BlockCache;
  /** Own packs the view may hold (the pack-count cap): the view cap less it may be borrowed. */
  readonly ownCap: () => number;
  /** Records the compacted pack with the network (as a fork's base compaction is). */
  readonly record: (output: ViewPack) => Promise<void>;
}): JobHandler {
  const { git } = deps;
  const borrowedLive = () => liveViewPacks(git).filter((p) => p.origin === "borrowed");
  return {
    runSlice: async (job: Job): Promise<SliceResult> => {
      const cursor = decodeJson<ViewCompactCursor>(job.cursor) ?? { phase: "compact" };
      // A detach moves the packs itself: no view compaction meanwhile, and a run under the old
      // network is cancelled where its scratch objects are.
      const detaching = isDetaching(git);
      if (detaching || (cursor.networkId && cursor.networkId !== git.networkId())) {
        await discardRun(git, cursor);
        return detaching
          ? { done: true }
          : { done: false, cursor: encodeJson({ phase: "compact" }), runAfterMs: 0 };
      }
      if (cursor.phase === "record" && cursor.output) {
        await deps.record(cursor.output);
        // Over the cap still (more borrowed meanwhile): another round.
        return { done: false, cursor: encodeJson({ phase: "compact" }), runAfterMs: 0 };
      }
      if (cursor.phase === "swap" && cursor.outputId && cursor.sources) {
        const { outputId, sources } = cursor;
        // A push being indexed may still name a source: swapped once it is done, as maintenance is.
        const indexing =
          git.context.storage.sql
            .exec("SELECT 1 FROM uploads WHERE state = 'indexing' LIMIT 1")
            .toArray().length > 0;
        const outputState = git.registry.get(outputId as never)?.state;
        const live = new Set(borrowedLive().map((p) => p.packId));
        const valid = outputState === "indexing" && sources.every((id) => live.has(id));
        if (indexing && valid) {
          // Kept while it waits: the output's lease would let retirement take it after a while.
          git.context.storage.sql.exec(
            "UPDATE leases SET expires_at = ? WHERE pack_id = ? AND holder = 'view-cap'",
            git.context.now() + deps.policy().outputLeaseMs,
            outputId,
          );
          return { done: false, cursor: job.cursor, runAfterMs: SWAP_RETRY_MS };
        }
        if (!valid) {
          // The sources changed under the run, or its output is gone: discarded, and the view
          // looked at again.
          await discardRun(git, { ...cursor, rewrite: { packId: outputId } as RewriteState });
          return { done: false, cursor: encodeJson({ phase: "compact" }), runAfterMs: 0 };
        }
        git.context.storage.transactionSync(() => {
          const output = swapCompactedView(git, outputId, sources);
          git.jobs.checkpoint(
            job,
            encodeJson({
              phase: "record",
              output,
              networkId: cursor.networkId ?? git.networkId(),
            } satisfies ViewCompactCursor),
          );
        });
        const output = liveViewPacks(git).find((p) => p.packId === outputId) as ViewPack;
        return {
          done: false,
          cursor: encodeJson({
            phase: "record",
            output,
            networkId: cursor.networkId ?? git.networkId(),
          } satisfies ViewCompactCursor),
          runAfterMs: 0,
        };
      }
      let sources = cursor.sources;
      if (!cursor.runId || !sources) {
        // A bounded batch at a time (each run loads its sources' indexes): whole units, oldest
        // first; the view is looked at again once it is recorded.
        const view = borrowedLive();
        const limits = compactionLimits(deps.ownCap(), deps.policy().maxRewriteObjects);
        sources = batchOf(view, limits).map((p) => p.packId);
        if (sources.length === 0) {
          if (view.length <= limits.limit) return { done: true };
          // Imports refuse packs that would leave the view so; a view over it all the same (the
          // budget lowered since) fails the job, tried again in case a collection drops packs.
          throw new ViewOverCap(
            `the view holds ${view.length} borrowed packs, over its cap of ${limits.limit}, ` +
              `and no two of them fit one compaction of ${limits.maxObjects} objects`,
          );
        }
        // The run's id is stored before its first slice writes anything under it: an eviction
        // leaves nothing a later cleanup cannot find.
        return {
          done: false,
          cursor: encodeJson({
            phase: "compact",
            sources,
            runId: newRunId(git),
            networkId: git.networkId(),
            ...(cursor.failures ? { failures: cursor.failures } : {}),
          } satisfies ViewCompactCursor),
          runAfterMs: 0,
        };
      }
      const live = new Set(borrowedLive().map((p) => p.packId));
      if (!sources.every((id) => live.has(id))) {
        // Swapped already (evicted before the cursor said so): only the recording is left.
        const outputId = cursor.rewrite?.packId;
        const output = outputId && liveViewPacks(git).find((p) => p.packId === outputId);
        if (output && swapped(git, outputId))
          return {
            done: false,
            cursor: encodeJson({
              phase: "record",
              output,
              networkId: cursor.networkId ?? git.networkId(),
            } satisfies ViewCompactCursor),
            runAfterMs: 0,
          };
        // The sources changed under the run: it is discarded, and the view looked at again.
        await discardRun(git, cursor);
        return { done: false, cursor: encodeJson({ phase: "compact" }), runAfterMs: 0 };
      }
      const runId = cursor.runId;
      let slice: Awaited<ReturnType<typeof compactBorrowedSlice>>;
      try {
        slice = await compactBorrowedSlice(git, deps.policy(), deps.blocks(), {
          sources,
          runId,
          ...(cursor.rewrite ? { state: cursor.rewrite } : {}),
        });
        // A detach began during the slice: its scratch writes may be under either network.
        if (movedNetworkOf(git, cursor)) {
          await discardRun(git, { ...cursor, runId });
          return { done: false, cursor: encodeJson({ phase: "compact" }), runAfterMs: 0 };
        }
      } catch (error) {
        // A run its checkpoint cannot go on from (its output's index not written, say): discarded
        // and begun again; after a few such, left until the view is compacted again.
        await discardRun(git, { ...cursor, runId });
        const failures = (cursor.failures ?? 0) + 1;
        if (failures >= MAX_RUN_FAILURES) throw error;
        return {
          done: false,
          cursor: encodeJson({ phase: "compact", failures } satisfies ViewCompactCursor),
          runAfterMs: SWAP_RETRY_MS,
        };
      }
      if (!slice.outcome.done)
        return {
          done: false,
          cursor: encodeJson({
            phase: "compact",
            sources,
            runId: slice.runId,
            rewrite: slice.outcome.state,
            networkId: cursor.networkId ?? git.networkId(),
            ...(cursor.failures ? { failures: cursor.failures } : {}),
          } satisfies ViewCompactCursor),
          runAfterMs: 0,
        };
      return {
        done: false,
        cursor: encodeJson({
          phase: "swap",
          sources,
          runId: slice.runId,
          outputId: slice.outcome.packId,
          networkId: cursor.networkId ?? git.networkId(),
          ...(cursor.failures ? { failures: cursor.failures } : {}),
        } satisfies ViewCompactCursor),
        runAfterMs: 0,
      };
    },
  };
}

/** Whether a detach is under way (it moves the repository's packs to another network). */
export function isDetaching(git: RepoGitStorage): boolean {
  return ["queued", "running"].includes(git.jobs.get(DETACH_JOB_ID)?.state ?? "");
}

/** A run's network is no longer the repository's, or is about to change. */
function movedNetworkOf(git: RepoGitStorage, cursor: ViewCompactCursor): boolean {
  return (
    isDetaching(git) || (cursor.networkId !== undefined && cursor.networkId !== git.networkId())
  );
}

/** Unfinished outputs a view-cap lease holds. */
function viewCapOutputs(git: RepoGitStorage): string[] {
  return git.context.storage.sql
    .exec<{ pack_id: string }>(
      `SELECT DISTINCT l.pack_id FROM leases l JOIN packs p ON p.pack_id = l.pack_id
       WHERE l.holder = 'view-cap' AND p.state IN ('pending', 'indexing')`,
    )
    .toArray()
    .map((r) => r.pack_id);
}

/** A run that will not be swapped in: its unfinished output and scratch objects go. */
async function discardRun(git: RepoGitStorage, cursor: ViewCompactCursor): Promise<void> {
  // Should deleting an output's bytes fail, the orphan reaper removes discarded outputs later.
  if (cursor.rewrite || cursor.outputId || viewCapOutputs(git).length > 0)
    scheduleOrphanReaper(git.jobs, git.context.now() + ORPHAN_REAP_AFTER_MS);
  if (cursor.rewrite) {
    if (cursor.rewrite.leaseId !== undefined) releaseOutputLease(git, cursor.rewrite);
    await discardOutput(git, cursor.rewrite.packId);
  }
  // Any unfinished output a view-cap lease holds goes too: one a failed first slice made (this
  // job is the only view compaction of a live repository, so it is this run's).
  const outputs = new Set([...viewCapOutputs(git), ...(cursor.outputId ? [cursor.outputId] : [])]);
  for (const packId of outputs) {
    await discardOutput(git, packId as PackId);
    git.context.storage.sql.exec(
      "DELETE FROM leases WHERE pack_id = ? AND holder = 'view-cap'",
      packId,
    );
  }
  // Under the network it was planned in and the repository's now: a detach during a slice may
  // have sent its later scratch writes to the new one.
  if (cursor.runId)
    for (const networkId of new Set([cursor.networkId ?? git.networkId(), git.networkId()]))
      await deleteRun(git, cursor.runId, networkId);
}
