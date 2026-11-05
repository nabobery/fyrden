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
 * A retirement pass may condemn that pack before indexing ends, too. The
 * pack's objects are still there, in the compacted pack, so before
 * recording them the push follows each dependency no longer readable to the
 * packs that now hold its objects.
 */

/** Superseded by a compaction, or condemned after it (or by a collection). */
const MERGED_AWAY: ReadonlySet<string> = new Set(["superseded", "condemned"]);

/**
 * The source pack's objects are looked up this many at a time, in index
 * order (each slice falls in a few fanout buckets of every holder): what a
 * lookup allocates per object stays bounded however large the pack.
 * Proposed.
 */
const LOOKUP_SLICE = 4096;

const mergedAway = (git: RepoGitStorage, id: PackId) =>
  MERGED_AWAY.has(git.registry.get(id)?.state ?? "");

/** Whether any of `deps` was merged away or condemned since indexing noted it. */
export function anyMergedAway(git: RepoGitStorage, deps: readonly PackId[]): boolean {
  return deps.some((id) => mergedAway(git, id));
}

/**
 * `deps` with each pack merged away or condemned replaced by the readable
 * packs (live or garbage) that together hold every one of its objects, as
 * their indexes show. One whose objects are not all readable any more (or
 * whose index is gone) is kept as it is, so the commit refuses; any other
 * dependency is kept as it is too.
 */
export async function followMergedAway(
  git: RepoGitStorage,
  deps: readonly PackId[],
  counter: CallCounter,
  onRead: () => void,
): Promise<PackId[]> {
  const out = new Set<PackId>();
  for (const dep of deps) {
    const holders = mergedAway(git, dep) ? await holdersOf(git, dep, counter, onRead) : undefined;
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
    const garbage = git.registry
      .inState("garbage")
      .filter((p) => p.bytes !== null)
      .map((p) => p.packId);
    const packs = liveView(git, onRead, garbage).packs;
    const holders = new Set<PackId>();
    for (let start = 0; start < idx.count; start += LOOKUP_SLICE) {
      let missing: Oid[] = [];
      for (let i = start; i < Math.min(start + LOOKUP_SLICE, idx.count); i++)
        missing.push(idx.oidAt(i));
      for (const pack of packs) {
        if (missing.length === 0) break;
        const found = pack.idx.lookupMany
          ? await pack.idx.lookupMany(missing)
          : await Promise.all(missing.map((oid) => pack.idx.lookup(oid)));
        const rest = missing.filter((_, i) => !found[i]);
        if (rest.length < missing.length) holders.add(pack.packId);
        missing = rest;
      }
      if (missing.length > 0) return undefined;
    }
    return [...holders];
  } finally {
    loaded.release();
  }
}
