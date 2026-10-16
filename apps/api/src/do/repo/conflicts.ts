import type { GitPerson } from "@fyrden/domain";
import {
  type LinesConflict,
  type MergeConflict,
  mergeFiles,
  type Oid,
  oidToHex,
  withConflictMarkers,
} from "@fyrden/git-core";
import { type LiveReaderDeps, ReadBudgetError } from "../../git/live-reader.js";
import type { PushLogMeta } from "../../git/push/repo-push.js";
import { type Browsed, type BrowseFailure, fail } from "./browse.js";
import {
  type FileWriteDeps,
  type FileWriteInput,
  refused,
  type WriteElsewhere,
  type WriterOf,
} from "./file-writes.js";
import {
  commitMerge,
  MERGE_POLICY,
  type MergeCommit,
  type MergeMade,
  type MergePolicy,
  MergeTooLargeError,
  mergeOutcome,
  TOO_EXPENSIVE,
  type TreeOutcome,
  UNREADABLE,
  UnreadableObjectError,
  withSource,
} from "./merge.js";

/*
 * A pull request's conflicts with its base branch, and their resolution:
 * the base branch is merged into the head branch (a merge commit whose
 * parents are the head and the base tip, made and signed by the server),
 * with the files whose lines conflict taking the contents the caller
 * gives, through the push path as any write to the head branch. Updating
 * the branch is the same merge when nothing conflicts.
 *
 * Only regular text files whose lines conflict can be resolved here; a
 * conflict of any other kind (a file deleted on one side, a mode, a
 * symlink, a binary file, a file and a directory) needs a merge by hand.
 */

/** Limits of reading conflicts. Proposed. */
export const CONFLICTS_POLICY = {
  /** Conflicted files given with their contents; past them, listed without. */
  maxEditableFiles: 50,
  /** Bytes of conflicted contents one answer carries in all. */
  maxContentBytes: 4 * 1024 * 1024,
} as const;

/** A conflicted file, and whether it can be resolved here (with its contents, with markers). */
export interface ConflictFile {
  readonly path: string;
  readonly kind: MergeConflict["kind"];
  readonly editable: boolean;
  /** The merged file, each conflict between git's markers (the head's side first). */
  readonly content: string | null;
  /** Conflicts in the file. */
  readonly conflicts: number;
}

export interface ConflictsView {
  readonly baseSha: string;
  readonly headSha: string;
  /** Names this base tip and head: a resolution is made against them only. */
  readonly snapshot: string;
  readonly files: readonly ConflictFile[];
}

/** The base tip and head a snapshot names (40 + 40 hex digits). */
export function parseSnapshot(snapshot: string): { baseSha: string; headSha: string } | undefined {
  if (!/^[0-9a-f]{80}$/.test(snapshot)) return undefined;
  return { baseSha: snapshot.slice(0, 40), headSha: snapshot.slice(40) };
}

const NOT_CLEAN = fail(
  422,
  "merge_conflict",
  "The pull request's history needs a merge made by hand (its merge bases conflict); merge it locally and push.",
);

/** What a merge of the base into the head cannot be, as the API answers it. */
function outcomeRefusal(outcome: Exclude<TreeOutcome, { kind: "clean" | "conflicts" }>) {
  switch (outcome.kind) {
    case "manual":
      return NOT_CLEAN;
    case "unrelated":
      return fail(422, "not_mergeable", "The base branch and the head share no history.");
    case "too_expensive":
      return TOO_EXPENSIVE;
    case "unreadable":
      return UNREADABLE;
  }
}

/** Whether a conflict is of lines in regular files: the kinds resolved here. */
const ofLines = (conflict: MergeConflict) =>
  (conflict.kind === "content" || conflict.kind === "add_add") &&
  conflict.ours !== null &&
  conflict.theirs !== null;

/**
 * Whether a file whose lines conflict can be resolved here: its path and
 * its three versions are UTF-8 (the API gives and takes them as text).
 */
function editableText(file: LinesConflict): boolean {
  return [file.path, file.base, file.ours, file.theirs].every((b) => utf8(b) !== undefined);
}

/**
 * The conflicts of merging the base tip into the head: each conflicted
 * file, the ones of lines in text files with their contents (markers
 * labelled with the branches' names).
 */
