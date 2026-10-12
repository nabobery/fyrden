import type { Oid } from "../object/oid.js";

/** What a commit graph row records about a commit, as parsed from the object. */
export interface CommitInfo {
  readonly oid: Oid;
  readonly tree: Oid;
  /** In the order the commit lists them; the first parent first. */
  readonly parents: readonly Oid[];
  /** Committer timestamp, seconds since the epoch. */
  readonly commitTime: number;
}

/** A stored row: the commit plus both of git's generation numbers. */
export interface CommitGraphRow extends CommitInfo {
  /** Corrected commit date (git's generation number v2). Walks order by this. */
  readonly generation: number;
  /** Topological level (git's generation number v1). */
  readonly level: number;
}

export interface CommitGraphEntry extends CommitGraphRow {
  /**
   * `verified` rows belong to the repository. `pending` rows come from an
   * upload that has not committed, and only that upload ever reads them.
   */
  readonly state: "verified" | "pending";
}

/**
 * Which rows a read sees: `"verified"` for every ordinary request, or the
 * verified rows plus one upload's own pending rows, for that upload's
 * connectivity check and commit validator. Pending rows of other uploads are
 * never visible.
 */
export type CommitGraphView = "verified" | { readonly uploadId: string };

/**
 * The repository's commit graph: one row per commit, so history walks never
 * read packs. Rows from a push are inserted as pending under its upload id
 * and become verified only in the same transaction that moves the refs; that
 * promotion belongs to the ref store's commit, so it is not part of this port.
 */
export interface CommitGraph {
  /**
   * Rows for `oids` as seen from `view`, in the same order; `undefined`
   * where none is visible. A verified row wins over a pending one.
   */
  read(
    oids: readonly Oid[],
    view: CommitGraphView,
  ): Promise<readonly (CommitGraphEntry | undefined)[]>;
  /**
   * Stores rows as pending for `uploadId`. Rows for commits that are
   * already verified are ignored; inserting a pending row again replaces it.
   * Callers compute generation numbers first (`addPendingCommits`).
   */
  insertPending(uploadId: string, rows: readonly CommitGraphRow[]): Promise<void>;
  /** Deletes every pending row of `uploadId` (a rejected or expired upload). */
  discardPending(uploadId: string): Promise<void>;
}
