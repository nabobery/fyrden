import type { Oid, PackId } from "@fyrden/git-core";
import type { LockHandle } from "./locks.js";
import { FINISHED_STATES } from "./pack-registry.js";
import type { RepoGitStorage } from "./repo-git-storage.js";
import { blob, chunks, countRowsWritten, first, placeholders, rows, run } from "./sql.js";

/**
 * What one repack or garbage-collection run changes in the registry, in one
 * transaction. Outputs are packs the run wrote and
 * finished (`indexing`, with their `.idx` stored).
 */
export interface PackSwap {
  /** Live packs the outputs replace (whole pack units): they become `superseded`. */
  readonly remove: readonly PackId[];
  /** Outputs that go live. */
  readonly live: readonly PackId[];
  /** Outputs holding unreachable objects: they become `garbage`. */
  readonly garbage?: readonly PackId[];
  /** Garbage packs past their time to live with nothing reachable in them: `condemned`. */
  readonly condemn?: readonly PackId[];
  /** Garbage packs some of whose objects were found reachable again: touched now. */
  readonly touch?: readonly PackId[];
  /**
   * Borrowed live packs (a fork network's packs) of which this repository
   * reaches no object any more: they become `garbage` here, and are
   * condemned by a later run after the garbage time to live. Their bytes
   * are the network's; this repository only stops reading them.
   */
  readonly dropBorrowed?: readonly PackId[];
  /** Borrowed garbage packs some of whose objects are reachable again: back to `live`. */
  readonly rescueBorrowed?: readonly PackId[];
  /** Commit-graph rows of commits that only condemned packs hold. */
  readonly dropCommits?: readonly Oid[];
  /**
   * Packs (live, or outputs going live) whose every object the refs reached
   * when `nonffVersion` was current. Flagged only if no non-fast-forward
   * update happened since (a fast-forward cannot make an object unreachable).
   */
  readonly allReachable?: { readonly packIds: readonly PackId[]; readonly nonffVersion: number };
  /** The outputs that go live hold exactly the removed packs' objects: they inherit the flag when every removed pack has it. */
  readonly inheritAllReachable?: boolean;
  /** Refuse while a removed pack has an unexpired lease. */
  readonly respectLeases: boolean;
  /** Refuse while an upload is being indexed (its dependencies may name removed packs). */
  readonly waitForIndexing: boolean;
  /**
   * What the swap was decided under: refused (`refs-moved`) unless `lock`
   * is still held and the refs are still at `refsVersion`, checked inside
   * the transaction. A swap decided from reachability marks needs both: a
   * lock that expired during an await let a push move the refs since.
   */
  readonly fence?: { readonly lock: LockHandle; readonly refsVersion: number };
}

export type PackSwapResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /**
       * `packs-changed`: a removed pack is no longer live, or an output is
       * not finished; `refs-moved`: the `fence` no longer holds.
       */
      readonly reason: "leased" | "indexing" | "packs-changed" | "refs-moved";
    };

/**
 * Applies a swap, or nothing. Uploads not yet committed that depend on a
 * removed pack depend on the outputs instead: their objects are in them (a
 * dependency on a garbage output rescues it when the upload commits).
 */
