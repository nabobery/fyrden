import {
  type CommitGraph,
  type CommitGraphEntry,
  type CommitGraphRow,
  type CommitGraphView,
  OID_BYTES,
  type Oid,
  oidFromBytes,
  oidToHex,
} from "@fyrden/git-core";
import {
  blob,
  bytesOf,
  chunks,
  countRowsWritten,
  type GitStorageContext,
  placeholders,
  rows,
  run,
} from "./sql.js";

type RawCommit = {
  oid: ArrayBuffer;
  tree: ArrayBuffer;
  parents: ArrayBuffer;
  commit_time: number;
  generation: number;
  level: number;
};

const COLUMNS = "oid, tree, parents, commit_time, generation, level";

function toRow(raw: RawCommit): CommitGraphRow {
  const parents = bytesOf(raw.parents);
  const list: Oid[] = [];
  for (let at = 0; at < parents.length; at += OID_BYTES) list.push(oidFromBytes(parents, at));
  return {
    oid: oidFromBytes(bytesOf(raw.oid)),
    tree: oidFromBytes(bytesOf(raw.tree)),
    parents: list,
    commitTime: raw.commit_time,
    generation: raw.generation,
    level: raw.level,
  };
}

function packParents(parents: readonly Oid[]): ArrayBuffer {
  const out = new Uint8Array(parents.length * OID_BYTES);
  parents.forEach((parent, i) => {
    out.set(parent, i * OID_BYTES);
  });
  return out.buffer;
}

/**
 * The commit graph in Durable Object SQLite. Verified rows live in `commits`;
 * an upload's rows live in `pending_commits` under its upload id until the
 * ref store's commit promotes them. Keeping them in separate tables makes
 * the quarantine structural: a read for the verified view never touches
 * `pending_commits`, and a read for an upload filters it by that upload's
 * id only.
 */
export class SqliteCommitGraph implements CommitGraph {
  constructor(private readonly context: GitStorageContext) {}

  async read(
    oids: readonly Oid[],
    view: CommitGraphView,
  ): Promise<readonly (CommitGraphEntry | undefined)[]> {
    return this.readSync(oids, view);
  }

  /** `read` without the promise, for use inside a transaction. */
  readSync(oids: readonly Oid[], view: CommitGraphView): (CommitGraphEntry | undefined)[] {
    const found = new Map<string, CommitGraphEntry>();
    const unique = [...new Map(oids.map((oid) => [oidToHex(oid), oid])).values()];
    const storage = this.context.storage;
    for (const batch of chunks(unique)) {
      for (const raw of rows<RawCommit>(
        storage,
        `SELECT ${COLUMNS} FROM commits WHERE oid IN (${placeholders(batch.length)})`,
        ...batch.map(blob),
      )) {
        const row = toRow(raw);
        found.set(oidToHex(row.oid), { ...row, state: "verified" });
      }
    }
    if (view !== "verified") {
      const missing = unique.filter((oid) => !found.has(oidToHex(oid)));
      for (const batch of chunks(missing)) {
        for (const raw of rows<RawCommit>(
          storage,
          `SELECT ${COLUMNS} FROM pending_commits
           WHERE upload_id = ? AND oid IN (${placeholders(batch.length)})`,
          view.uploadId,
          ...batch.map(blob),
        )) {
          const row = toRow(raw);
          found.set(oidToHex(row.oid), { ...row, state: "pending" });
        }
      }
    }
    // Each result is its own copy, so callers can change it freely.
    return oids.map((oid) => {
      const entry = found.get(oidToHex(oid));
      return entry && copyEntry(entry);
    });
  }

  async insertPending(uploadId: string, commitRows: readonly CommitGraphRow[]): Promise<void> {
    this.insertPendingSync(uploadId, commitRows);
  }

  insertPendingSync(uploadId: string, commitRows: readonly CommitGraphRow[]): void {
    const storage = this.context.storage;
    const written = storage.transactionSync(() => {
      let written = 0;
      for (const row of commitRows) {
        // A commit that is already verified keeps its verified row only.
        written += run(
          storage,
          `INSERT INTO pending_commits (upload_id, ${COLUMNS})
           SELECT ?, ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM commits WHERE oid = ?)
           ON CONFLICT (upload_id, oid) DO UPDATE SET
             tree = excluded.tree, parents = excluded.parents,
             commit_time = excluded.commit_time, generation = excluded.generation,
             level = excluded.level`,
          uploadId,
          blob(row.oid),
          blob(row.tree),
          packParents(row.parents),
          row.commitTime,
          row.generation,
          row.level,
          blob(row.oid),
        );
      }
      return written;
    });
    countRowsWritten(this.context, "commits.insert_pending", written);
  }

  async discardPending(uploadId: string): Promise<void> {
    countRowsWritten(
      this.context,
      "commits.discard_pending",
      discardPendingCommits(this.context, uploadId),
    );
  }
}

function copyEntry(entry: CommitGraphEntry): CommitGraphEntry {
  return {
    ...entry,
    oid: oidFromBytes(entry.oid),
    tree: oidFromBytes(entry.tree),
    parents: entry.parents.map((p) => oidFromBytes(p)),
  };
}

/** Deletes an upload's pending rows. Returns rows written. Safe inside a transaction. */
export function discardPendingCommits(context: GitStorageContext, uploadId: string): number {
  return run(context.storage, "DELETE FROM pending_commits WHERE upload_id = ?", uploadId);
}

/**
 * Makes an upload's pending rows verified and removes them from the pending
 * table. Only the ref store's commit transaction calls this (and tests that
 * stand in for it). Returns rows written.
 */
export function promotePendingCommits(context: GitStorageContext, uploadId: string): number {
  const storage = context.storage;
  return (
    run(
      storage,
      `INSERT INTO commits (${COLUMNS}, signature)
       SELECT ${COLUMNS}, signature FROM pending_commits WHERE upload_id = ?
       ON CONFLICT (oid) DO NOTHING`,
      uploadId,
    ) + discardPendingCommits(context, uploadId)
  );
}
