import type { SqliteCommitGraph } from "@fyrden/adapters-cloudflare/git";
import {
  type DiffEntry,
  diffFile,
  diffTrees,
  findExactRenames,
  MissingCommitError,
  mergeBases,
  type Oid,
  oidFromHex,
  oidToHex,
  reachableCommits,
  TreeDiffLimitError,
  WalkLimitError,
} from "@fyrden/git-core";
import { ReadBudgetError } from "../../git/live-reader.js";
import {
  BROWSE_POLICY,
  type Browsed,
  type CommitView,
  fail,
  guarded,
  type RepoBrowse,
} from "./browse.js";
import { ReadsTooLargeError, UnreadableObjectError, withHeldReads } from "./held-reads.js";
import type { RepoPulls } from "./pulls.js";

/** Limits of a pull request's file listing. Proposed (Workers Free). */
export const PULL_FILES_POLICY = {
  /** Files listed at most (GitHub's limit); more are left out and the listing says so. */
  maxFiles: 3_000,
  /**
   * Changes gathered before renames are paired (a rename is two until
   * then); past it, the listing is truncated and pairs no renames.
   */
  maxRawChanges: 6_000,
  /** Trees read to list the files. */
  maxTrees: 1_500,
  /**
   * The largest tree read, in bytes (about 37,000 entries): its memory
   * hold, for each entry it may have, stays well within the object's.
   */
  maxTreeBytes: 1024 * 1024,
  /** Tree bytes one listing reads in all, held from the object's memory budget while it lists. */
  maxTreeBytesTotal: 24 * 1024 * 1024,
  /** Bytes of each side of a file compared for its patch. */
  maxSideBytes: 1024 * 1024,
  /** UTF-8 bytes of patch text one file carries inline. */
  maxInlinePatchBytes: 64 * 1024,
  /** UTF-8 bytes of patch text one page carries. */
  maxPagePatchBytes: 1024 * 1024,
};
export type PullFilesPolicy = typeof PULL_FILES_POLICY;

/** Why a file's patch is not given. */
export type PatchOmitted = "binary" | "too_large" | "patch_too_large" | "submodule" | "budget";

export interface PullFileView {
  readonly filename: string;
  /** For a renamed file, where it was. */
  readonly previousFilename: string | null;
  /** GitHub's statuses: `changed` is a change of mode or kind only. */
  readonly status: "added" | "removed" | "modified" | "renamed" | "changed";
  /** The file's blob on the head side (the removed blob for a removal). */
  readonly sha: string;
  readonly additions: number;
  readonly deletions: number;
  readonly patch: string | null;
  readonly patchOmitted: PatchOmitted | null;
  /** The line diff hit its cost bound: right, but not the shortest. */
  readonly approximate: boolean;
}

export interface PullFilesPage {
  /** The commits compared: the merge base of base and head, and the head. */
  readonly mergeBase: string;
  readonly head: string;
  readonly files: readonly PullFileView[];
  /** Where the next page starts; null on the last one. */
  readonly next: number | null;
  /** More files changed than are listed: the listing stops there. */
  readonly truncated: boolean;
}

const GITLINK = 0o160000;
const isGitlink = (mode: number | null) => mode !== null && (mode & 0o170000) === GITLINK;

const UNREADABLE = fail(422, "unreadable", "An object the comparison needs cannot be read.");
const TOO_EXPENSIVE = fail(422, "too_expensive", "The pull request changes too much to list.");
const COMMIT_GONE = fail(422, "unreadable", "A commit the comparison needs is no longer stored.");

/** The merge base of `base` and `head` (the first git would name), or a failure. */
export async function mergeBaseOf(
  graph: SqliteCommitGraph,
  base: Oid,
  head: Oid,
): Promise<Browsed<Oid>> {
  try {
    const [first] = await mergeBases(graph, "verified", base, [head], {
      maxCommits: 3 * BROWSE_POLICY.compareMaxCommits,
    });
    return first
      ? { ok: true, value: first }
      : fail(422, "no_merge_base", "The base and head share no history to compare from.");
  } catch (error) {
    if (error instanceof WalkLimitError)
      return fail(422, "too_expensive", "The base and head are too far apart to compare.");
    // A commit no longer stored (garbage collected).
    if (error instanceof MissingCommitError) return COMMIT_GONE;
    throw error;
  }
}

