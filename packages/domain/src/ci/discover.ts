/*
 * Which workflow files a commit has. `.fyrden/workflows` is used when
 * anything is at that path, otherwise `.github/workflows`; a commit never
 * runs both sets. Something other than a directory at the chosen path, or a
 * listing too large to read, is a refusal, never a reason to look at the
 * other directory. Workflow files are the directory's direct entries with
 * mode 100644 or 100755 named `*.yml` or `*.yaml`. GitHub documents the
 * directory and the two extensions (verified,
 * https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax);
 * whether it reads subdirectories is not documented (unverified), and
 * reading only direct entries is Fyrden's choice. Gitea lists its directory
 * recursively (verified, go-gitea/gitea v1.25.0
 * modules/actions/workflows.go:47-73). Everything else is reported as
 * skipped, so a page can say why a file did not run.
 */

/** The directories workflows are read from, preferred first. */
export const WORKFLOW_DIRECTORIES = [".fyrden/workflows", ".github/workflows"] as const;
export type WorkflowDirectory = (typeof WORKFLOW_DIRECTORIES)[number];

/** Workflow files one commit may have. Proposed. */
export const MAX_WORKFLOW_FILES = 256;
/** Entries a workflow directory may list, workflow files or not. Proposed. */
export const MAX_LISTED_ENTRIES = 1_024;
/** Skipped entries a discovery reports by name (all are counted). */
export const MAX_SKIPPED_REPORTED = 32;
/** UTF-8 bytes of a skipped entry's name kept in the report. */
export const MAX_SKIPPED_NAME_BYTES = 255;

/**
 * An entry of a git tree, as the tree reader gives it. Entries come from a
 * well-formed tree (names unique and without `/`, as git's tree checks
 * require); the reader refuses a tree that is not.
 */
export interface DirectoryEntry {
  /** As stored: bytes, not necessarily UTF-8. */
  readonly name: Uint8Array;
  /** Git's mode, such as 0o100644. */
  readonly mode: number;
  readonly oid: string;
}

/**
 * What is at a workflow directory's path. `absent` when nothing is there,
 * including when a parent (`.fyrden`, `.github`) is not a directory;
 * `too-large` instead of listing more than {@link MAX_LISTED_ENTRIES}.
 */
export type DirectoryListing =
  | { readonly kind: "absent" }
  | { readonly kind: "not-a-directory" }
  | { readonly kind: "too-large" }
  | { readonly kind: "directory"; readonly entries: readonly DirectoryEntry[] };

/**
 * Reads a commit's tree for discovery. `list` rejects on any read failure
 * or resource refusal; discovery lets that rejection through, so a failed
 * read is never taken for an absent directory.
 */
export interface WorkflowTree {
  list(path: WorkflowDirectory): Promise<DirectoryListing>;
}

export interface WorkflowFile {
  /** From the repository root, such as `.github/workflows/ci.yml`. */
  readonly path: string;
  readonly name: string;
  readonly oid: string;
}

export type SkipReason = "not-a-file" | "not-yaml" | "invalid-name";

export interface SkippedEntry {
  /** For display: invalid UTF-8 replaced, cut to {@link MAX_SKIPPED_NAME_BYTES}. */
  readonly name: string;
  readonly reason: SkipReason;
}

export type Discovery =
  | {
      readonly ok: true;
      /** Null when neither directory exists. */
      readonly directory: WorkflowDirectory | null;
      readonly files: readonly WorkflowFile[];
      /** The first {@link MAX_SKIPPED_REPORTED} skipped entries, in listing order. */
      readonly skipped: readonly SkippedEntry[];
      readonly skippedCount: number;
    }
  | {
      readonly ok: false;
      readonly code: "not_a_directory" | "directory_too_large" | "too_many_workflows";
      readonly directory: WorkflowDirectory;
    };

/** Regular files, executable or not; any other mode (legacy 100664, 100777, links, trees) is not one. */
const FILE_MODES: ReadonlySet<number> = new Set([0o100644, 0o100755]);

const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lossy = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
const encoder = new TextEncoder();

/** The commit's workflow files, reading `.github/workflows` only when `.fyrden/workflows` is absent. */
export async function discoverWorkflows(tree: WorkflowTree): Promise<Discovery> {
  for (const directory of WORKFLOW_DIRECTORIES) {
    const listing = await tree.list(directory);
    if (listing.kind === "absent") continue;
    if (listing.kind === "not-a-directory")
      return { ok: false, code: "not_a_directory", directory };
    if (listing.kind === "too-large" || listing.entries.length > MAX_LISTED_ENTRIES) {
      return { ok: false, code: "directory_too_large", directory };
    }
    return filesOf(directory, listing.entries);
  }
  return { ok: true, directory: null, files: [], skipped: [], skippedCount: 0 };
}

function filesOf(directory: WorkflowDirectory, entries: readonly DirectoryEntry[]): Discovery {
  const files: { bytes: Uint8Array; file: WorkflowFile }[] = [];
  const skipped: SkippedEntry[] = [];
  let skippedCount = 0;
  const skip = (bytes: Uint8Array, reason: SkipReason) => {
    skippedCount++;
    if (skipped.length < MAX_SKIPPED_REPORTED) skipped.push({ name: displayName(bytes), reason });
  };
  for (const entry of entries) {
    if (!FILE_MODES.has(entry.mode)) {
      skip(entry.name, "not-a-file");
      continue;
    }
    const name = utf8(entry.name);
    if (name === undefined) {
      skip(entry.name, "invalid-name");
      continue;
    }
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) {
      skip(entry.name, "not-yaml");
      continue;
    }
    files.push({ bytes: entry.name, file: { path: `${directory}/${name}`, name, oid: entry.oid } });
  }
  if (files.length > MAX_WORKFLOW_FILES)
    return { ok: false, code: "too_many_workflows", directory };
  files.sort((a, b) => compareBytes(a.bytes, b.bytes));
  return { ok: true, directory, files: files.map((f) => f.file), skipped, skippedCount };
}

function utf8(bytes: Uint8Array): string | undefined {
  try {
    return strict.decode(bytes);
  } catch {
    return undefined;
  }
}

/** `bytes` as text for display, cut to whole characters within the byte bound. */
function displayName(bytes: Uint8Array): string {
  const text = lossy.decode(bytes.subarray(0, MAX_SKIPPED_NAME_BYTES + 4));
  if (encoder.encode(text).length <= MAX_SKIPPED_NAME_BYTES) return text;
  let kept = "";
  let size = 0;
  for (const char of text) {
    size += encoder.encode(char).length;
    if (size > MAX_SKIPPED_NAME_BYTES) break;
    kept += char;
  }
  return kept;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}
