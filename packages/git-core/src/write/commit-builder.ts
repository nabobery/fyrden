import { type Commit, encodeCommit } from "../object/commit.js";
import type { Ident } from "../object/ident.js";
import { hashObject, type ObjectType } from "../object/object.js";
import { type Oid, oidToHex } from "../object/oid.js";
import { encodeTree, FILE_MODES, isTreeMode, type TreeEntry } from "../object/tree.js";
import type { HasherFactory } from "../ports/hasher.js";
import type { Signer } from "../ports/signer.js";

/*
 * Builds the objects of one commit that changes files: blobs for the new
 * contents, the trees on the paths that changed (every other subtree is
 * reused by id), and the commit, signed when a signer is given. Nothing is
 * stored here; the caller writes the objects (as a pack) and moves the ref.
 */

/** One file to write or delete, by its path from the root (`a/b/c.txt`, UTF-8 names). */
export type FileChange =
  | {
      readonly path: readonly Uint8Array[];
      readonly content: Uint8Array;
      /** Default: a regular file (an existing file keeps its mode). */
      readonly mode?: "file" | "executable";
    }
  | { readonly path: readonly Uint8Array[]; readonly delete: true };

/** Reads a tree of the base commit; undefined when it is not a tree. */
export type TreeLookup = (oid: Oid) => Promise<readonly TreeEntry[] | undefined>;

export interface BuildCommitInput {
  /** The parent's tree; null for a first commit. */
  readonly baseTree: Oid | null;
  readonly readTree: TreeLookup;
  readonly changes: readonly FileChange[];
  readonly parents: readonly Oid[];
  readonly author: Ident;
  readonly committer: Ident;
  readonly message: Uint8Array;
  readonly signer?: Signer;
  readonly createHasher: HasherFactory;
}

export interface BuiltObject {
  readonly type: ObjectType;
  readonly oid: Oid;
  readonly data: Uint8Array;
}

export interface BuiltCommit {
  readonly commit: Oid;
  readonly tree: Oid;
  /** Every object written (blobs, changed trees, the commit), each once; some may exist already. */
  readonly objects: readonly BuiltObject[];
  /** The blob id each written path got, in the order of `changes`. */
  readonly blobs: readonly (Oid | null)[];
}

export type CommitBuildErrorCode =
  /** Two changes name the same path, or one is inside another. */
  | "path_conflict"
  /** A deleted path is not a file in the base tree. */
  | "not_found"
  /** A written path goes through a file, or names a directory or submodule. */
  | "not_a_file"
  /** The commit would change nothing. */
  | "no_change";