export function swapPacks(git: RepoGitStorage, swap: PackSwap): PackSwapResult {
  const { storage } = git.context;
  const now = git.context.now();
  const outcome = storage.transactionSync((): { result: PackSwapResult; written: number } => {
    const refuse = (reason: "leased" | "indexing" | "packs-changed" | "refs-moved") => ({
      result: { ok: false as const, reason },
      written: 0,
    });
    if (
      swap.fence &&
      (!git.locks.isHeld(swap.fence.lock) ||
        git.refStore.state().version !== swap.fence.refsVersion)
    )
      return refuse("refs-moved");
    for (const packId of swap.remove)
      if (git.registry.get(packId)?.state !== "live") return refuse("packs-changed");
    for (const packId of [...swap.live, ...(swap.garbage ?? [])]) {
      const state = git.registry.get(packId)?.state;
      if (!state || !FINISHED_STATES.includes(state)) return refuse("packs-changed");
    }
    for (const packId of swap.condemn ?? [])
      if (git.registry.get(packId)?.state !== "garbage") return refuse("packs-changed");
    for (const packId of swap.dropBorrowed ?? [])
      if (borrowedState(git, packId) !== "live") return refuse("packs-changed");
    for (const packId of swap.rescueBorrowed ?? [])
      if (borrowedState(git, packId) !== "garbage") return refuse("packs-changed");
    if (swap.respectLeases && git.leases.leased(swap.remove).size > 0) return refuse("leased");
    if (
      swap.waitForIndexing &&
      first(storage, "SELECT 1 AS one FROM uploads WHERE state = 'indexing' LIMIT 1")
    )
      return refuse("indexing");

    const inherit =
      swap.inheritAllReachable === true &&
      swap.remove.length > 0 &&
      swap.remove.every((id) => flagged(git, id));
    let written = 0;
    for (const packId of swap.remove)
      written += git.registry.transition(packId, ["live"], "superseded");
    for (const packId of swap.live)
      written += git.registry.transition(packId, FINISHED_STATES, "live");
    for (const packId of swap.garbage ?? [])
      written += git.registry.transition(packId, FINISHED_STATES, "garbage");
    for (const packId of swap.condemn ?? [])
      written += git.registry.transition(packId, ["garbage"], "condemned");
    for (const packId of swap.dropBorrowed ?? [])
      written += git.registry.transition(packId, ["live"], "garbage");
    for (const packId of swap.rescueBorrowed ?? [])
      written += git.registry.transition(packId, ["garbage"], "live");
    for (const batch of chunks(swap.touch ?? [])) {
      written += run(
        storage,
        `UPDATE packs SET last_touched_at = ? WHERE state = 'garbage'
         AND pack_id IN (${placeholders(batch.length)})`,
        now,
        ...batch,
      );
    }
    for (const batch of chunks(swap.dropCommits ?? [])) {
      written += run(
        storage,
        `DELETE FROM commits WHERE oid IN (${placeholders(batch.length)})`,
        ...batch.map((oid) => blob(oid)),
      );
    }
    written += rewriteDependencies(git, swap);
    const version = git.refStore.state();
    const flag = [
      ...(swap.allReachable && swap.allReachable.nonffVersion === version.nonffVersion
        ? swap.allReachable.packIds
        : []),
      ...(inherit ? swap.live : []),
    ];
    for (const batch of chunks(flag)) {
      written += run(
        storage,
        `UPDATE packs SET all_reachable = 1, reachable_as_of = ?
         WHERE state = 'live' AND pack_id IN (${placeholders(batch.length)})`,
        version.version,
        ...batch,
      );
    }
    return { result: { ok: true }, written };
  });
  countRowsWritten(git.context, "maintenance.swap", outcome.written);
  return outcome.result;
}

/** The state of a borrowed pack's row; undefined when the pack is not a borrowed one. */
function borrowedState(git: RepoGitStorage, packId: PackId): string | undefined {
  return first<{ state: string }>(
    git.context.storage,
    "SELECT state FROM packs WHERE pack_id = ? AND origin = 'borrowed'",
    packId,
  )?.state;
}

function flagged(git: RepoGitStorage, packId: PackId): boolean {
  return (
    first<{ all_reachable: number }>(
      git.context.storage,
      "SELECT all_reachable FROM packs WHERE pack_id = ?",
      packId,
    )?.all_reachable === 1
  );
}

/** Replaces removed packs in the dependencies of uploads not yet committed. */
function rewriteDependencies(git: RepoGitStorage, swap: PackSwap): number {
  if (swap.remove.length === 0) return 0;
  const removed = new Set<string>(swap.remove);
  const outputs = [...swap.live, ...(swap.garbage ?? [])];
  let written = 0;
  for (const upload of rows<{ upload_id: string; deps: string }>(
    git.context.storage,
    "SELECT upload_id, deps FROM uploads WHERE state IN ('open', 'indexing', 'indexed')",
  )) {
    const deps = JSON.parse(upload.deps) as string[];
    if (!deps.some((d) => removed.has(d))) continue;
    const next = [...new Set([...deps.filter((d) => !removed.has(d)), ...outputs])];
    written += run(
      git.context.storage,
      "UPDATE uploads SET deps = ? WHERE upload_id = ?",
      JSON.stringify(next),
      upload.upload_id,
    );
  }
  return written;
}
