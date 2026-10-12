/*
 * Ref namespace conflicts. git's files ref backend stores `refs/heads/a` as
 * a file and `refs/heads/a/b` below a directory of the same name, so the two
 * cannot both exist; git refuses to create either while the other exists
 * (refs.c `refs_verify_refname_available`, git v2.53.0, verified). A server
 * that let both exist would advertise refs a client cannot store.
 */

/** Existing refs, as a ref store can look them up. */
export interface RefNamespace {
  has(name: string): boolean;
  /** Up to `limit` existing refs whose names start with `name + "/"`, in any order. */
  below(name: string, limit: number): readonly string[];
}

/** One ref creation the namespace refuses, and the ref it collides with. */
export interface RefnameConflict {
  readonly ref: string;
  readonly conflictsWith: string;
  /** True when `conflictsWith` is created by the same request rather than an existing ref. */
  readonly inRequest: boolean;
}

export interface NamespaceUpdate {
  readonly name: string;
  /** null: the ref does not exist yet (a creation, once its compare-and-set holds). */
  readonly oldOid: unknown;
  /** null: the ref is deleted. */
  readonly newOid: unknown;
}

/** The names `name` would need as directories: "refs/heads/a/b" gives "refs/heads" and "refs/heads/a". */
export function refParents(name: string): string[] {
  const parents: string[] = [];
  for (let i = name.indexOf("/", "refs/".length); i !== -1; i = name.indexOf("/", i + 1)) {
    parents.push(name.slice(0, i));
  }
  return parents;
}

/**
 * The creations among `updates` that the namespace refuses, in name order.
 * Deletions in the same request free their names. A creation collides with
 * an existing ref above or below it that is not deleted; between two
 * creations in one request, the upper one is refused and the lower one may
 * proceed, as git's batched transaction decides. Updates of existing refs
 * never collide: their names already fit. Callers that need every update or
 * none (an atomic transaction) refuse on any result.
 */
export function refnameConflicts(
  updates: readonly NamespaceUpdate[],
  existing: RefNamespace,
): RefnameConflict[] {
  const deleted = new Set<string>();
  const created: string[] = [];
  for (const update of updates) {
    if (update.newOid === null) deleted.add(update.name);
    else if (update.oldOid === null) created.push(update.name);
  }
  if (created.length === 0) return [];
  created.sort(compareNames);
  const stays = (name: string) => !deleted.has(name) && existing.has(name);

  const conflicts = new Map<string, RefnameConflict>();
  for (const name of created) {
    const parent = refParents(name).find(stays);
    if (parent !== undefined) {
      conflicts.set(name, { ref: name, conflictsWith: parent, inRequest: false });
      continue;
    }
    const child = existing.below(name, deleted.size + 1).find((n) => !deleted.has(n));
    if (child !== undefined)
      conflicts.set(name, { ref: name, conflictsWith: child, inRequest: false });
  }
  // Among the creations that remain, a lower one goes ahead and the upper one is refused.
  const remaining = created.filter((name) => !conflicts.has(name));
  for (const name of remaining) {
    const below = firstWithPrefix(remaining, `${name}/`);
    if (below !== undefined)
      conflicts.set(name, { ref: name, conflictsWith: below, inRequest: true });
  }
  return [...conflicts.values()].sort((a, b) => compareNames(a.ref, b.ref));
}

/** A namespace over names held in memory (sorted once; lookups by binary search). */
export function sortedRefNamespace(names: Iterable<string>): RefNamespace {
  const sorted = [...names].sort(compareNames);
  const set = new Set(sorted);
  return {
    has: (name) => set.has(name),
    below(name, limit) {
      const prefix = `${name}/`;
      const found: string[] = [];
      for (let i = lowerBound(sorted, prefix); i < sorted.length && found.length < limit; i++) {
        const candidate = sorted[i] as string;
        if (!candidate.startsWith(prefix)) break;
        found.push(candidate);
      }
      return found;
    },
  };
}

function firstWithPrefix(sorted: readonly string[], prefix: string): string | undefined {
  const candidate = sorted[lowerBound(sorted, prefix)];
  return candidate?.startsWith(prefix) ? candidate : undefined;
}

/** Code-unit order: names that share a prefix sort next to each other. */
function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function lowerBound(sorted: readonly string[], key: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] as string) < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