/** UTF-8 bytes of `text`, counted without encoding it. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      // A surrogate pair: one four-byte character.
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * One page of the files a pull request changes, compared from `mergeBase`
 * (the merge base of its base and head) to `head`, as GitHub's three-dot
 * comparison. The whole listing is worked out from the trees (renames pair
 * across it); only the page's files are read for their patches.
 */
export function pullFiles(
  browse: RepoBrowse,
  graph: SqliteCommitGraph,
  input: {
    readonly mergeBase: Oid;
    readonly head: Oid;
    readonly start: number;
    readonly limit: number;
  },
  policy: PullFilesPolicy = PULL_FILES_POLICY,
): Promise<Browsed<PullFilesPage>> {
  return guarded(async () => {
    const [baseRow, headRow] = graph.readSync([input.mergeBase, input.head], "verified");
    if (!baseRow || !headRow) return UNREADABLE;
    return browse.reading(async (reader) => {
      let entries: DiffEntry[];
      let truncated: boolean;
      try {
        // Tree bodies, and what parsing makes of them, are held from the
        // object's memory budget until the listing is worked out.
        ({ entries, truncated } = await withHeldReads(
          reader,
          { tryReserve: (bytes) => browse.hold(bytes) },
          { maxTreeBytes: policy.maxTreeBytes, maxReadBytes: policy.maxTreeBytesTotal },
          async (reads) => {
            const listed = await diffTrees(reads.readTree, baseRow.tree, headRow.tree, {
              maxTrees: policy.maxTrees,
              maxChanges: policy.maxRawChanges,
            });
            // Past the raw cap a rename's other half may be cut off: none are
            // paired then, so none shows half paired (git's view without renames).
            const all = listed.truncated ? listed.changes : findExactRenames(listed.changes);
            return {
              entries: all.slice(0, policy.maxFiles),
              truncated: listed.truncated || all.length > policy.maxFiles,
            };
          },
        ));
      } catch (error) {
        if (error instanceof TreeDiffLimitError || error instanceof ReadsTooLargeError)
          return TOO_EXPENSIVE;
        if (error instanceof UnreadableObjectError) return UNREADABLE;
        throw error;
      }
      try {
        return {
          ok: true,
          value: await page(browse, entries, input, policy, {
            mergeBase: oidToHex(input.mergeBase),
            head: oidToHex(input.head),
            truncated,
          }),
        };
      } catch (error) {
        if (error instanceof UnreadableObjectError) return UNREADABLE;
        throw error;
      }
    });
  });
}

/** The page of `entries` from `input.start`, with patches, within the page's budgets. */
async function page(
  browse: RepoBrowse,
  entries: readonly DiffEntry[],
  input: { readonly start: number; readonly limit: number },
  policy: PullFilesPolicy,
  comparison: Omit<PullFilesPage, "files" | "next">,
): Promise<PullFilesPage> {
  const files: PullFileView[] = [];
  let patchBytes = 0;
  for (const entry of entries.slice(input.start, input.start + input.limit)) {
    let view: PullFileView;
    try {
      view = await fileView(browse, entry, policy);
    } catch (error) {
      // Out of reads: the page ends with the files it has, or the file says so.
      if (!(error instanceof ReadBudgetError)) throw error;
      if (files.length > 0) break;
      view = { ...bare(entry), patchOmitted: "budget" };
    }
    const bytes = view.patch === null ? 0 : utf8Length(view.patch);
    if (files.length > 0 && patchBytes + bytes > policy.maxPagePatchBytes) break;
    patchBytes += bytes;
    browse.take(2 * view.filename.length + bytes + 256);
    files.push(view);
  }
  const end = input.start + files.length;
  return { ...comparison, files, next: end < entries.length ? end : null };
}

