import type { RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import type { Oid, PackId } from "@fyrden/git-core";
import { type CallCounter, LoadedPacks } from "../maintenance/storage.js";
import { liveView } from "../pack-view.js";

/*
 * A push's dependencies are the packs its connectivity check found objects
 * in. Indexing notes them as it goes and records them when it ends
 * (`markIndexed`); a compaction that commits in between (another push's
 * tail merge, the pack-cap compaction, a view compaction) supersedes a
 * pack the push noted, and only rewrites the dependencies already recorded.
 * The pack's objects are still there, in the compacted pack, so before
 * recording them the push follows each superseded dependency to the packs
 * that now hold its objects.
 */

/** Whether any of `deps` was superseded (merged into another pack) since indexing noted it. */
export function anySuperseded(git: RepoGitStorage, deps: readonly PackId[]): boolean {
  return deps.some((id) => git.registry.get(id)?.state === "superseded");
}

/**
 * `deps` with each superseded pack replaced by the readable packs (live or
 * garbage) that together hold every one of its objects, as their indexes
 * show. A superseded pack whose objects are not all readable any more (or
 * whose index is gone) is kept as it is, so the commit refuses; any other
 * dependency is kept as it is too.
 */
export async function followSuperseded(
  git: RepoGitStorage,
  deps: readonly PackId[],
  counter: CallCounter,
  onRead: () => void,
): Promise<PackId[]> {
  const out = new Set<PackId>();
  for (const dep of deps) {
    const holders =
      git.registry.get(dep)?.state === "superseded"
        ? await holdersOf(git, dep, counter, onRead)
        : undefined;
    for (const id of holders ?? [dep]) out.add(id);
  }
  return [...out];
}

/** The readable packs holding every object of `packId`, or undefined when some object is in none. */
async function holdersOf(
  git: RepoGitStorage,
  packId: PackId,
  counter: CallCounter,
  onRead: () => void,
): Promise<PackId[] | undefined> {
  let loaded: LoadedPacks;
  try {
    loaded = await LoadedPacks.load(git, [packId], counter);
  } catch {
    // Its index is gone (the pack was retired meanwhile): the commit decides from its state.
    return undefined;
  }
  try {
    const idx = (loaded.packs[0] as (typeof loaded.packs)[number]).idx;
    let missing: Oid[] = Array.from({ length: idx.count }, (_, i) => idx.oidAt(i));
    const garbage = git.registry
      .inState("garbage")
      .filter((p) => p.bytes !== null)
      .map((p) => p.packId);
    const holders: PackId[] = [];
    for (const pack of liveView(git, onRead, garbage).packs) {
      if (missing.length === 0) break;
      const found = pack.idx.lookupMany
        ? await pack.idx.lookupMany(missing)
        : await Promise.all(missing.map((oid) => pack.idx.lookup(oid)));
      const rest = missing.filter((_, i) => !found[i]);
      if (rest.length < missing.length) holders.push(pack.packId);
      missing = rest;
    }
    return missing.length === 0 ? holders : undefined;
  } finally {
    loaded.release();
  }
}