export async function readConflicts(
  deps: LiveReaderDeps,
  at: {
    readonly baseTip: Oid;
    readonly head: Oid;
    readonly baseLabel: string;
    readonly headLabel: string;
  },
  policy: MergePolicy = MERGE_POLICY,
  limits: typeof CONFLICTS_POLICY = CONFLICTS_POLICY,
): Promise<Browsed<ConflictsView>> {
  const baseSha = oidToHex(at.baseTip);
  const headSha = oidToHex(at.head);
  const view = (files: readonly ConflictFile[]) => ({
    ok: true as const,
    value: { baseSha, headSha, snapshot: baseSha + headSha, files },
  });
  const outcome = await mergeOutcome(deps, { ...at, upToDate: false }, policy, {
    headFirst: true,
  });
  if (outcome.kind === "clean") return view([]);
  if (outcome.kind !== "conflicts") return outcomeRefusal(outcome);
  const conflicts = [...outcome.conflicts].sort((a, b) => (a.path < b.path ? -1 : 1));
  try {
    return await withSource(deps, policy, async (live) => {
      // A virtual merge base's files are in no store: read from what made it.
      const virtual = new Map(outcome.virtual.map((o) => [oidToHex(o.oid), o.bytes]));
      const readBlob = async (oid: Oid, maxBytes: number) => {
        const made = virtual.get(oidToHex(oid));
        if (!made) return live.readBlob(oid, maxBytes);
        return made.length > maxBytes ? undefined : made;
      };
      const files: ConflictFile[] = [];
      let editable = 0;
      let bytes = 0;
      for (const conflict of conflicts) {
        const listed = { path: conflict.path, kind: conflict.kind, content: null, conflicts: 0 };
        if (!ofLines(conflict) || editable >= limits.maxEditableFiles) {
          files.push({ ...listed, editable: false });
          continue;
        }
        const read = (oid: Oid | undefined) =>
          oid ? readBlob(oid, policy.maxFileBytes) : Promise.resolve(new Uint8Array(0));
        // An `add_add` file has no base file (its base may be a symlink or a submodule): empty,
        // as the merge took it.
        const [base, ours, theirs] = await Promise.all([
          read(conflict.kind === "content" ? conflict.base?.oid : undefined),
          read(conflict.ours?.oid),
          read(conflict.theirs?.oid),
        ]);
        if (
          !base ||
          !ours ||
          !theirs ||
          !editableText({ path: conflict.pathBytes, base, ours, theirs })
        ) {
          files.push({ ...listed, editable: false });
          continue;
        }
        const merged = mergeFiles(base, ours, theirs);
        if (merged.kind !== "conflict") {
          files.push({ ...listed, editable: false });
          continue;
        }
        const marked = withConflictMarkers(
          merged.regions,
          { ours: at.headLabel, theirs: at.baseLabel },
          { base, ours, theirs },
        );
        bytes += marked.length;
        const text = utf8(marked) as string;
        if (bytes > limits.maxContentBytes) return TOO_EXPENSIVE;
        editable++;
        files.push({ ...listed, editable: true, content: text, conflicts: merged.conflicts });
      }
      return view(files);
    });
  } catch (error) {
    if (error instanceof ReadBudgetError || error instanceof MergeTooLargeError)
      return TOO_EXPENSIVE;
    if (error instanceof UnreadableObjectError) return UNREADABLE;
    throw error;
  }
}

/** The text of `bytes`, or undefined when they are not UTF-8 (such a file is not resolved here). */
function utf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** A merge of the base tip into the head, committed on the head branch. */
export interface BaseMerge {
  readonly writer: WriterOf<FileWriteInput>;
  /** The head branch, as a full ref name. */
  readonly headRef: string;
  readonly baseTip: Oid;
  readonly head: Oid;
  /** Contents for the files whose lines conflict, by path (UTF-8; none to update a branch). */
  readonly resolutions: ReadonlyMap<string, Uint8Array>;
  /** A resolution of conflicts (else a branch update, refused on any). */
  readonly resolving: boolean;
  readonly author: GitPerson;
  readonly committer: GitPerson;
  readonly message: string;
  /** The caller's part of the commit point (its fence). */
  readonly meta: Omit<PushLogMeta, "repoId" | "requestId">;
  /** Runs with the commit stored, before it is finished. For tests. */
  readonly beforeFinish?: () => Promise<void>;
  /** The head branch is in another repository: the commit is handed over to it. */
  readonly send?: WriteElsewhere["send"];
}

