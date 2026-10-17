import type { Oid } from "../object/oid.js";
import { oidEquals } from "../object/oid.js";
import { compareTreeEntries, isTreeMode, type TreeEntry } from "../object/tree.js";

/*
 * What changed between two trees, file by file, in path order (git's tree
 * order, which is byte order of full paths). Subtrees with the same id on
 * both sides are skipped without reading them. A file replaced by a
 * directory of the same name (or the reverse) is a removal and additions,
 * as `git diff-tree -r` shows it; a file that changes kind (regular file,
 * symlink, submodule) keeps its path and is `type_changed`.
 */

export type TreeChangeStatus = "added" | "removed" | "modified" | "type_changed";

export interface TreeChange {
  readonly status: TreeChangeStatus;
  /** The path, decoded as UTF-8 (an invalid sequence shows as U+FFFD). */
  readonly path: string;
  /** The path's bytes, which order changes and resume a listing. */
  readonly pathBytes: Uint8Array;
  readonly oldMode: number | null;
  readonly newMode: number | null;
  readonly oldOid: Oid | null;
  readonly newOid: Oid | null;
}

export interface TreeDiffOptions {
  /** Trees one diff may read; past it the diff fails with {@link TreeDiffLimitError}. */
  readonly maxTrees?: number;
  /** The longest path, in bytes; a deeper one fails the diff with {@link TreeDiffLimitError}. */
  readonly maxPathBytes?: number;
  /** Changes one call returns; the rest are left for a call `after` the last one. */
  readonly maxChanges?: number;
  /** Only changes at paths after this one (bytes), to resume a listing. */
  readonly after?: Uint8Array;
}

export class TreeDiffLimitError extends Error {
  constructor(
    readonly limit: "trees" | "path",
    readonly value: number,
  ) {
    super(
      limit === "trees"
        ? `comparing the trees needs more than ${value} tree reads`
        : `a path is longer than ${value} bytes`,
    );
    this.name = "TreeDiffLimitError";
  }
}

/** Trees one diff reads at most when not told otherwise. Proposed. */
export const DEFAULT_MAX_TREES = 2_000;
/** The longest path a diff follows when not told otherwise, in bytes (Linux's PATH_MAX). */
export const DEFAULT_MAX_PATH_BYTES = 4_096;

// A leading byte order mark is part of the name: two names that differ by one stay apart.
const utf8 = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
const SLASH = 0x2f;

/** The kind of thing a mode names: a file's executable bit is no change of kind. */
function kindOf(mode: number): "tree" | "link" | "submodule" | "file" {
  if (isTreeMode(mode)) return "tree";
  const type = mode & 0o170000;
  return type === 0o120000 ? "link" : type === 0o160000 ? "submodule" : "file";
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return a.length - b.length;
}

/**
 * The changes from `oldTree` to `newTree` (null for an empty side), in
 * path order; `truncated` when `maxChanges` stopped the listing early.
 * The path being walked is kept as its names, joined only for a change
 * listed or a cursor compared, so a deep tree costs its depth, not its
 * depth squared.
 */
