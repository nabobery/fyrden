import {
  LOCK_REF_COMMIT,
  type LockHandle,
  type RepoGitStorage,
  schedulePackRetire,
  swapPacks,
} from "@fyrden/adapters-cloudflare/git";
import type { Logger } from "@fyrden/adapters-cloudflare/obs";
import { type BitSet, type Oid, oidFromBytes, type PackId } from "@fyrden/git-core";
import type { GcCursor, GcHooks } from "./gc-job.js";
import { decodeBitSets, encodeBitSets, type MarkContext, MarkSession } from "./mark.js";
import { GC_JOB_ID } from "./schedule.js";
import { getScratch, LoadedPacks, putScratch } from "./storage.js";

/*
 * The end of a collection run, under the commit lock so no ref moves in
 * between: a catch-up walk from refs that moved since the snapshot, then
 * one swap transaction (see `swapPacks`).
 *
 * The catch-up is what makes a run safe while pushes continue: an object
 * the run marked unreachable may have become reachable again (a ref moved
 * back to it). The walk goes through packs newer than the run's sources
 * and marks what it reaches in the sources; if it marks anything new, the
 * run decides again from the new marks instead of swapping.
 */

export interface GcSwapPlan {
  readonly cursor: GcCursor;
  /** Scratch names: every mark, the refs-only marks, the final mark checkpoint and where a new one goes. */
  readonly allBits: string;
  readonly refsBits: string;
  readonly mark: string;
  readonly nextMark: string;
}

export type GcSwapResult =
  | { readonly kind: "busy" | "waiting"; readonly retryMs: number }
  | { readonly kind: "packs-changed" }
  | { readonly kind: "remark"; readonly bits: readonly BitSet[] }
  /** Swapped; `nextAt`: when the next collection is due, if one is. */
  | { readonly kind: "done"; readonly nextAt: number | undefined };

/** How long the swap may hold the commit lock without renewal (it renews after every await). Proposed. */
const SWAP_LOCK_MS = 30_000;
const BUSY_RETRY_MS = 5_000;
/** Catch-ups one swap repeats when the refs moved under it (its lock lapsed) before it retries later. Proposed. */
const MAX_CATCH_UPS = 3;

/**
 * The swap, under the commit lock. Every await (scratch reads, the
 * catch-up walk, loading indexes) renews the lock, and the swap
 * transaction itself checks that the lock is still this run's and the refs
 * are still where the catch-up saw them: if the lock lapsed and a push
 * moved a ref meanwhile, the catch-up runs again from the moved refs
 * rather than swapping on marks that missed them.
 */
export async function gcSwap(
  context: MarkContext,
  plan: GcSwapPlan,
  log: Logger,
  hooks: GcHooks = {},
): Promise<GcSwapResult> {
  const { git } = context;
  let lock = git.locks.tryAcquire(LOCK_REF_COMMIT, GC_JOB_ID, SWAP_LOCK_MS);
  if (!lock) return { kind: "busy", retryMs: BUSY_RETRY_MS };
  const held: { lock: LockHandle } = { lock };
  try {
    for (let round = 1; ; round++) {
      const result = await swapOnce(context, plan, log, hooks, held);
      if (result !== "refs-moved") return result;
      if (round >= MAX_CATCH_UPS) return { kind: "busy", retryMs: BUSY_RETRY_MS };
      if (!git.locks.isHeld(held.lock)) {
        lock = git.locks.tryAcquire(LOCK_REF_COMMIT, GC_JOB_ID, SWAP_LOCK_MS);
        if (!lock) return { kind: "busy", retryMs: BUSY_RETRY_MS };
        held.lock = lock;
      }
    }
  } finally {
    git.locks.release(held.lock);
  }
}

