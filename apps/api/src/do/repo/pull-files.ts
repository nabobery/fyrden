import type { SqliteCommitGraph } from "@fyrden/adapters-cloudflare/git";
import {
  type DiffEntry,
  diffFile,
  diffTrees,
  findExactRenames,
  type MemoryReservation,
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
import type { ChangeList, ChangeLists, ListedChange } from "./change-lists.js";
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
  /** Files whose patches a page reads at once. Proposed. */
  filesAtOnce: 6,
  /**
   * A request's last R2 reads, which a page spends on one file at a time,
   * in order, so that files read ahead leave an earlier one the reads it
   * needs. A quarter of the browse budget: room for the files already
   * reading to finish what they started (a few reads each for files
   * stored whole) and for the earliest to follow its sides' delta chains;
   * only a file needing more than that can still be left fewer reads than
   * reading the files one by one would leave it. Proposed.
   */
  serialReads: 200,
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
 * across it), or taken from `lists` when it was worked out before; only the
 * page's files are read for their patches.
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
  lists?: ChangeLists,
): Promise<Browsed<PullFilesPage>> {
  return guarded(async () => {
    const [baseRow, headRow] = graph.readSync([input.mergeBase, input.head], "verified");
    if (!baseRow || !headRow) return UNREADABLE;
    const comparison = { mergeBase: oidToHex(input.mergeBase), head: oidToHex(input.head) };
    // The limits that shape a listing: one worked out with others is not this one.
    const limits = `${policy.maxFiles} ${policy.maxRawChanges}`;
    let list = lists?.get(comparison.mergeBase, comparison.head, limits);
    if (!list) {
      const listed = await changeList(browse, baseRow.tree, headRow.tree, policy);
      if (!listed.ok) return listed;
      list = listed.value;
      lists?.keep(comparison.mergeBase, comparison.head, limits, list);
    }
    try {
      return {
        ok: true,
        value: await page(browse, list.changes, input, policy, {
          ...comparison,
          truncated: list.truncated,
        }),
      };
    } catch (error) {
      if (error instanceof UnreadableObjectError) return UNREADABLE;
      throw error;
    }
  });
}

/** The changes from tree `base` to tree `head`, renames paired, within the policy's bounds. */
async function changeList(
  browse: RepoBrowse,
  base: Oid,
  head: Oid,
  policy: PullFilesPolicy,
): Promise<Browsed<ChangeList>> {
  const reader = await browse.reader();
  try {
    // Tree bodies, and what parsing makes of them, are held from the
    // object's memory budget until the listing is worked out.
    const list = await withHeldReads(
      reader,
      { tryReserve: (bytes) => browse.hold(bytes) },
      { maxTreeBytes: policy.maxTreeBytes, maxReadBytes: policy.maxTreeBytesTotal },
      async (reads) => {
        const listed = await diffTrees(reads.readTree, base, head, {
          maxTrees: policy.maxTrees,
          maxChanges: policy.maxRawChanges,
        });
        // Past the raw cap a rename's other half may be cut off: none are
        // paired then, so none shows half paired (git's view without renames).
        const all = listed.truncated ? listed.changes : findExactRenames(listed.changes);
        return {
          changes: all.slice(0, policy.maxFiles).map(listedChange),
          truncated: listed.truncated || all.length > policy.maxFiles,
        };
      },
    );
    return { ok: true, value: list };
  } catch (error) {
    if (error instanceof TreeDiffLimitError || error instanceof ReadsTooLargeError)
      return TOO_EXPENSIVE;
    if (error instanceof UnreadableObjectError) return UNREADABLE;
    throw error;
  }
}

/** What a page needs of a change. */
function listedChange(entry: DiffEntry): ListedChange {
  return {
    status: entry.status,
    path: entry.path,
    previousPath: entry.status === "renamed" ? entry.previousPath : null,
    oldMode: entry.oldMode,
    newMode: entry.newMode,
    oldOid: entry.oldOid,
    newOid: entry.newOid,
  };
}

/** Whether a change keeps its content (a rename, a change of mode). */
const sameContent = (change: ListedChange) =>
  change.oldOid !== null &&
  change.newOid !== null &&
  oidToHex(change.oldOid) === oidToHex(change.newOid);

/** Whether a change's patch is worked out from its files: not a submodule's, and lines changed. */
const patched = (change: ListedChange) =>
  !isGitlink(change.oldMode) && !isGitlink(change.newMode) && !sameContent(change);

