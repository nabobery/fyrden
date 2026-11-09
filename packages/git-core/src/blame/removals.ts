import { type Oid, oidEquals } from "../object/oid.js";
import { compareTreeEntries, isTreeMode, type TreeEntry, treeEntries } from "../object/tree.js";
import type { BlameSource } from "./walk.js";

/** Trees one step's rename checks may queue, across all its parents. */
export const MAX_RENAME_CHECK_TREES = 256;
/** Tree bytes one step's rename checks may read, across all its parents. */
export const MAX_RENAME_CHECK_BYTES = 8 * 1024 * 1024;

/** What a step's rename checks have left; its parents' checks share it. */
export interface RenameCheckBudget {
  trees: number;
  bytes: number;
}

export const renameCheckBudget = (): RenameCheckBudget => ({
  trees: MAX_RENAME_CHECK_TREES,
  bytes: MAX_RENAME_CHECK_BYTES,
});

/**
 * What going from one tree to another removes. A removal is a non-tree entry
 * (a file, symlink or submodule) at a path where the newer tree has no entry
 * of its type: deleted, changed in type, or inside a directory that's gone or
 * became something else. "unknown": the budget ran out first.
 */
export type Removals = "none" | "some" | "identical" | "unknown";

const TYPE_BITS = 0o170000;

/** A tree pair still to compare, or a removed tree whose entries are all removals. Oids are copies. */
type Frame = { readonly old: Oid; readonly new?: Oid };

/**
 * Compares `from` with `to`, reading only trees whose oids differ.
 *
 * Without `identical`, it answers "some" at the first removal, and a removed
 * directory counts without being read: the caller refuses the whole step
 * either way. With it, removed directories are read too, and it answers
 * "identical" at a removed entry with that oid: a removal git could pair as
 * an identical rename, which takes every line of a merge.
 *
 * Each tree queued spends one of the budget's trees, when queued, so nothing
 * waits that couldn't be read. A tree larger than the bytes left isn't read.
 * A tree that doesn't parse throws `GitObjectError`.
 */
export async function removals(
  source: BlameSource,
  from: Oid,
  to: Oid,
  identical: Oid | undefined,
  budget: RenameCheckBudget,
  spend: (work: number) => void,
): Promise<Removals> {
  if (oidEquals(from, to)) return "none";
  const stack: Frame[] = [];
  const queue = (frame: Frame): boolean => {
    const cost = frame.new ? 2 : 1;
    if (budget.trees < cost) return false;
    budget.trees -= cost;
    stack.push(frame);
    return true;
  };
  const read = async (oid: Oid): Promise<Uint8Array | undefined> => {
    const body = await source.tree(oid, budget.bytes);
    if (body === "too_large") return undefined;
    budget.bytes -= body.length;
    return body;
  };
  if (!queue({ old: from.slice() as Oid, new: to.slice() as Oid })) return "unknown";

  let found: "none" | "some" = "none";
  // Answers for one removed entry: undefined to go on.
  const removed = (entry: TreeEntry): Removals | undefined => {
    if (isTreeMode(entry.mode)) {
      if (!identical) return "some";
      return queue({ old: entry.oid.slice() as Oid }) ? undefined : "unknown";
    }
    if (identical && oidEquals(entry.oid, identical)) return "identical";
    if (!identical) return "some";
    found = "some";
    return undefined;
  };

  for (let frame = stack.pop(); frame; frame = stack.pop()) {
    const oldBody = await read(frame.old);
    if (!oldBody) return "unknown";
    const newBody = frame.new ? await read(frame.new) : undefined;
    if (frame.new && !newBody) return "unknown";
    const answer = newBody
      ? comparePair(oldBody, newBody, removed, queue)
      : walkRemoved(oldBody, removed);
    spend(Math.floor((oldBody.length + (newBody?.length ?? 0)) / 8) + answer.entries);
    if (answer.result !== undefined) return answer.result;
  }
  return found;
}

/** Walks a removed tree: every entry is a removal. */
function walkRemoved(
  body: Uint8Array,
  removed: (entry: TreeEntry) => Removals | undefined,
): { result: Removals | undefined; entries: number } {
  let entries = 0;
  for (const entry of treeEntries(body)) {
    entries++;
    const result = removed(entry);
    if (result !== undefined) return { result, entries };
  }
  return { result: undefined, entries };
}

/** Merge-walks two trees in git's order, queueing differing directories present on both sides. */
function comparePair(
  oldBody: Uint8Array,
  newBody: Uint8Array,
  removed: (entry: TreeEntry) => Removals | undefined,
  queue: (frame: Frame) => boolean,
): { result: Removals | undefined; entries: number } {
  const olds = treeEntries(oldBody);
  const news = treeEntries(newBody);
  let a = olds.next();
  let b = news.next();
  let entries = 0;
  while (!a.done) {
    entries++;
    const order = b.done ? -1 : compareTreeEntries(a.value, b.value);
    if (order > 0) {
      // Only in the newer tree: an addition, nothing removed.
      b = news.next();
      continue;
    }
    if (order < 0) {
      const result = removed(a.value);
      if (result !== undefined) return { result, entries };
      a = olds.next();
      continue;
    }
    const older = a.value;
    const newer = (b as IteratorYieldResult<TreeEntry>).value;
    if (!oidEquals(older.oid, newer.oid)) {
      if ((older.mode & TYPE_BITS) !== (newer.mode & TYPE_BITS)) {
        const result = removed(older);
        if (result !== undefined) return { result, entries };
      } else if (
        isTreeMode(older.mode) &&
        !queue({ old: older.oid.slice() as Oid, new: newer.oid.slice() as Oid })
      ) {
        return { result: "unknown", entries };
      }
    } else if ((older.mode & TYPE_BITS) !== (newer.mode & TYPE_BITS)) {
      const result = removed(older);
      if (result !== undefined) return { result, entries };
    }
    a = olds.next();
    b = news.next();
  }
  return { result: undefined, entries };
}
