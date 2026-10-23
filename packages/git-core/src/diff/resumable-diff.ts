import type { Oid } from "../object/oid.js";
import { oidEquals } from "../object/oid.js";
import { compareTreeEntries, isTreeMode, type TreeEntry } from "../object/tree.js";
import { DEFAULT_MAX_PATH_BYTES, type TreeChange, TreeDiffLimitError } from "./tree-diff.js";

/*
 * `diffTrees` in slices: each call lists changes from where the last one
 * stopped (a cursor), in the same order, until a budget stops it: changes
 * listed, tree entries read, or a tree its reader defers (`ReadDeferred`:
 * a budget of reads, bytes or memory the caller keeps). A call stops only
 * between entries, never inside one, so the cursor is a position in git's
 * tree order: the names of the directories it is in, and the last name
 * there, either handled (it and, for a directory, everything under it) or
 * a directory to enter from its first entry. Resuming reads the trees on
 * the cursor's path again and seeks each, by binary search, past what the
 * cursor passed: no change is listed twice or skipped.
 */

/** One name on a cursor's path, and whether it names a directory (git orders it as `name/`). */
export interface CursorName {
  readonly name: Uint8Array;
  readonly tree: boolean;
}

/**
 * Where a resumable diff got to: `path`'s last name was handled, or, with
 * `enter`, is a directory to enter from its first entry (`path` empty and
 * `enter`: from the start).
 */
export interface DiffCursor {
  readonly path: readonly CursorName[];
  readonly enter: boolean;
}

export interface ResumableDiffLimits {
  /** Changes one call lists at most; it stops right after the last. */
  readonly maxChanges: number;
  /** Tree entries one call reads at most (every entry of every tree read, the cursor's path's too). */
  readonly maxScanned: number;
  /** Directories deep a path may be; deeper fails with {@link TreeDiffLimitError}. */
  readonly maxDepth: number;
  /** The longest path, in bytes (`DEFAULT_MAX_PATH_BYTES` when not said). */
  readonly maxPathBytes?: number;
}

/** A change, with the cursor that resumes right after it. */
export interface ResumedChange extends TreeChange {
  readonly cursor: DiffCursor;
}

export interface ResumedDiff {
  readonly changes: readonly ResumedChange[];
  /** Where to resume; null once the diff is done. */
  readonly next: DiffCursor | null;
  /** What stopped it: nothing (`done`), or the budget it reached. */
  readonly stop: "done" | "changes" | "scanned" | "read";
  /** Entries read (every entry of every tree read). */
  readonly scanned: number;
  /** Trees read. */
  readonly trees: number;
}

/** Thrown by a resumable diff's reader to stop before a tree it will not read now. */
export class ReadDeferred extends Error {
  override name = "ReadDeferred";
}

/** The cursor of a diff not started yet. */
export const DIFF_START: DiffCursor = { path: [], enter: true };

const utf8 = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
const SLASH = 0x2f;
const FILE_MODE = 0o100644;
const TREE_MODE = 0o40000;

/** Stops the walk, with where to resume. */
class Stop {
  constructor(
    readonly stop: "changes" | "scanned" | "read",
    readonly next: DiffCursor,
  ) {}
}

/**
 * The changes from `oldTree` to `newTree` (null for an empty side) after
 * `from` (null: from the start), in `diffTrees`' order, until `limits`
 * stop it or the diff ends.
 */
