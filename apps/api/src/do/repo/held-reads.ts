import {
  type MemoryBudget,
  type ObjectReader,
  type Oid,
  oidToHex,
  parseTree,
  type TreeEntry,
} from "@fyrden/git-core";

/*
 * Reads of trees, files and commits for one piece of work (a merge, a
 * pull request's file listing): each object's size is checked from its
 * header before its body is read, and the memory its body and what is
 * parsed from it take is held from the repository object's budget until
 * the work is done. A tree read once is kept for the work's other reads.
 */

/** The smallest tree entry: mode, space, a one-byte name, NUL, a 20-byte id. */
const MIN_TREE_ENTRY_BYTES = 28;

/**
 * Memory held per entry a tree read may hold (its parsed entry, name and
 * id, a caller's map slot; measured near 520 bytes with short names), for
 * the smallest entry a tree can have.
 */
export const TREE_ENTRY_MEMORY_BYTES = 640;

/**
 * Memory held for a tree of `size` bytes before it is parsed: three times
 * its bytes (its body, and a copy a write or a cache makes of it), and
 * each entry it may have.
 */
export function treeMemoryBytes(size: number): number {
  return 3 * size + Math.ceil(size / MIN_TREE_ENTRY_BYTES) * TREE_ENTRY_MEMORY_BYTES;
}

/** An object the work needs cannot be read (gone, or not what it should be). */
export class UnreadableObjectError extends Error {
  override name = "UnreadableObjectError";
}

/** The work would read more, or larger objects, than its limits allow, or hold more memory than is free. */
export class ReadsTooLargeError extends Error {
  override name = "ReadsTooLargeError";
}

/**
 * The work's bytes are spent, or the memory a read needs is not free now:
 * the read might succeed in another piece of work (one that cannot be split
 * may treat it as `ReadsTooLargeError`, which it is).
 */
export class ReadsBudgetSpent extends ReadsTooLargeError {
  override name = "ReadsBudgetSpent";
}

/** The memory a read needs is held by other work now: the same read may succeed shortly. */
export class ReadsMemoryBusy extends ReadsBudgetSpent {
  override name = "ReadsMemoryBusy";
}

export interface HeldReadLimits {
  /** The largest tree or commit read, in bytes. */
  readonly maxTreeBytes: number;
  /** Bytes of the objects read, in all. */
  readonly maxReadBytes: number;
  /**
   * Bytes read so far, shared with other scopes of the same work (each
   * holding its memory only while it runs): `maxReadBytes` bounds them all.
   */
  readonly spent?: { readBytes: number };
}

export interface HeldReads {
  readTree(oid: Oid): Promise<readonly TreeEntry[]>;
  /** A blob's bytes, or undefined when it is larger than `maxBytes` (its body is not read). */
  readBlob(oid: Oid, maxBytes: number): Promise<Uint8Array | undefined>;
  readCommit(oid: Oid): Promise<Uint8Array>;
}

/**
 * Runs `use` with reads through `reader` within `limits`, their memory
 * held from `memory` until `use` is done and every read it started has
 * settled.
 */
export async function withHeldReads<T>(
  reader: Pick<ObjectReader, "readHeader" | "readObject">,
  memory: Pick<MemoryBudget, "tryReserve">,
  limits: HeldReadLimits,
  use: (reads: HeldReads) => Promise<T>,
): Promise<T> {
  const holds: { release(): void }[] = [];
  const trees = new Map<string, readonly TreeEntry[]>();
  const spent = limits.spent ?? { readBytes: 0 };
  // Set once `use` is done: a read still under way then holds and parses nothing.
  let done = false;
  // Reads under way: cleanup waits for them before it lets their memory go.
  const pending = new Set<Promise<unknown>>();
  const tracked = <R>(read: () => Promise<R>): Promise<R> => {
    if (done) return Promise.reject(new UnreadableObjectError());
    const running = read();
    pending.add(running);
    void running.then(
      () => pending.delete(running),
      () => pending.delete(running),
    );
    return running;
  };
  const hold = (read: number, bytes: number) => {
    spent.readBytes += read;
    if (spent.readBytes > limits.maxReadBytes) throw new ReadsBudgetSpent();
    let held: { release(): void } | undefined;
    try {
      held = memory.tryReserve(Math.max(1, bytes));
    } catch (error) {
      // More than the object's whole budget: never readable here.
      if (!(error instanceof RangeError)) throw error;
      throw new ReadsTooLargeError();
    }
    if (!held) throw new ReadsMemoryBusy();
    if (done) {
      held.release();
      throw new UnreadableObjectError();
    }
    holds.push(held);
  };
  /** An object's body, which must be of `type` (its memory already held). */
  const body = async (oid: Oid, type: "tree" | "blob" | "commit"): Promise<Uint8Array> => {
    const object = await reader.readObject(oid);
    if (done || object?.type !== type) throw new UnreadableObjectError();
    return object.bytes;
  };
  const reads: HeldReads = {
    readTree: (oid) =>
      tracked(async () => {
        const hex = oidToHex(oid);
        const known = trees.get(hex);
        if (known) return known;
        const header = await reader.readHeader(oid);
        if (header?.type !== "tree") throw new UnreadableObjectError();
        if (header.size > limits.maxTreeBytes) throw new ReadsTooLargeError();
        hold(header.size, treeMemoryBytes(header.size));
        const entries = parseTree(await body(oid, "tree")).value;
        trees.set(hex, entries);
        return entries;
      }),
    readBlob: (oid, maxBytes) =>
      tracked(async () => {
        const header = await reader.readHeader(oid);
        if (header?.type !== "blob") throw new UnreadableObjectError();
        if (header.size > maxBytes) return undefined;
        // The bytes, and the lines a merge splits them into.
        hold(header.size, 3 * header.size);
        return body(oid, "blob");
      }),
    readCommit: (oid) =>
      tracked(async () => {
        const header = await reader.readHeader(oid);
        if (header?.type !== "commit") throw new UnreadableObjectError();
        if (header.size > limits.maxTreeBytes) throw new ReadsTooLargeError();
        hold(header.size, 2 * header.size);
        return body(oid, "commit");
      }),
  };
  try {
    return await use(reads);
  } finally {
    done = true;
    // A sibling read (a merge reads three trees at once) may still be under way.
    while (pending.size > 0) await Promise.allSettled([...pending]);
    for (const held of holds.splice(0)) held.release();
  }
}