/**
 * The page of `changes` from `input.start`, with patches, within the
 * page's budgets. A few files are read at once, their objects located
 * together first, and the request's last reads go to one file at a time
 * (see `ReadTurns`); each is taken in order, so the page ends where
 * reading them one by one would end it.
 */
async function page(
  browse: RepoBrowse,
  changes: readonly ListedChange[],
  input: { readonly start: number; readonly limit: number },
  policy: PullFilesPolicy,
  comparison: Omit<PullFilesPage, "files" | "next">,
): Promise<PullFilesPage> {
  const listed = changes.slice(input.start, input.start + input.limit);
  const blobs = listed
    .filter(patched)
    .flatMap((change) => [change.oldOid, change.newOid])
    .filter((oid) => oid !== null);
  if (blobs.length > 0) {
    try {
      await (await browse.reader()).prefetch(blobs);
    } catch (error) {
      // Out of reads: each file says so as it is read.
      if (!(error instanceof ReadBudgetError)) throw error;
    }
  }
  const turns = new ReadTurns(browse, policy.serialReads);
  const views: Promise<{ view: PullFileView } | { error: unknown }>[] = [];
  const read = (i: number) => {
    const change = listed[i];
    if (!change) return;
    const file = turns.file(i);
    views[i] = fileView(browse, change, policy, file)
      .finally(file.ended)
      .then(
        (view) => ({ view }),
        (error: unknown) => ({ error }),
      );
  };
  for (let i = 0; i < policy.filesAtOnce; i++) read(i);
  const files: PullFileView[] = [];
  let patchBytes = 0;
  try {
    for (const [i, change] of listed.entries()) {
      turns.first(i);
      const outcome = await views[i];
      let view: PullFileView;
      if (outcome && "view" in outcome) view = outcome.view;
      else {
        // Out of reads: the page ends with the files it has, or the file says so.
        if (!(outcome?.error instanceof ReadBudgetError)) throw outcome?.error;
        if (files.length > 0) break;
        view = { ...bare(change), patchOmitted: "budget" };
      }
      const bytes = view.patch === null ? 0 : utf8Length(view.patch);
      if (files.length > 0 && patchBytes + bytes > policy.maxPagePatchBytes) break;
      patchBytes += bytes;
      browse.take(2 * view.filename.length + bytes + 256);
      files.push(view);
      read(i + policy.filesAtOnce);
    }
  } finally {
    // Files read past where the page ends read no further, and finish
    // before the request does (and its reader is closed).
    turns.end();
    await Promise.all(views);
  }
  const end = input.start + files.length;
  return { ...comparison, files, next: end < changes.length ? end : null };
}

/** A file's listing without its patch. */
function bare(change: ListedChange): PullFileView {
  const status =
    change.status === "renamed"
      ? "renamed"
      : change.status === "type_changed" || (change.status === "modified" && sameContent(change))
        ? "changed"
        : change.status;
  return {
    filename: change.path,
    previousFilename: change.previousPath,
    status,
    sha: oidToHex((change.newOid ?? change.oldOid) as Oid),
    additions: 0,
    deletions: 0,
    patch: null,
    patchOmitted: null,
    approximate: false,
  };
}

/** What a file read with others needs from them (see `ReadTurns`). */
interface FileTurns {
  /** Settles when the file may read on. */
  read(): Promise<void>;
  /** The memory the file holds while it compares its sides, or undefined when none is free. */
  hold(bytes: number): Promise<MemoryReservation | undefined>;
}

/**
 * Turns at the request's last reads, and at memory, while a page reads its
 * files. Once `serialReads` or fewer are left, a file waits before each of
 * its reads (its sides' headers, then their bodies) until the files before
 * it are taken, so they get the reads that reading the files one by one
 * would give them. Files hold memory in order, and one that finds too
 * little free waits, holding up the files after it, until the files before
 * it are taken and have released theirs, then tries once more: it gets
 * what reading the files one by one would leave it. Once the page has
 * ended, no file reads on.
 */
export class ReadTurns {
  /** The earliest file not taken yet: it never waits. */
  #first = 0;
  #ended = false;
  readonly #waiting = new Map<number, { go: () => void; stop: (error: Error) => void }>();
  /** Settles once every file started so far holds its memory or needs none. */
  #held: Promise<void> = Promise.resolve();