/** A file's listing without its patch. */
function bare(entry: DiffEntry): PullFileView {
  const sameContent =
    entry.oldOid !== null &&
    entry.newOid !== null &&
    oidToHex(entry.oldOid) === oidToHex(entry.newOid);
  const status =
    entry.status === "renamed"
      ? "renamed"
      : entry.status === "type_changed" || (entry.status === "modified" && sameContent)
        ? "changed"
        : entry.status;
  return {
    filename: entry.path,
    previousFilename: entry.status === "renamed" ? entry.previousPath : null,
    status,
    sha: oidToHex((entry.newOid ?? entry.oldOid) as Oid),
    additions: 0,
    deletions: 0,
    patch: null,
    patchOmitted: null,
    approximate: false,
  };
}

/** A file's listing with its patch, reading both sides within the policy's bounds. */
async function fileView(
  browse: RepoBrowse,
  entry: DiffEntry,
  policy: PullFilesPolicy,
): Promise<PullFileView> {
  const view = bare(entry);
  if (isGitlink(entry.oldMode) || isGitlink(entry.newMode))
    return { ...view, patchOmitted: "submodule" };
  // The same content (a rename, a mode change) has no lines to compare.
  if (entry.oldOid && entry.newOid && oidToHex(entry.oldOid) === oidToHex(entry.newOid))
    return view;
  const reader = await browse.reader();
  const sizeOf = async (oid: Oid | null) => {
    if (!oid) return 0;
    const header = await reader.readHeader(oid);
    if (header?.type !== "blob") throw new UnreadableObjectError();
    return header.size;
  };
  const sizes = [await sizeOf(entry.oldOid), await sizeOf(entry.newOid)];
  if (sizes.some((size) => size > policy.maxSideBytes))
    return { ...view, patchOmitted: "too_large" };
  const hold = browse.hold((sizes[0] ?? 0) + (sizes[1] ?? 0));
  if (!hold) return { ...view, patchOmitted: "budget" };
  try {
    const read = async (oid: Oid | null) => {
      if (!oid) return new Uint8Array(0);
      const object = await reader.readObject(oid);
      if (object?.type !== "blob") throw new UnreadableObjectError();
      return object.bytes;
    };
    const diff = diffFile(await read(entry.oldOid), await read(entry.newOid));
    if (diff.kind === "binary") return { ...view, patchOmitted: "binary" };
    if (diff.kind === "too_large") return { ...view, patchOmitted: "too_large" };
    const counts = {
      additions: diff.additions,
      deletions: diff.deletions,
      approximate: diff.approximate,
    };
    if (utf8Length(diff.text) > policy.maxInlinePatchBytes)
      return { ...view, ...counts, patchOmitted: "patch_too_large" };
    return { ...view, ...counts, patch: diff.text };
  } finally {
    hold.release();
  }
}

/** Commits a pull request lists at most (GitHub's limit): the oldest ones. */
export const MAX_PULL_COMMITS = 250;

/**
 * A page of a pull request's commits: those `head` has and `base` does
 * not, oldest first (by generation, then commit time), at most
 * {@link MAX_PULL_COMMITS} of them.
 */
export function pullCommits(
  browse: RepoBrowse,
  graph: SqliteCommitGraph,
  input: { readonly base: Oid; readonly head: Oid; readonly start: number; readonly limit: number },
): Promise<Browsed<{ commits: CommitView[]; next: number | null; total: number }>> {
  return guarded(async () => {
    let ahead: Oid[];
    try {
      ahead = [
        ...(await reachableCommits(graph, "verified", [input.head], [input.base], {
          maxCommits: 3 * BROWSE_POLICY.compareMaxCommits,
        })),
      ];
    } catch (error) {
      if (error instanceof WalkLimitError)
        return fail(422, "too_expensive", "The pull request has too many commits to list.");
      if (error instanceof MissingCommitError) return COMMIT_GONE;
      throw error;
    }
    const rows = graph.readSync(ahead, "verified");
    const ordered = ahead
      .map((oid, i) => ({ oid, row: rows[i] }))
      .sort(
        (a, b) =>
          (a.row?.generation ?? 0) - (b.row?.generation ?? 0) ||
          (a.row?.commitTime ?? 0) - (b.row?.commitTime ?? 0),
      )
      .slice(0, MAX_PULL_COMMITS)
      .map((c) => c.oid);
    const page = ordered.slice(input.start, input.start + input.limit);
    const commits = page.length === 0 ? [] : await browse.commitViews(page);
    const end = input.start + commits.length;
    return {
      ok: true,
      value: { commits, next: end < ordered.length ? end : null, total: ordered.length },
    };
  });
}

