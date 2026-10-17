import { oidToHex } from "../object/oid.js";
import type { TreeChange } from "./tree-diff.js";

/** A change of a diff with renames found: a tree change, or a file moved with its content. */
export type DiffEntry =
  | TreeChange
  | (Omit<TreeChange, "status"> & {
      readonly status: "renamed";
      /** Where the file was. */
      readonly previousPath: string;
      readonly previousPathBytes: Uint8Array;
      /** The share of the content kept, 0-100 (100 for an exact rename). */
      readonly similarity: number;
    });

const SLASH = 0x2f;

/** A path's last component's bytes, as a map key. */
function baseKey(path: Uint8Array): string {
  return String.fromCharCode(...path.subarray(path.lastIndexOf(SLASH) + 1));
}

/** A list taken from the front, skipping what another list took. */
class Queue {
  readonly items: TreeChange[] = [];
  next = 0;

  /** The first item not in `taken`; undefined when none is left. */
  peek(taken: ReadonlySet<TreeChange>): TreeChange | undefined {
    while (this.next < this.items.length && taken.has(this.items[this.next] as TreeChange))
      this.next++;
    return this.items[this.next];
  }
}

/** Removed files of one content and kind, in path order, taken as they pair. */
class Candidates {
  readonly #all = new Queue();
  readonly #byBase = new Map<string, Queue>();
  readonly #taken = new Set<TreeChange>();

  add(change: TreeChange): void {
    this.#all.items.push(change);
    const base = baseKey(change.pathBytes);
    let queue = this.#byBase.get(base);
    if (!queue) {
      queue = new Queue();
      this.#byBase.set(base, queue);
    }
    queue.items.push(change);
  }

  /** The first free one with `base` as its last component, else the first free one; undefined when none is left. */
  take(base: string): TreeChange | undefined {
    const found = this.#byBase.get(base)?.peek(this.#taken) ?? this.#all.peek(this.#taken);
    if (found) this.#taken.add(found);
    return found;
  }
}

/**
 * `changes` with exact renames found: a removed file and an added one with
 * the same content and kind become one rename, placed where the added file
 * was. Among several removed files with that content, one with the same
 * last path component (compared as bytes) is preferred, else the first in
 * path order. Pairing by content id costs no reads, and each pairing a
 * constant amount of work. With more than 100 such files, git may pair a
 * different one (git-core is tested against git below that).
 */
export function findExactRenames(changes: readonly TreeChange[]): DiffEntry[] {
  const removed = new Map<string, Candidates>();
  for (const change of changes) {
    if (change.status !== "removed" || !change.oldOid) continue;
    const k = key(change.oldOid, change.oldMode);
    let candidates = removed.get(k);
    if (!candidates) {
      candidates = new Candidates();
      removed.set(k, candidates);
    }
    candidates.add(change);
  }
  const paired = new Set<TreeChange>();
  const renames = new Map<TreeChange, TreeChange>();
  for (const change of changes) {
    if (change.status !== "added" || !change.newOid) continue;
    const from = removed.get(key(change.newOid, change.newMode))?.take(baseKey(change.pathBytes));
    if (!from) continue;
    paired.add(from);
    renames.set(change, from);
  }
  const out: DiffEntry[] = [];
  for (const change of changes) {
    if (paired.has(change)) continue;
    const from = renames.get(change);
    out.push(
      from
        ? {
            ...change,
            status: "renamed",
            oldMode: from.oldMode,
            oldOid: from.oldOid,
            previousPath: from.path,
            previousPathBytes: from.pathBytes,
            similarity: 100,
          }
        : change,
    );
  }
  return out;
}

/** Content and kind: a file renamed to a symlink with the same bytes is no rename. */
function key(oid: Uint8Array, mode: number | null): string {
  return `${oidToHex(oid as never)} ${(mode ?? 0) & 0o170000}`;
}