export async function diffTreesFrom(
  readTree: (oid: Oid) => Promise<readonly TreeEntry[]>,
  oldTree: Oid | null,
  newTree: Oid | null,
  from: DiffCursor | null,
  limits: ResumableDiffLimits,
): Promise<ResumedDiff> {
  const maxPathBytes = limits.maxPathBytes ?? DEFAULT_MAX_PATH_BYTES;
  const start = from ?? DIFF_START;
  const changes: ResumedChange[] = [];
  /** The directories walked into. */
  const dirs: CursorName[] = [];
  let dirBytes = 0;
  let scanned = 0;
  let trees = 0;

  /** Both sides' entries, or a stop before reading them: resume entering `at`. */
  const read = async (
    oldOid: Oid | null,
    newOid: Oid | null,
    at: DiffCursor,
  ): Promise<[readonly TreeEntry[], readonly TreeEntry[]]> => {
    if (scanned >= limits.maxScanned) throw new Stop("scanned", at);
    const side = async (oid: Oid | null) => {
      if (oid === null) return [];
      try {
        const entries = await readTree(oid);
        trees++;
        scanned += entries.length;
        return entries;
      } catch (error) {
        if (error instanceof ReadDeferred) throw new Stop("read", at);
        throw error;
      }
    };
    return [await side(oldOid), await side(newOid)];
  };

  const pathOf = (name: Uint8Array): Uint8Array => {
    const out = new Uint8Array(dirBytes + name.length);
    let at = 0;
    for (const dir of dirs) {
      out.set(dir.name, at);
      at += dir.name.length;
      out[at++] = SLASH;
    }
    out.set(name, at);
    return out;
  };

  const emit = (change: Omit<TreeChange, "path" | "pathBytes">, name: Uint8Array) => {
    if (dirBytes + name.length > maxPathBytes) throw new TreeDiffLimitError("path", maxPathBytes);
    const pathBytes = pathOf(name);
    const cursor = { path: [...dirs, { name, tree: false }], enter: false };
    changes.push({ ...change, pathBytes, path: utf8.decode(pathBytes), cursor });
    if (changes.length >= limits.maxChanges) throw new Stop("changes", cursor);
  };

  /**
   * Walks directory pair (`oldOid`, `newOid`), the one `dirs` names, from
   * `tail` (the rest of the cursor's path below it, if it is on it).
   */
  const walk = async (
    oldOid: Oid | null,
    newOid: Oid | null,
    tail: readonly CursorName[] | null,
    enter: boolean,
  ): Promise<void> => {
    // On the cursor's path nothing new is reached yet: a stop there resumes where it started.
    const [olds, news] = await read(
      oldOid,
      newOid,
      tail !== null ? start : { path: [...dirs], enter: true },
    );
    let i = 0;
    let j = 0;
    const first = tail?.[0];
    if (first) {
      // Seek past what the cursor passed: entries ordered before its name were handled.
      const key: TreeEntry = {
        name: first.name,
        mode: first.tree ? TREE_MODE : FILE_MODE,
        oid: new Uint8Array(20) as Oid,
      };
      i = lowerBound(olds, key);
      j = lowerBound(news, key);
      const o = olds[i];
      const n = news[j];
      const atOld = o !== undefined && compareTreeEntries(o, key) === 0;
      const atNew = n !== undefined && compareTreeEntries(n, key) === 0;
      if (atOld) i++;
      if (atNew) j++;
      const below = (tail?.length ?? 0) > 1 || enter;
      // The cursor's own name: handled, unless the cursor goes on below it (or enters it).
      if ((atOld || atNew) && first.tree && below) {
        const before = atOld ? (o as TreeEntry) : null;
        const now = atNew ? (n as TreeEntry) : null;
        if (!(before && now && oidEquals(before.oid, now.oid)))
          await inside(first.name, () =>
            walk(before?.oid ?? null, now?.oid ?? null, (tail ?? []).slice(1), enter),
          );
      }
    }
    while (i < olds.length || j < news.length) {
      const o = olds[i];
      const n = news[j];
      const order = o === undefined ? 1 : n === undefined ? -1 : compareTreeEntries(o, n);
      if (order < 0) {
        i++;
        await whole("removed", o as TreeEntry);
        continue;
      }
      if (order > 0) {
        j++;
        await whole("added", n as TreeEntry);
        continue;
      }
      i++;
      j++;
      const before = o as TreeEntry;
      const now = n as TreeEntry;
      if (before.mode === now.mode && oidEquals(before.oid, now.oid)) continue;
      if (isTreeMode(before.mode)) {
        await inside(now.name, () => walk(before.oid, now.oid, null, false));
        continue;
      }
      emit(
        {
          status: kindOf(before.mode) === kindOf(now.mode) ? "modified" : "type_changed",
          oldMode: before.mode,
          newMode: now.mode,
          oldOid: before.oid,
          newOid: now.oid,
        },
        now.name,
      );
    }
  };

  /** One side's whole entry, as removals or additions. */
  const whole = async (side: "added" | "removed", entry: TreeEntry): Promise<void> => {
    if (isTreeMode(entry.mode)) {
      await inside(entry.name, () =>
        side === "added" ? walk(null, entry.oid, null, false) : walk(entry.oid, null, null, false),
      );
      return;
    }
    emit(
      side === "added"
        ? { status: "added", oldMode: null, newMode: entry.mode, oldOid: null, newOid: entry.oid }
        : {
            status: "removed",
            oldMode: entry.mode,
            newMode: null,
            oldOid: entry.oid,
            newOid: null,
          },
      entry.name,
    );
  };

  /** Walks into directory `name` for `body`, keeping the depth and path budgets. */
  const inside = async (name: Uint8Array, body: () => Promise<void>): Promise<void> => {
    if (dirs.length + 1 > limits.maxDepth) throw new TreeDiffLimitError("depth", limits.maxDepth);
    if (dirBytes + name.length + 1 > maxPathBytes)
      throw new TreeDiffLimitError("path", maxPathBytes);
    dirs.push({ name, tree: true });
    dirBytes += name.length + 1;
    try {
      await body();
    } finally {
      dirs.pop();
      dirBytes -= name.length + 1;
    }
  };

  try {
    await walk(oldTree, newTree, start.path.length > 0 ? start.path : null, start.enter);
    return { changes, next: null, stop: "done", scanned, trees };
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    return { changes, next: error.next, stop: error.stop, scanned, trees };
  }
}

/** The first index of `entries` (in git's tree order) not before `key`. */
function lowerBound(entries: readonly TreeEntry[], key: TreeEntry): number {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareTreeEntries(entries[mid] as TreeEntry, key) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The kind of thing a mode names: a file's executable bit is no change of kind. */
function kindOf(mode: number): "tree" | "link" | "submodule" | "file" {
  if (isTreeMode(mode)) return "tree";
  const type = mode & 0o170000;
  return type === 0o120000 ? "link" : type === 0o160000 ? "submodule" : "file";
}