/** One catch-up and swap attempt; "refs-moved" when the refs moved under it. */
async function swapOnce(
  context: MarkContext,
  plan: GcSwapPlan,
  log: Logger,
  hooks: GcHooks,
  held: { lock: LockHandle },
): Promise<GcSwapResult | "refs-moved"> {
  const { git, policy } = context;
  /** Extends the lock after an await; a lapsed lock is caught by the swap's fence. */
  const renew = () => {
    const renewed = git.locks.renew(held.lock, SWAP_LOCK_MS);
    if (renewed) held.lock = renewed;
  };
  const { cursor } = plan;
  // The refs the catch-up walks from: the swap commits only while they are current.
  const refsVersion = git.refStore.state().version;
  const sizes = cursor.sources.map((s) => s.count);
  const bits = decodeBitSets(
    await getScratch(git, cursor.runId, plan.allBits, context.counter),
    sizes,
  );
  renew();
  const moved = movedRefs(git, cursor.reflogSeq);
  if (moved.length > 0) {
    const caught = await catchUp(context, plan, moved);
    renew();
    if (caught === "too-far") return { kind: "packs-changed" };
    if (caught) return { kind: "remark", bits: caught };
  }
  await hooks.afterCatchUp?.();
  const refs = decodeBitSets(
    await getScratch(git, cursor.runId, plan.refsBits, context.counter),
    sizes,
  );
  renew();
  const swap = await prepare(context, cursor, bits, refs);
  renew();
  const now = git.context.now();
  const waited = now - (cursor.waitingSince ?? now);
  const outputs = [cursor.gcOutput?.packId, cursor.garbageOutput?.packId].filter(
    (p): p is PackId => p !== undefined,
  );
  // The outputs stay leased (no reaper takes them) for as long as the swap waits.
  git.leases.releaseHolder(GC_JOB_ID);
  if (outputs.length > 0) git.leases.grant("maintenance", outputs, GC_JOB_ID, policy.outputLeaseMs);
  const result = swapPacks(git, {
    remove: swap.split,
    live: cursor.gcOutput ? [cursor.gcOutput.packId] : [],
    garbage: cursor.garbageOutput ? [cursor.garbageOutput.packId] : [],
    condemn: swap.condemn,
    touch: swap.touch,
    dropBorrowed: swap.dropBorrowed,
    rescueBorrowed: swap.rescueBorrowed,
    dropCommits: swap.dropCommits,
    allReachable: { packIds: swap.allReachable, nonffVersion: cursor.nonff },
    respectLeases: waited < policy.leaseWaitMs,
    waitForIndexing: waited < policy.indexingWaitMs,
    fence: { lock: held.lock, refsVersion },
  });
  if (!result.ok) {
    if (result.reason === "refs-moved") {
      log.info("refs moved during the garbage collection swap; catching up again");
      return "refs-moved";
    }
    if (result.reason === "packs-changed") return { kind: "packs-changed" };
    return { kind: "waiting", retryMs: policy.retryMs };
  }
  report(git, cursor, swap);
  schedulePackRetire(git.jobs, now);
  log.info("garbage collection swapped", {
    split: swap.split.length,
    condemned: swap.condemn.length,
    garbageObjects: cursor.garbageOutput?.objects ?? 0,
  });
  return { kind: "done", nextAt: nextCollection(git, context, swap.reflogOnly) };
}

/** New values of refs that moved after the snapshot. */
function movedRefs(git: RepoGitStorage, afterSeq: number): Oid[] {
  const seen = new Map<string, Oid>();
  for (const row of git.context.storage.sql
    .exec<{ new_oid: ArrayBuffer | null }>(
      "SELECT new_oid FROM reflog WHERE seq > ? AND new_oid IS NOT NULL",
      afterSeq,
    )
    .toArray()) {
    const oid = oidFromBytes(new Uint8Array(row.new_oid as ArrayBuffer));
    seen.set(oid.join(","), oid);
  }
  return [...seen.values()];
}

/**
 * Walks from `moved` through every readable pack, continuing the run's mark.
 * Returns the new marks when it marked an object of the sources, undefined
 * when nothing changed, "too-far" when the walk is too long to finish here.
 */
