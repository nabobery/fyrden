import { copyBytes } from "../../src/object/bytes.js";
import { type Oid, oidToHex } from "../../src/object/oid.js";
import type {
  CommitGraph,
  CommitGraphEntry,
  CommitGraphRow,
} from "../../src/ports/commit-graph.js";

export interface MemoryCommitGraph extends CommitGraph {
  /** Makes an upload's pending rows verified (the ref store's commit does this for real). */
  promote(uploadId: string): Promise<void>;
}

function copyRow(row: CommitGraphRow): CommitGraphRow {
  return {
    oid: copyBytes(row.oid) as Oid,
    tree: copyBytes(row.tree) as Oid,
    parents: row.parents.map((p) => copyBytes(p) as Oid),
    commitTime: row.commitTime,
    generation: row.generation,
    level: row.level,
  };
}

/** In-memory `CommitGraph` with the visibility rules of the Durable Object tables. */
export function createMemoryCommitGraph(): MemoryCommitGraph {
  const verified = new Map<string, CommitGraphRow>();
  const pending = new Map<string, Map<string, CommitGraphRow>>();

  return {
    async read(oids, view) {
      const own = view === "verified" ? undefined : pending.get(view.uploadId);
      return oids.map((oid): CommitGraphEntry | undefined => {
        const key = oidToHex(oid);
        const fromVerified = verified.get(key);
        if (fromVerified) return { ...copyRow(fromVerified), state: "verified" };
        const fromPending = own?.get(key);
        return fromPending && { ...copyRow(fromPending), state: "pending" };
      });
    },
    async insertPending(uploadId, rows) {
      const own = pending.get(uploadId) ?? new Map<string, CommitGraphRow>();
      pending.set(uploadId, own);
      for (const row of rows) {
        const key = oidToHex(row.oid);
        if (!verified.has(key)) own.set(key, copyRow(row));
      }
    },
    async discardPending(uploadId) {
      pending.delete(uploadId);
    },
    async promote(uploadId) {
      for (const [key, row] of pending.get(uploadId) ?? []) {
        if (!verified.has(key)) verified.set(key, row);
      }
      pending.delete(uploadId);
    },
  };
}
