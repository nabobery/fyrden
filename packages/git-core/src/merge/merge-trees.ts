import { latin1 } from "../diff/text.js";
import { createSha1Hasher } from "../hash/sha1.js";
import { hashObject } from "../object/object.js";
import { type Oid, oidEquals, oidToHex } from "../object/oid.js";
import { encodeTree, isTreeMode, type TreeEntry } from "../object/tree.js";
import { canonicalEntry } from "../write/commit-builder.js";
import { mergeFiles } from "./file-merge.js";

/*
 * Three-way merge of trees, path by path: a side unchanged from the base
 * takes the other side; both changed alike, either; a directory changed on
 * both sides is merged inside; a regular file changed on both, its mode
 * and its content each from the side that changed it, the content line by
 * line (diff3) when both did. Anything else changed on both sides is a
 * conflict, given as data (its kind and the three entries), never as
 * markers in a file. Renames are not followed: a file renamed on one side
 * and changed on the other is a conflict (git would follow it). Written
 * from the semantics of a three-way merge; git is only a test oracle.
 */

export type ConflictKind =
  | "content"
  | "add_add"
  | "modify_delete"
  | "file_directory"
  | "mode"
  | "symlink"
  | "submodule"
  | "binary"
  | "too_large";

export interface Side {
  readonly mode: number;
  readonly oid: Oid;
}

export interface MergeConflict {
  readonly kind: ConflictKind;
  /** The path (bytes) and as UTF-8 text. */
  readonly pathBytes: Uint8Array;
  readonly path: string;
  readonly base: Side | null;
  readonly ours: Side | null;
  readonly theirs: Side | null;
}

/** An object the merge made: write it with the merged tree. */
export interface NewObject {
  readonly oid: Oid;
  readonly type: "blob" | "tree";
  readonly bytes: Uint8Array;
}

export type TreeMerge =
  | { readonly kind: "clean"; readonly tree: Oid; readonly objects: readonly NewObject[] }
  | { readonly kind: "conflicts"; readonly conflicts: readonly MergeConflict[] };

export interface TreeMergeOptions {
  /** The largest side of a file merged line by line; larger ones changed on both sides conflict. */
  readonly maxFileBytes?: number;
  /** One budget for a whole operation (a merge and its virtual bases); one is made when absent. */
  readonly budget?: MergeBudget;
}

export class MergeLimitError extends Error {
  constructor(readonly limit: "trees" | "files" | "output") {
    super(`the merge needs more ${limit} than it may use`);
    this.name = "MergeLimitError";
  }
}

/** What one merge operation may spend, shared by every step of it. Proposed limits. */
export class MergeBudget {
  trees = 0;
  fileMerges = 0;
  outputBytes = 0;

  constructor(
    readonly maxTrees = 2_000,
    readonly maxFileMerges = 1_000,
    /** Bytes of new objects the operation keeps for writing. */
    readonly maxOutputBytes = 16 * 1024 * 1024,
  ) {}

  tree(): void {
    if (++this.trees > this.maxTrees) throw new MergeLimitError("trees");
  }

  fileMerge(): void {
    if (++this.fileMerges > this.maxFileMerges) throw new MergeLimitError("files");
  }

  output(bytes: number): void {
    this.outputBytes += bytes;
    if (this.outputBytes > this.maxOutputBytes) throw new MergeLimitError("output");
  }
}

export interface ObjectSource {
  readTree(oid: Oid): Promise<readonly TreeEntry[]>;
  /**
   * A blob's bytes, or undefined when it is larger than `maxBytes`: a
   * source checks the size before it reads the content.
   */
  readBlob(oid: Oid, maxBytes: number): Promise<Uint8Array | undefined>;
}

const utf8 = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
const SLASH = 0x2f;

type Kind = "tree" | "file" | "link" | "submodule";
function kindOf(mode: number): Kind {
  if (isTreeMode(mode)) return "tree";
  const type = mode & 0o170000;
  return type === 0o120000 ? "link" : type === 0o160000 ? "submodule" : "file";
}

const same = (a: TreeEntry | undefined, b: TreeEntry | undefined) =>
  a === undefined || b === undefined ? a === b : a.mode === b.mode && oidEquals(a.oid, b.oid);

