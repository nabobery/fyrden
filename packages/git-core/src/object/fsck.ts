/**
 * Object checks follow git's fsck (fsck.c, git v2.53.0): the same message
 * ids, as used in `fsck.<msg-id>` config and printed by `git fsck`, and git's
 * default severities. Git's FATAL level is "error" here; its INFO level is
 * reported, as git fsck does, but ignored by default. Which findings reject
 * a push is the receive path's policy, not the parser's.
 */
export const FSCK_SEVERITY = {
  // Structure: the object cannot be read at all.
  badTree: "error",
  nulInHeader: "error",
  unterminatedHeader: "error",
  // Commit and tag headers.
  badTreeSha1: "error",
  badParentSha1: "error",
  badObjectSha1: "error",
  badType: "error",
  missingTree: "error",
  missingAuthor: "error",
  multipleAuthors: "error",
  missingCommitter: "error",
  missingObject: "error",
  missingTypeEntry: "error",
  missingType: "error",
  missingTagEntry: "error",
  missingTag: "error",
  // Identity lines (author, committer, tagger).
  badDate: "error",
  badDateOverflow: "error",
  badEmail: "error",
  badName: "error",
  badTimezone: "error",
  missingEmail: "error",
  missingNameBeforeEmail: "error",
  missingSpaceBeforeDate: "error",
  missingSpaceBeforeEmail: "error",
  zeroPaddedDate: "error",
  // Trees.
  duplicateEntries: "error",
  treeNotSorted: "error",
  nullSha1: "warn",
  fullPathname: "warn",
  hasDot: "warn",
  hasDotdot: "warn",
  hasDotgit: "warn",
  largePathname: "warn",
  zeroPaddedFilemode: "warn",
  badFilemode: "info",
  // Commits and tags.
  nulInCommit: "warn",
  badTagName: "info",
  missingTaggerEntry: "info",
} as const satisfies Record<string, FsckSeverity>;

export type FsckSeverity = "error" | "warn" | "info";
export type FsckMessageId = keyof typeof FSCK_SEVERITY;

export interface FsckIssue {
  readonly id: FsckMessageId;
  readonly severity: FsckSeverity;
}

/** A parsed object together with what git's fsck would report about it. */
export interface Parsed<T> {
  readonly value: T;
  readonly issues: readonly FsckIssue[];
}

/**
 * Thrown when an object cannot be parsed, or (for commits and tags, where
 * git's fsck stops at the first error) when it has an error-level finding.
 */
export class GitObjectError extends Error {
  readonly id: FsckMessageId;
  constructor(id: FsckMessageId, message: string) {
    super(`${id}: ${message}`);
    this.name = "GitObjectError";
    this.id = id;
  }
}

export function issue(id: FsckMessageId): FsckIssue {
  return { id, severity: FSCK_SEVERITY[id] };
}