export async function diffTrees(
  readTree: (oid: Oid) => Promise<readonly TreeEntry[]>,
  oldTree: Oid | null,
  newTree: Oid | null,
  options: TreeDiffOptions = {},
): Promise<{ changes: TreeChange[]; truncated: boolean }> {
  const maxTrees = options.maxTrees ?? DEFAULT_MAX_TREES;
  const maxPathBytes = options.maxPathBytes ?? DEFAULT_MAX_PATH_BYTES;
  const maxChanges = options.maxChanges ?? Number.POSITIVE_INFINITY;
  const after = options.after;
  const changes: TreeChange[] = [];
  /** The directories walked into, by name. */
  const dirs: Uint8Array[] = [];
  /** Their joined length with a `/` after each. */
  let dirBytes = 0;
  let trees = 0;
  let truncated = false;

  const read = async (oid: Oid | null): Promise<readonly TreeEntry[]> => {
    if (oid === null) return [];
    if (++trees > maxTrees) throw new TreeDiffLimitError("trees", maxTrees);
    return readTree(oid);
  };

  /** The full path of `name` in the directory being walked, with `tail` after it. */
  const pathOf = (name: Uint8Array, tail?: number): Uint8Array => {
    const out = new Uint8Array(dirBytes + name.length + (tail === undefined ? 0 : 1));
    let at = 0;
    for (const dir of dirs) {
      out.set(dir, at);
      at += dir.length;
      out[at++] = SLASH;
    }
    out.set(name, at);
    if (tail !== undefined) out[at + name.length] = tail;
    return out;
  };

  /** Whether every path under directory `name` comes at or before the cursor: none to list. */
  const skipsDirectory = (name: Uint8Array) =>
    // Every path under it sorts below its name followed by the byte after `/`.
    after !== undefined && compareBytes(after, pathOf(name, SLASH + 1)) >= 0;

  /** Walks into directory `name` for `walk`, keeping the path budget. */
  const inside = async (name: Uint8Array, walk: () => Promise<boolean>): Promise<boolean> => {
    if (dirBytes + name.length + 1 > maxPathBytes)
      throw new TreeDiffLimitError("path", maxPathBytes);
    dirs.push(name);
    dirBytes += name.length + 1;
    try {
      return await walk();
    } finally {
      dirs.pop();
      dirBytes -= name.length + 1;
    }
  };

  const emit = (change: Omit<TreeChange, "path" | "pathBytes">, name: Uint8Array): boolean => {
    if (dirBytes + name.length > maxPathBytes) throw new TreeDiffLimitError("path", maxPathBytes);
    const pathBytes = pathOf(name);
    if (after && compareBytes(pathBytes, after) <= 0) return true;
    if (changes.length >= maxChanges) {
      truncated = true;
      return false;
    }
    changes.push({ ...change, pathBytes, path: utf8.decode(pathBytes) });
    return true;
  };

  /** One side's whole entry as additions or removals; false once the listing is full. */
  const whole = async (side: "added" | "removed", entry: TreeEntry): Promise<boolean> => {
    if (isTreeMode(entry.mode)) {
      if (skipsDirectory(entry.name)) return true;
      const children = await read(entry.oid);
      return inside(entry.name, async () => {
        for (const child of children) if (!(await whole(side, child))) return false;
        return true;
      });
    }
    return emit(
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

  const walk = async (oldOid: Oid | null, newOid: Oid | null): Promise<boolean> => {
    const [olds, news] = await Promise.all([read(oldOid), read(newOid)]);
    let i = 0;
    let j = 0;
    while (i < olds.length || j < news.length) {
      const o = olds[i];
      const n = news[j];
      const order = o === undefined ? 1 : n === undefined ? -1 : compareTreeEntries(o, n);
      if (order < 0) {
        i++;
        if (!(await whole("removed", o as TreeEntry))) return false;
        continue;
      }
      if (order > 0) {
        j++;
        if (!(await whole("added", n as TreeEntry))) return false;
        continue;
      }
      i++;
      j++;
      const before = o as TreeEntry;
      const now = n as TreeEntry;
      if (before.mode === now.mode && oidEquals(before.oid, now.oid)) continue;
      if (isTreeMode(before.mode)) {
        // Both are trees (equal order means equal kind of name).
        if (skipsDirectory(now.name)) continue;
        if (!(await inside(now.name, () => walk(before.oid, now.oid)))) return false;
        continue;
      }
      const status = kindOf(before.mode) === kindOf(now.mode) ? "modified" : "type_changed";
      const change = {
        status,
        oldMode: before.mode,
        newMode: now.mode,
        oldOid: before.oid,
        newOid: now.oid,
      } as const;
      if (!emit(change, now.name)) return false;
    }
    return true;
  };

  await walk(oldTree, newTree);
  return { changes, truncated };
}
