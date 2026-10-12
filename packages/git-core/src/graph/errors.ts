import { type Oid, oidToHex } from "../object/oid.js";

/**
 * Commits a walk or an insert needed are not visible in the view it used:
 * absent, or pending in another upload (or pending at all, for the verified
 * view). Pushes report this as a connectivity failure.
 */
export class MissingCommitError extends Error {
  override readonly name = "MissingCommitError";
  readonly oids: readonly Oid[];

  constructor(oids: readonly Oid[]) {
    const shown = oids.slice(0, 3).map(oidToHex).join(", ");
    super(
      `missing commit${oids.length === 1 ? "" : "s"} ${shown}${oids.length > 3 ? ", ..." : ""}`,
    );
    this.oids = oids;
  }
}

/** A walk needed more commits than its `maxCommits`; callers fail closed. */
export class WalkLimitError extends Error {
  override readonly name = "WalkLimitError";
  readonly limit: number;

  constructor(limit: number) {
    super(`commit walk exceeded its limit of ${limit} commits`);
    this.limit = limit;
  }
}
