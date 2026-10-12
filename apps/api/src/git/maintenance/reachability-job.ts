import {
  type Job,
  type JobHandler,
  type RepoGitStorage,
  type SliceResult,
  swapPacks,
} from "@fyrden/adapters-cloudflare/git";
import type { BlockCache, PackId } from "@fyrden/git-core";
import { newRunId } from "./ids.js";
import { MarkSession, markName } from "./mark.js";
import type { MaintenancePolicy } from "./policy.js";
import { decodeJson, deleteRun, encodeJson } from "./storage.js";

/*
 * Flags packs all-reachable (every object reachable from the current refs),
 * which is what lets a clone be served from the stored packs as they are
 *. It marks, from the ref tips, the own live packs not yet
 * flagged, walking only through those packs: what it marks is certainly
 * reachable, so a pack all of whose objects it marks is flagged. A pack a
 * push just added (whose objects hang off the new tips) is flagged this way
 * at the cost of its own size; after a non-fast-forward update, which
 * clears every flag, it is a full mark. The flags are written only if no
 * non-fast-forward update happened during the run.
 */

type Cursor = {
  readonly v: 1;
  readonly runId: string;
  readonly nonff: number;
  readonly sources: readonly PackId[];
  readonly seq: number;
};

const MARK = "reach";

export function reachabilityHandler(
  git: RepoGitStorage,
  policy: () => MaintenancePolicy,
  blocks?: () => BlockCache,
): JobHandler {
  return { runSlice: (job) => reachabilitySlice(git, policy(), job, blocks?.()) };
}

async function reachabilitySlice(
  git: RepoGitStorage,
  policy: MaintenancePolicy,
  job: Job,
  blocks: BlockCache | undefined,
): Promise<SliceResult> {
  const saved = decodeJson<Cursor>(job.cursor);
  const nonff = git.refStore.state().nonffVersion;
  if (saved && saved.nonff !== nonff) {
    // Flags cleared meanwhile: start over from the current refs.
    await deleteRun(git, saved.runId);
    return { done: false, cursor: null, runAfterMs: 0 };
  }
  let cursor = saved;
  if (!cursor) {
    const sources = git.context.storage.sql
      .exec<{ pack_id: string }>(
        `SELECT pack_id FROM packs WHERE state = 'live' AND origin = 'own' AND all_reachable = 0
         ORDER BY created_at DESC, pack_id DESC`,
      )
      .toArray()
      .map((r) => r.pack_id as PackId);
    if (sources.length === 0) return { done: true };
    cursor = { v: 1, runId: newRunId(git), nonff, sources, seq: 0 };
  }
  const live = git.registry.liveForFetch().map((p) => p.packId);
  if (!cursor.sources.every((id) => live.includes(id))) {
    // A source was replaced; the next run sees the new packs.
    await deleteRun(git, cursor.runId);
    return { done: false, cursor: null, runAfterMs: 0 };
  }
  let session: MarkSession;
  try {
    session = await openSession(git, policy, cursor, live, blocks);
  } catch (error) {
    // Failing again and again from its checkpoint (lost with a reset): start over.
    if (saved === undefined || job.attempts < 2) throw error;
    await deleteRun(git, saved.runId);
    return { done: false, cursor: null, runAfterMs: 0 };
  }
  try {
    if (cursor.seq === 0) session.mark.push([...git.refStore.readRefsSync().refs.values()]);
    if (!(await session.run())) {
      const next = { ...cursor, seq: cursor.seq + 1 };
      await session.save(markName(MARK, next.seq));
      if (cursor.seq > 1) await session.dropCheckpoint(markName(MARK, cursor.seq - 1));
      return { done: false, cursor: encodeJson(next), runAfterMs: 0 };
    }
    const full = session.sources
      .filter((p, i) => session.bits[i]?.count() === p.idx.count)
      .map((p) => p.packId);
    if (full.length > 0) {
      swapPacks(git, {
        remove: [],
        live: [],
        allReachable: { packIds: full, nonffVersion: cursor.nonff },
        respectLeases: false,
        waitForIndexing: false,
      });
      git.context.metrics.count(
        "git.maintenance",
        { job: "reachability", what: "all_reachable" },
        full.length,
      );
    }
  } finally {
    session.release();
  }
  await deleteRun(git, cursor.runId);
  return { done: true };
}

function openSession(
  git: RepoGitStorage,
  policy: MaintenancePolicy,
  cursor: Cursor,
  live: readonly PackId[],
  blocks: BlockCache | undefined,
): Promise<MarkSession> {
  return MarkSession.open(
    {
      git,
      policy,
      runId: cursor.runId,
      counter: { calls: 0 },
      ...(blocks ? { blocks } : {}),
      deadline: git.context.now() + policy.sliceMs,
    },
    cursor.sources,
    {
      outside: "stop",
      readerPacks: live,
      ...(cursor.seq > 0 ? { from: markName(MARK, cursor.seq) } : {}),
    },
  );
}