async function catchUp(
  context: MarkContext,
  plan: GcSwapPlan,
  moved: readonly Oid[],
): Promise<readonly BitSet[] | undefined | "too-far"> {
  const { git, policy } = context;
  const sources = plan.cursor.sources.map((s) => s.id);
  const readable = git.context.storage.sql
    .exec<{ pack_id: string }>(
      `SELECT pack_id FROM packs WHERE state IN ('live', 'garbage') AND bytes IS NOT NULL
       ORDER BY created_at DESC, pack_id DESC`,
    )
    .toArray()
    .map((r) => r.pack_id as PackId);
  const session = await MarkSession.open(context, sources, {
    outside: "descend",
    readerPacks: [...new Set([...readable, ...sources])],
    from: plan.mark,
  });
  try {
    const before = session.mark.marked;
    session.mark.push(moved);
    if (!(await session.run(policy.maxCatchUpObjects))) return "too-far";
    if (session.mark.marked === before) return undefined;
    await session.save(plan.nextMark);
    await putScratch(
      git,
      plan.cursor.runId,
      plan.allBits,
      encodeBitSets(session.bits),
      context.counter,
    );
    return session.bits;
  } finally {
    session.release();
  }
}

interface Prepared {
  /** Live sources split into the outputs. */
  readonly split: PackId[];
  readonly condemn: PackId[];
  readonly touch: PackId[];
  /** Borrowed live packs nothing reaches: they leave the view as garbage. */
  readonly dropBorrowed: PackId[];
  /** Borrowed garbage packs something reaches again: back to live. */
  readonly rescueBorrowed: PackId[];
  readonly dropCommits: Oid[];
  readonly allReachable: PackId[];
  /** Some reachable objects are reachable only from the reflog. */
  readonly reflogOnly: boolean;
}

async function prepare(
  context: MarkContext,
  cursor: GcCursor,
  bits: readonly BitSet[],
  refs: readonly BitSet[],
): Promise<Prepared> {
  const { git, policy } = context;
  const now = git.context.now();
  const split = (cursor.splitSources ?? []).map(
    (i) => (cursor.sources[i] as GcCursor["sources"][number]).id,
  );
  const gcSources = cursor.gcSources ?? [];
  const touch: PackId[] = [];
  const condemnable: PackId[] = [];
  const allReachable: PackId[] = [];
  const dropBorrowed: PackId[] = [];
  const rescueBorrowed: PackId[] = [];
  let reflogOnly = false;
  cursor.sources.forEach((source, i) => {
    const all = bits[i] as BitSet;
    const fromRefs = refs[i] as BitSet;
    if (all.count() > fromRefs.count()) reflogOnly = true;
    if (source.borrowed && source.garbage && all.count() > 0) {
      rescueBorrowed.push(source.id);
    } else if (source.borrowed && !source.garbage && all.count() === 0) {
      dropBorrowed.push(source.id);
    } else if (source.garbage) {
      if (all.count() > 0) touch.push(source.id);
      else if (lastTouched(git, source.id) + policy.garbageTtlMs <= now)
        condemnable.push(source.id);
    } else if (!split.includes(source.id) && fromRefs.count() === source.count) {
      allReachable.push(source.id);
    }
  });
  // The gc output is all-reachable when everything it keeps the refs reach.
  if (
    cursor.gcOutput &&
    gcSources.every((i) => {
      const fromRefs = refs[i] as BitSet;
      for (const p of (bits[i] as BitSet).indices()) if (!fromRefs.has(p)) return false;
      return true;
    })
  )
    allReachable.push(cursor.gcOutput.packId);
  // Commit rows of condemned packs go with them. An upload being indexed or
  // waiting to commit may have trusted such a row (its commit graph checks
  // stop at verified commits), so condemning waits until none is.
  const inFlight =
    git.context.storage.sql
      .exec("SELECT 1 AS one FROM uploads WHERE state IN ('indexing', 'indexed') LIMIT 1")
      .toArray().length > 0;
  const condemn = inFlight ? [] : condemnable;
  const dropCommits =
    condemn.length > 0 ? await commitsOnlyIn(context, cursor, condemn, split) : [];
  return {
    split,
    condemn,
    touch,
    dropBorrowed,
    rescueBorrowed,
    dropCommits,
    allReachable,
    reflogOnly,
  };
}

function lastTouched(git: RepoGitStorage, packId: PackId): number {
  return (
    git.context.storage.sql
      .exec<{ at: number }>("SELECT last_touched_at AS at FROM packs WHERE pack_id = ?", packId)
      .toArray()[0]?.at ?? Number.POSITIVE_INFINITY
  );
}