/** A resolution committed; `markers` names the files given that still hold conflict markers. */
export interface MergedIntoHead extends MergeMade {
  readonly markers: readonly string[];
}

/** A line git writes to mark a conflict, at the start of a line. */
const MARKER = /^(?:<{7}|={7}|>{7})(?: |$)/m;

/**
 * Merges the base tip into the head, the given contents taking the place
 * of conflicting lines, and moves the head branch to the merge (from the
 * head only). Every conflict must be resolved, and every path given must
 * be one of them.
 */
export async function mergeIntoHead(
  deps: FileWriteDeps,
  run: BaseMerge,
  policy: MergePolicy = MERGE_POLICY,
): Promise<Browsed<MergedIntoHead>> {
  // Each given file resolves the file of exactly that path (as UTF-8 bytes), when it is editable.
  const used = new Set<string>();
  const notText: string[] = [];
  const resolve = (file: LinesConflict) => {
    // Not resolvable here, given or not: named as such rather than as missing.
    if (!editableText(file)) {
      notText.push(new TextDecoder().decode(file.path));
      return undefined;
    }
    const path = utf8(file.path) as string;
    const given = run.resolutions.get(path);
    if (given === undefined) return undefined;
    used.add(path);
    return given;
  };
  const made = await commitMerge(
    deps,
    async (): Promise<Browsed<MergeCommit>> => {
      const outcome = await mergeOutcome(
        deps,
        { baseTip: run.baseTip, head: run.head, upToDate: false },
        policy,
        { headFirst: true, resolve },
      );
      if (run.resolving && notText.length > 0)
        return fail(
          422,
          "not_editable",
          `These files are not UTF-8 text and cannot be resolved here (merge locally and push): ${notText.slice(0, 10).join(", ")}.`,
        );
      if (outcome.kind === "conflicts") return unresolved(outcome.conflicts, run.resolving);
      if (outcome.kind !== "clean") return outcomeRefusal(outcome);
      const unused = [...run.resolutions.keys()].filter((p) => !used.has(p));
      if (unused.length > 0)
        return fail(
          422,
          "not_conflicted",
          `These files have no conflicting lines to resolve: ${unused.slice(0, 10).join(", ")}.`,
        );
      return {
        ok: true,
        value: {
          writer: run.writer,
          ref: run.headRef,
          old: run.head,
          tree: outcome.tree,
          objects: outcome.objects,
          parents: [run.head, run.baseTip],
          author: run.author,
          committer: run.committer,
          message: run.message,
          meta: () => ({ ...run.meta, via: "api" }),
          onRefused: refused,
          ...(run.beforeFinish && { beforeFinish: run.beforeFinish }),
          ...(run.send && { send: run.send }),
        },
      };
    },
    policy,
  );
  if (!made.ok) return made;
  const decoder = new TextDecoder();
  const markers = [...run.resolutions]
    .filter(([, bytes]) => MARKER.test(decoder.decode(bytes)))
    .map(([path]) => path)
    .sort();
  return { ok: true, value: { ...made.value, markers } };
}

/** A merge into the head refused for the conflicts left. */
function unresolved(conflicts: readonly MergeConflict[], resolving: boolean): BrowseFailure {
  const shown = conflicts
    .slice(0, MERGE_POLICY.conflictsShown)
    .map((c) => `${c.path} (${c.kind.replaceAll("_", "/")})`);
  const more = conflicts.length - shown.length;
  const list = `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
  if (!resolving)
    return fail(422, "merge_conflict", `The head conflicts with the base branch: ${list}.`);
  const byHand = conflicts.filter((c) => !ofLines(c));
  return fail(
    422,
    byHand.length > 0 ? "not_editable" : "unresolved",
    byHand.length > 0
      ? `Some conflicts cannot be resolved here (merge locally and push): ${list}.`
      : `Every conflicted file needs its resolved contents: ${list}.`,
  );
}
