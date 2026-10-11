import { type RepoGitStorage, schedulePackRetire } from "@fyrden/adapters-cloudflare/git";
import type { BlockCache, PackId } from "@fyrden/git-core";
import { newRunId } from "../git/maintenance/ids.js";
import type { MaintenancePolicy } from "../git/maintenance/policy.js";
import {
  type RewriteOutcome,
  type RewriteState,
  rewriteSlice,
} from "../git/maintenance/rewrite.js";
import { deleteRun } from "../git/maintenance/storage.js";
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
    storage.sql
      .exec("DELETE FROM leases WHERE pack_id = ? AND holder = 'view-cap'", output)
      .toArray();
  });
  schedulePackRetire(git.jobs, git.context.now());
  const out = liveViewPacks(git).find((p) => p.packId === output);
  if (!out) throw new Error(`compacted pack ${output} is not in the view`);
  return out;
}