/**
 * Commits with a commit-graph row that only the condemned packs hold: no
 * pack that stays readable after the swap (live, garbage, the outputs) has
 * them.
 */
async function commitsOnlyIn(
  context: MarkContext,
  cursor: GcCursor,
  condemn: readonly PackId[],
  split: readonly PackId[],
): Promise<Oid[]> {
  const { git, counter } = context;
  const staying = git.context.storage.sql
    .exec<{ pack_id: string }>(
      "SELECT pack_id FROM packs WHERE state IN ('live', 'garbage') AND bytes IS NOT NULL",
    )
    .toArray()
    .map((r) => r.pack_id as PackId)
    .filter((id) => !condemn.includes(id) && !split.includes(id));
  for (const output of [cursor.gcOutput?.packId, cursor.garbageOutput?.packId])
    if (output) staying.push(output);
  const condemned = await LoadedPacks.load(git, condemn, counter);
  const others = await LoadedPacks.load(git, staying, counter);
  try {
    const candidates: Oid[] = [];
    for (const pack of condemned.packs) {
      for (let p = 0; p < pack.idx.count; p++) candidates.push(pack.idx.oidAt(p));
    }
    const commits = new Set<string>();
    for (let i = 0; i < candidates.length; i += 90) {
      const batch = candidates.slice(i, i + 90);
      for (const row of git.context.storage.sql
        .exec<{ oid: ArrayBuffer }>(
          `SELECT oid FROM commits WHERE oid IN (${batch.map(() => "?").join(", ")})`,
          ...batch.map((o) => new Uint8Array(o).buffer),
        )
        .toArray())
        commits.add(new Uint8Array(row.oid).join(","));
    }
    return candidates.filter(
      (oid) => commits.has(oid.join(",")) && others.packs.every((p) => p.idx.find(oid) < 0),
    );
  } finally {
    condemned.release();
    others.release();
  }
}

function report(git: RepoGitStorage, cursor: GcCursor, swap: Prepared): void {
  const count = (what: string, n: number) => {
    if (n > 0) git.context.metrics.count("git.maintenance", { job: "gc", what }, n);
  };
  count("packs_in", swap.split.length);
  count("packs_out", (cursor.gcOutput ? 1 : 0) + (cursor.garbageOutput ? 1 : 0));
  count("objects", cursor.gcOutput?.objects ?? 0);
  count("bytes_out", cursor.gcOutput?.bytes ?? 0);
  count("garbage_objects", cursor.garbageOutput?.objects ?? 0);
  count("garbage_bytes", cursor.garbageOutput?.bytes ?? 0);
  count("condemned", swap.condemn.length);
  count("borrowed_dropped", swap.dropBorrowed.length);
  count("borrowed_rescued", swap.rescueBorrowed.length);
  count("all_reachable", swap.allReachable.length);
}

/**
 * The next collection: when the earliest garbage pack's time to live ends,
 * and, while some objects are reachable only from the reflog, when the
 * oldest reflog entry leaves the retention.
 */
function nextCollection(
  git: RepoGitStorage,
  context: MarkContext,
  reflogOnly: boolean,
): number | undefined {
  const { policy } = context;
  const now = git.context.now();
  const sql = git.context.storage.sql;
  const due: number[] = [];
  const garbage = sql
    .exec<{ at: number | null }>(
      "SELECT min(last_touched_at) AS at FROM packs WHERE state = 'garbage'",
    )
    .one().at as number | null;
  if (garbage !== null) due.push(Math.max(garbage + policy.garbageTtlMs, now + policy.retryMs));
  if (reflogOnly) {
    const oldest = sql
      .exec<{ at: number | null }>(
        "SELECT min(at) AS at FROM reflog WHERE at >= ?",
        now - policy.reflogRetentionMs,
      )
      .one().at as number | null;
    if (oldest !== null)
      due.push(Math.max(oldest + policy.reflogRetentionMs + 1, now + policy.retryMs));
  }
  return due.length > 0 ? Math.min(...due) : undefined;
}