  constructor(
    private readonly browse: Pick<RepoBrowse, "policy" | "reads" | "hold">,
    private readonly serialReads: number,
  ) {}

  /**
   * The turns of file `i`, which starts now (files start in order);
   * `ended` says it has ended, whether or not it held memory.
   */
  file(i: number): FileTurns & { ended: () => void } {
    const before = this.#held;
    let ended = () => {};
    const done = new Promise<void>((resolve) => {
      ended = resolve;
    });
    this.#held = before.then(() => done);
    return {
      read: () => this.turn(i),
      hold: async (bytes) => {
        await before;
        if (this.#ended) throw new Error("the page has ended");
        let held = this.browse.hold(bytes);
        if (!held) {
          await this.earliest(i);
          held = this.browse.hold(bytes);
        }
        ended();
        return held;
      },
      ended,
    };
  }

  /** Settles when file `i` may read on; fails once the page has ended. */
  turn(i: number): Promise<void> {
    const left = this.browse.policy.maxReads - this.browse.reads;
    if (!this.#ended && left > this.serialReads) return Promise.resolve();
    return this.earliest(i);
  }

  /** Settles once file `i` is the earliest not taken; fails once the page has ended. */
  earliest(i: number): Promise<void> {
    if (this.#ended) return Promise.reject(new Error("the page has ended"));
    if (i <= this.#first) return Promise.resolve();
    return new Promise((go, stop) => this.#waiting.set(i, { go, stop }));
  }

  /** File `i` is the earliest not taken. */
  first(i: number): void {
    this.#first = i;
    this.#waiting.get(i)?.go();
    this.#waiting.delete(i);
  }

  /** The page has ended: files waiting read no more. */
  end(): void {
    this.#ended = true;
    for (const { stop } of this.#waiting.values()) stop(new Error("the page has ended"));
    this.#waiting.clear();
  }
}

/**
 * `read` of a change's two sides at once. A side that fails waits for the
 * other, so nothing reads on, or holds memory, once the caller has moved
 * on and the request's reader may be closed.
 */
async function bothSides<T>(
  change: ListedChange,
  read: (oid: Oid | null) => Promise<T>,
): Promise<[T, T]> {
  const [before, after] = await Promise.allSettled([read(change.oldOid), read(change.newOid)]);
  if (before.status === "rejected") throw before.reason;
  if (after.status === "rejected") throw after.reason;
  return [before.value, after.value];
}

/**
 * A file's listing with its patch, reading both sides within the policy's
 * bounds, taking its turns at reads and memory (see `ReadTurns`).
 */
async function fileView(
  browse: RepoBrowse,
  change: ListedChange,
  policy: PullFilesPolicy,
  turns: FileTurns,
): Promise<PullFileView> {
  const view = bare(change);
  if (isGitlink(change.oldMode) || isGitlink(change.newMode))
    return { ...view, patchOmitted: "submodule" };
  // The same content (a rename, a mode change) has no lines to compare.
  if (sameContent(change)) return view;
  const reader = await browse.reader();
  await turns.read();
  const sizeOf = async (oid: Oid | null) => {
    if (!oid) return 0;
    const header = await reader.readHeader(oid);
    if (header?.type !== "blob") throw new UnreadableObjectError();
    return header.size;
  };
  const [oldSize, newSize] = await bothSides(change, sizeOf);
  if (oldSize > policy.maxSideBytes || newSize > policy.maxSideBytes)
    return { ...view, patchOmitted: "too_large" };
  await turns.read();
  const hold = await turns.hold(oldSize + newSize);
  if (!hold) return { ...view, patchOmitted: "budget" };
  try {
    const read = async (oid: Oid | null) => {
      if (!oid) return new Uint8Array(0);
      const object = await reader.readObject(oid);
      if (object?.type !== "blob") throw new UnreadableObjectError();
      return object.bytes;
    };
    const [before, after] = await bothSides(change, read);
    const diff = diffFile(before, after);
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
 * repository gave) and where its next page starts. The files changed
 * between the two commits are kept in `lists` for every page and listing
 * of the same comparison.
 */
export async function pullFilesListing(
  browse: RepoBrowse,
  pulls: RepoPulls,
  graph: SqliteCommitGraph,
  lists: ChangeLists,
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
  const page = await pullFiles(
    browse,
    graph,
    { mergeBase, head, start: from?.start ?? 0, limit },
    PULL_FILES_POLICY,
    lists,
  );
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