/** Merges `ours` and `theirs` (trees) from `base` (a tree, or null for none). */
export async function mergeTrees(
  source: ObjectSource,
  base: Oid | null,
  ours: Oid,
  theirs: Oid,
  options: TreeMergeOptions = {},
): Promise<TreeMerge> {
  const maxFileBytes = options.maxFileBytes ?? 1024 * 1024;
  const budget = options.budget ?? new MergeBudget();
  const conflicts: MergeConflict[] = [];
  // New objects by id: content made twice is kept once.
  const objects = new Map<string, NewObject>();

  const read = async (oid: Oid | null | undefined) => {
    if (!oid) return [];
    budget.tree();
    return source.readTree(oid);
  };
  const write = async (type: "blob" | "tree", bytes: Uint8Array): Promise<Oid> => {
    const oid = await hashObject(() => createSha1Hasher(), type, bytes);
    const key = oidToHex(oid);
    if (!objects.has(key)) {
      budget.output(bytes.length);
      objects.set(key, { oid, type, bytes });
    }
    return oid;
  };
  const conflict = (
    kind: ConflictKind,
    path: Uint8Array,
    b: TreeEntry | undefined,
    o: TreeEntry | undefined,
    t: TreeEntry | undefined,
  ) => {
    const side = (e: TreeEntry | undefined) => (e ? { mode: e.mode, oid: e.oid } : null);
    conflicts.push({
      kind,
      pathBytes: path,
      path: utf8.decode(path),
      base: side(b),
      ours: side(o),
      theirs: side(t),
    });
  };

  /**
   * The merged tree of three directories at `prefix` (null for one a side
   * does not have): its id, "empty" when nothing is left in it (git keeps
   * no empty directory), or null when something in it conflicts.
   */
  const mergeDir = async (
    prefix: Uint8Array,
    b: Oid | null,
    o: Oid | null,
    t: Oid | null,
  ): Promise<Oid | "empty" | null> => {
    // Modes as git's index gives them (a legacy 100664 is 100644): compared,
    // resolved and written that way.
    const [bs, os, ts] = (await Promise.all([read(b), read(o), read(t)])).map((list) =>
      list.map(canonicalEntry),
    ) as [TreeEntry[], TreeEntry[], TreeEntry[]];
    // A file and a directory of one name are different entries (as in a
    // tree's order): a file deleted where a directory appears is no clash.
    const keyOf = (e: TreeEntry) => latin1(e.name) + (isTreeMode(e.mode) ? "/" : "");
    const byName = (entries: readonly TreeEntry[]) => new Map(entries.map((e) => [keyOf(e), e]));
    const [bm, om, tm] = [byName(bs), byName(os), byName(ts)];
    const keys = [...new Set([...bm.keys(), ...om.keys(), ...tm.keys()])];
    const merged: TreeEntry[] = [];
    /** Names a file, or a directory, stays at (or would, but for a conflict). */
    const fileNames = new Set<string>();
    const dirNames = new Set<string>();
    let clean = true;
    for (const key of keys) {
      const be = bm.get(key);
      const oe = om.get(key);
      const te = tm.get(key);
      const name = (oe ?? te ?? be)?.name as Uint8Array;
      const path = new Uint8Array([...prefix, ...name]);
      let entry: TreeEntry | undefined | null;
      if (same(oe, te)) {
        // Both changed a directory alike: written again inside, as git
        // does, so its legacy modes come out as the index gives them.
        entry =
          oe && isTreeMode(oe.mode) && !same(oe, be)
            ? await asDir(path, oe.name, be && isTreeMode(be.mode) ? be.oid : null, oe.oid, oe.oid)
            : oe;
      } else if (same(oe, be)) entry = te;
      else if (same(te, be)) entry = oe;
      else entry = await mergeEntry(path, be, oe, te);
      if (entry === null) clean = false;
      else if (entry) merged.push(entry);
      // What stays, or what a conflict leaves standing on either side.
      const standing = entry === null ? [oe, te] : [entry];
      for (const e of standing)
        if (e) (isTreeMode(e.mode) ? dirNames : fileNames).add(latin1(e.name));
    }
    // A file and a directory left with one name cannot both be.
    for (const name of fileNames) {
      if (!dirNames.has(name)) continue;
      conflict(
        "file_directory",
        new Uint8Array([
          ...prefix,
          ...((om.get(name) ?? tm.get(name) ?? bm.get(name))?.name ?? []),
        ]),
        bm.get(name) ?? bm.get(`${name}/`),
        om.get(name) ?? om.get(`${name}/`),
        tm.get(name) ?? tm.get(`${name}/`),
      );
      clean = false;
    }
    if (!clean) return null;
    if (merged.length === 0) return "empty";
    return write("tree", encodeTree(merged));
  };

  /** A directory merged in place of an entry: its entry, none when emptied, or null for a conflict. */
  const asDir = async (
    path: Uint8Array,
    name: Uint8Array,
    b: Oid | null,
    o: Oid | null,
    t: Oid | null,
  ): Promise<TreeEntry | undefined | null> => {
    const dir = await mergeDir(new Uint8Array([...path, SLASH]), b, o, t);
    if (dir === null) return null;
    return dir === "empty" ? undefined : { mode: 0o40000, name, oid: dir };
  };

  /** One name both sides changed: its merged entry, undefined for none, or null for a conflict. */
  const mergeEntry = async (
    path: Uint8Array,
    b: TreeEntry | undefined,
    o: TreeEntry | undefined,
    t: TreeEntry | undefined,
  ): Promise<TreeEntry | undefined | null> => {
    const baseTree = b && kindOf(b.mode) === "tree" ? b.oid : null;
    if (!o || !t) {
      // One side deleted a directory the other changed: inside it, each
      // file the other side changed is the conflict (an unchanged one goes).
      const kept = (o ?? t) as TreeEntry;
      if (baseTree && kindOf(kept.mode) === "tree")
        return asDir(path, kept.name, baseTree, o ? o.oid : null, t ? t.oid : null);
      // One side deleted what the other changed.
      conflict("modify_delete", path, b, o, t);
      return null;
    }
    const [ok, tk] = [kindOf(o.mode), kindOf(t.mode)];
    if (ok === "tree" && tk === "tree") return asDir(path, o.name, baseTree, o.oid, t.oid);
    if (ok !== tk || ok === "link" || ok === "submodule") {
      // A symlink or submodule changed differently on both sides, or a change of kind.
      conflict(ok === "link" || tk === "link" ? "symlink" : "submodule", path, b, o, t);
      return null;
    }
    // Both regular files: the mode and the content each from the side that changed it.
    const baseFile = b && kindOf(b.mode) === "file" ? b : undefined;
    let mode: number;
    if (o.mode === t.mode) mode = o.mode;
    else if (o.mode === baseFile?.mode) mode = t.mode;
    else if (t.mode === baseFile?.mode) mode = o.mode;
    else {
      conflict("mode", path, b, o, t);
      return null;
    }
    if (oidEquals(o.oid, t.oid)) return { mode, name: o.name, oid: o.oid };
    if (baseFile && oidEquals(o.oid, baseFile.oid)) return { mode, name: o.name, oid: t.oid };
    if (baseFile && oidEquals(t.oid, baseFile.oid)) return { mode, name: o.name, oid: o.oid };
    budget.fileMerge();
    const empty = new Uint8Array(0);
    const [baseBytes, oursBytes, theirsBytes] = [
      baseFile ? await source.readBlob(baseFile.oid, maxFileBytes) : empty,
      await source.readBlob(o.oid, maxFileBytes),
      await source.readBlob(t.oid, maxFileBytes),
    ];
    if (!baseBytes || !oursBytes || !theirsBytes) {
      conflict("too_large", path, b, o, t);
      return null;
    }
    const merged = mergeFiles(baseBytes, oursBytes, theirsBytes);
    if (merged.kind === "clean")
      return { mode, name: o.name, oid: await write("blob", merged.bytes) };
    conflict(
      merged.kind === "binary"
        ? "binary"
        : merged.kind === "too_large"
          ? "too_large"
          : baseFile
            ? "content"
            : "add_add",
      path,
      b,
      o,
      t,
    );
    return null;
  };

  const tree = await mergeDir(new Uint8Array(0), base, ours, theirs);
  if (tree === null || conflicts.length > 0) return { kind: "conflicts", conflicts };
  // Nothing left at all: the empty tree.
  const root = tree === "empty" ? await write("tree", encodeTree([])) : tree;
  return { kind: "clean", tree: root, objects: [...objects.values()] };
}