export class CommitBuildError extends Error {
  override name = "CommitBuildError";
  constructor(
    readonly code: CommitBuildErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

/** Changes under one directory: files by name, subdirectories by name. */
interface Dir {
  readonly files: Map<
    string,
    { readonly name: Uint8Array; readonly change: FileChange; readonly index: number }
  >;
  readonly dirs: Map<string, { readonly name: Uint8Array; readonly dir: Dir }>;
}

const newDir = (): Dir => ({ files: new Map(), dirs: new Map() });
const keyOf = (name: Uint8Array) => Array.prototype.join.call(name, ",");
const utf8 = new TextDecoder();
const shown = (path: readonly Uint8Array[]) => path.map((p) => utf8.decode(p)).join("/");

/**
 * Builds the commit `input` describes. Throws `CommitBuildError` for
 * changes that do not fit the base tree, RangeError for a path git could
 * not store (empty, `.`/`..`, a NUL or a slash in a name).
 */
export async function buildCommit(input: BuildCommitInput): Promise<BuiltCommit> {
  const root = newDir();
  input.changes.forEach((change, index) => {
    if (change.path.length === 0) throw new RangeError("a change needs a path");
    let dir = root;
    for (const [depth, name] of change.path.entries()) {
      checkName(name);
      const key = keyOf(name);
      if (depth === change.path.length - 1) {
        if (dir.files.has(key) || dir.dirs.has(key))
          throw new CommitBuildError(
            "path_conflict",
            shown(change.path),
            `${shown(change.path)} is changed twice.`,
          );
        dir.files.set(key, { name, change, index });
      } else {
        if (dir.files.has(key))
          throw new CommitBuildError(
            "path_conflict",
            shown(change.path),
            `${shown(change.path)} is inside a file the same commit changes.`,
          );
        let next = dir.dirs.get(key);
        if (!next) {
          next = { name, dir: newDir() };
          dir.dirs.set(key, next);
        }
        dir = next.dir;
      }
    }
  });

  const objects = new Map<string, BuiltObject>();
  const blobs: (Oid | null)[] = input.changes.map(() => null);
  const store = async (type: ObjectType, data: Uint8Array): Promise<Oid> => {
    const oid = await hashObject(input.createHasher, type, data);
    const hex = oidToHex(oid);
    if (!objects.has(hex)) objects.set(hex, { type, oid, data });
    return oid;
  };

  /** The new tree of `dir` over `base` (null: no tree there yet); null when it ends up empty. */
  const apply = async (dir: Dir, base: Oid | null, path: Uint8Array[]): Promise<Oid | null> => {
    const entries = new Map<string, TreeEntry>();
    if (base) {
      const read = await input.readTree(base);
      if (!read) throw new Error(`tree ${oidToHex(base)} is missing`);
      for (const entry of read) entries.set(keyOf(entry.name), entry);
    }
    for (const [key, { name, change, index }] of dir.files) {
      const existing = entries.get(key);
      const where = shown([...path, name]);
      if ("delete" in change) {
        if (!existing || isTreeMode(existing.mode) || existing.mode === FILE_MODES.gitlink)
          throw new CommitBuildError("not_found", where, `${where} is not a file.`);
        entries.delete(key);
        continue;
      }
      if (existing && (isTreeMode(existing.mode) || existing.mode === FILE_MODES.gitlink))
        throw new CommitBuildError("not_a_file", where, `${where} is a directory or a submodule.`);
      const oid = await store("blob", change.content);
      blobs[index] = oid;
      const mode =
        change.mode === "executable"
          ? FILE_MODES.executable
          : change.mode === "file"
            ? FILE_MODES.file
            : existing?.mode === FILE_MODES.executable
              ? FILE_MODES.executable
              : FILE_MODES.file;
      entries.set(key, { mode, name, oid });
    }
    for (const [key, { name, dir: child }] of dir.dirs) {
      const existing = entries.get(key);
      const where = shown([...path, name]);
      if (existing && !isTreeMode(existing.mode))
        throw new CommitBuildError("not_a_file", where, `${where} is a file, not a directory.`);
      const tree = await apply(child, existing?.oid ?? null, [...path, name]);
      if (tree === null) entries.delete(key);
      else entries.set(key, { mode: FILE_MODES.tree, name, oid: tree });
    }
    if (entries.size === 0) return null;
    return store("tree", encodeTree([...entries.values()].map(canonicalEntry)));
  };

  const tree = (await apply(root, input.baseTree, [])) ?? (await store("tree", encodeTree([])));
  if (input.baseTree && oidToHex(tree) === oidToHex(input.baseTree))
    throw new CommitBuildError("no_change", "", "The commit would change nothing.");

  const unsigned: Commit = {
    tree,
    parents: input.parents,
    author: input.author,
    committer: input.committer,
    headers: [],
    message: input.message,
  };
  const commit: Commit = input.signer
    ? {
        ...unsigned,
        headers: [{ key: "gpgsig", value: await input.signer.sign(encodeCommit(unsigned)) }],
      }
    : unsigned;
  const oid = await store("commit", encodeCommit(commit));
  return { commit: oid, tree, objects: [...objects.values()], blobs };
}

/**
 * An entry with the mode git's index gives it (`canon_mode`): a regular
 * file is 100755 when executable by its owner, else 100644, so a legacy
 * mode such as 100664 in an untouched sibling is rewritten as git would.
 */
export function canonicalEntry(entry: TreeEntry): TreeEntry {
  if ((entry.mode & 0o170000) !== 0o100000) return entry;
  const mode = entry.mode & 0o100 ? FILE_MODES.executable : FILE_MODES.file;
  return mode === entry.mode ? entry : { ...entry, mode };
}

function checkName(name: Uint8Array): void {
  const text = utf8.decode(name);
  if (
    name.length === 0 ||
    text === "." ||
    text === ".." ||
    text.toLowerCase() === ".git" ||
    name.includes(0) ||
    name.includes(0x2f)
  )
    throw new RangeError(
      "a path segment must be a non-empty name without NUL or '/', and not '.', '..' or '.git'",
    );
}
