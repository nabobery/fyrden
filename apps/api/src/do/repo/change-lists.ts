import type { RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import { type Oid, oidFromHex, oidToHex } from "@fyrden/git-core";

/*
 * The changes between two commits as a pull request's file listing works
 * them out from their trees, kept in the repository's object so that its
 * later pages and the same comparison listed again read no trees. Commits
 * never change, so a kept list stays right: it is found by the two
 * commits and the listing limits it was worked out with, and nothing has
 * to invalidate it. The object keeps a bounded number and size of lists
 * and drops the oldest first.
 */

/** One change of a listing, as its page needs it. */
export interface ListedChange {
  readonly status: "added" | "removed" | "modified" | "type_changed" | "renamed";
  readonly path: string;
  /** For a rename, where the file was. */
  readonly previousPath: string | null;
  readonly oldMode: number | null;
  readonly newMode: number | null;
  readonly oldOid: Oid | null;
  readonly newOid: Oid | null;
}

export interface ChangeList {
  readonly changes: readonly ListedChange[];
  /** More changed than the list holds. */
  readonly truncated: boolean;
}

/** Bounds of the kept lists. Proposed. */
export const CHANGE_LISTS_POLICY = {
  /** Lists the object keeps at most. */
  maxLists: 256,
  /** Bytes of the kept lists in all. */
  maxBytes: 8 * 1024 * 1024,
  /**
   * Bytes of one list (3,000 changes with paths of about 100 bytes); a
   * longer one is not kept. A row holds 2 MB at most, verified
   * (https://developers.cloudflare.com/durable-objects/platform/limits/).
   */
  maxListBytes: 1024 * 1024,
};
export type ChangeListsPolicy = typeof CHANGE_LISTS_POLICY;

/** A change as stored: status, path, previous path, modes, and ids in hex. */
type StoredChange = [
  ListedChange["status"],
  string,
  string | null,
  number | null,
  number | null,
  string | null,
  string | null,
];

export class ChangeLists {
  constructor(
    private readonly git: RepoGitStorage,
    private readonly policy: ChangeListsPolicy = CHANGE_LISTS_POLICY,
  ) {}

  /** The list kept for the comparison of `base` and `head` worked out with `limits`, if any. */
  get(base: string, head: string, limits: string): ChangeList | undefined {
    const [row] = this.git.context.storage.sql
      .exec<{ truncated: number; body: string }>(
        "SELECT truncated, body FROM change_lists WHERE base_sha = ? AND head_sha = ? AND limits = ?",
        base,
        head,
        limits,
      )
      .toArray();
    if (!row) return undefined;
    const stored: StoredChange[] = JSON.parse(row.body);
    return {
      changes: stored.map(([status, path, previousPath, oldMode, newMode, oldOid, newOid]) => ({
        status,
        path,
        previousPath,
        oldMode,
        newMode,
        oldOid: oldOid === null ? null : oidFromHex(oldOid),
        newOid: newOid === null ? null : oidFromHex(newOid),
      })),
      truncated: row.truncated === 1,
    };
  }

  /** Keeps `list` for the comparison (unless it is too long), dropping the oldest lists past the bounds. */
  keep(base: string, head: string, limits: string, list: ChangeList): void {
    const body = JSON.stringify(
      list.changes.map(
        (c): StoredChange => [
          c.status,
          c.path,
          c.previousPath,
          c.oldMode,
          c.newMode,
          c.oldOid && oidToHex(c.oldOid),
          c.newOid && oidToHex(c.newOid),
        ],
      ),
    );
    const bytes = new TextEncoder().encode(body).length;
    if (bytes > this.policy.maxListBytes) return;
    const { storage, metrics, doClass } = this.git.context;
    const written = storage.transactionSync(() => {
      // Two requests may work out the same comparison at once: either list serves.
      const inserted = storage.sql.exec(
        `INSERT INTO change_lists (base_sha, head_sha, limits, truncated, bytes, body)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        base,
        head,
        limits,
        list.truncated ? 1 : 0,
        bytes,
        body,
      );
      inserted.toArray();
      const dropped = storage.sql.exec(
        `DELETE FROM change_lists WHERE seq IN (
           SELECT seq FROM (
             SELECT seq, row_number() OVER newest AS n, sum(bytes) OVER newest AS total
             FROM change_lists WINDOW newest AS (ORDER BY seq DESC))
           WHERE n > ? OR total > ?)`,
        this.policy.maxLists,
        this.policy.maxBytes,
      );
      dropped.toArray();
      return inserted.rowsWritten + dropped.rowsWritten;
    });
    if (written > 0)
      metrics.count("do.rows_written", { class: doClass, op: "change_lists.write" }, written);
  }
}