/** Where a later page of a listing starts: the listing a first page kept, and the index. */
export interface ListingCursor {
  readonly listing: string;
  readonly start: number;
}

/** A listing's cursor that names none this repository keeps for that pull request. */
const INVALID_LISTING = fail(
  422,
  "invalid_cursor",
  "The cursor is not one this API returned, or its listing has expired: start again.",
);

/**
 * A page of the files a pull request changes. Without `from`, a listing
 * starts: the merge base of the base it is compared from (the base
 * branch's tip while open, see `comparedBase`) and the recorded head is
 * worked out now, and kept for the later
 * pages when there are any; `from` names such a listing (a cursor this
 * repository gave) and where its next page starts.
 */
export async function pullFilesListing(
  browse: RepoBrowse,
  pulls: RepoPulls,
  graph: SqliteCommitGraph,
  input: { readonly number: number; readonly from: ListingCursor | null; readonly limit: number },
): Promise<Browsed<PullFilesPage & { listing: string | null }>> {
  const { number, from, limit } = input;
  const pull = pulls.get(number);
  if (!pull) return fail(404, "pull_not_found", `The repository has no pull request ${number}.`);
  let listing = from?.listing ?? null;
  let mergeBase: Oid;
  let head: Oid;
  if (from) {
    const kept = pulls.listing(number, "files", from.listing);
    if (!kept) return INVALID_LISTING;
    mergeBase = oidFromHex(kept.base);
    head = oidFromHex(kept.head);
  } else {
    head = oidFromHex(pull.headSha);
    const found = await mergeBaseOf(graph, pulls.comparedBase(pull), head);
    if (!found.ok) return found;
    mergeBase = found.value;
  }
  const page = await pullFiles(browse, graph, {
    mergeBase,
    head,
    start: from?.start ?? 0,
    limit,
  });
  if (!page.ok) return page;
  if (!listing && page.value.next !== null)
    listing = pulls.startListing(number, "files", page.value.mergeBase, page.value.head);
  return { ok: true, value: { ...page.value, listing } };
}

/**
 * A page of a pull request's commits, oldest first: from the base it is
 * compared from (`comparedBase`) to the recorded head, kept for the
 * later pages as a file listing is.
 */
export async function pullCommitsListing(
  browse: RepoBrowse,
  pulls: RepoPulls,
  graph: SqliteCommitGraph,
  input: { readonly number: number; readonly from: ListingCursor | null; readonly limit: number },
) {
  const { number, from, limit } = input;
  const pull = pulls.get(number);
  if (!pull) return fail(404, "pull_not_found", `The repository has no pull request ${number}.`);
  let listing = from?.listing ?? null;
  let base: Oid;
  let head: Oid;
  if (from) {
    const kept = pulls.listing(number, "commits", from.listing);
    if (!kept) return INVALID_LISTING;
    base = oidFromHex(kept.base);
    head = oidFromHex(kept.head);
  } else {
    base = pulls.comparedBase(pull);
    head = oidFromHex(pull.headSha);
  }
  const page = await pullCommits(browse, graph, {
    base,
    head,
    start: from?.start ?? 0,
    limit,
  });
  if (!page.ok) return page;
  if (!listing && page.value.next !== null)
    listing = pulls.startListing(number, "commits", oidToHex(base), oidToHex(head));
  return { ok: true as const, value: { ...page.value, listing } };
}
