import { MemoryWaitTimeoutError } from "@fyrden/adapters-cloudflare/git";
import {
  FILE_MODES,
  GitObjectError,
  isTreeMode,
  type ObjectReader,
  type Oid,
  oidToHex,
  type TreeEntry,
  treeEntries,
} from "@fyrden/git-core";
import { pathSegments } from "../../git/cache/object-check.js";
import { ReadBudgetError } from "../../git/live-reader.js";
import { type Browsed, BUSY, fail, guarded, type RepoBrowse } from "./browse.js";

/*
 * Files and directories at a commit: what a path names (a directory's
 * entries, a file's content, a symlink's target, a submodule's commit),
 * the README, a whole tree listed recursively, and a file's raw bytes.
 * Every answer starts from a commit this repository has (RepoBrowse
 * resolves it) and walks down from that commit's tree, so nothing is read
 * by a bare object id. Trees are read entry by entry (`treeEntries`), so a
 * listing holds what it returns, not whole parsed trees.
 *
 * Names are shown as UTF-8; a name that is not valid UTF-8 is shown with
 * replacement characters and cannot be asked for by path.
 */

/** Limits of the file operations. Proposed. */
export const CONTENTS_POLICY = {
  /** Largest file whose content a JSON answer carries (GitHub's contents API: 1 MiB). */
  maxInlineBytes: 1024 * 1024,
  /** Largest file the raw route serves (Workers RPC carries 32 MiB). */
  maxRawBytes: 24 * 1024 * 1024,
  /** Entries a recursive tree listing returns at most (it is then `truncated`). */
  maxTreeEntries: 10_000,
  /**
   * Bytes of tree bodies a recursive listing holds at once (each directory
   * it is inside, while it lists a deeper one); it stops there, `truncated`.
   */
  maxHeldTreeBytes: 32 * 1024 * 1024,
} as const;

export type EntryType = "file" | "dir" | "symlink" | "submodule";

export interface EntryView {
  readonly type: EntryType;
  readonly name: string;
  readonly path: string;
  readonly sha: string;
  /** Git's mode, in octal (`100644`, `100755`, `120000`, `040000`, `160000`). */
  readonly mode: string;
}

/** Where a directory page starts: the directory's tree and the entry's position in it. */
export interface DirCursor {
  readonly tree: string;
  readonly index: number;
}

export type ContentsView =
  | {
      readonly type: "dir";
      readonly path: string;
      readonly sha: string;
      readonly entries: EntryView[];
      /** Where the next page starts; null on the last. */
      readonly next: DirCursor | null;
    }
  | {
      readonly type: "file";
      readonly path: string;
      readonly name: string;
      readonly sha: string;
      readonly mode: string;
      readonly size: number;
      /** Base64; null when the file is larger than a JSON answer carries. */
      readonly content: string | null;
    }
  | {
      readonly type: "symlink";
      readonly path: string;
      readonly name: string;
      readonly sha: string;
      readonly size: number;
      /** The target as UTF-8 (lossy for other bytes); `content` has its exact bytes. */
      readonly target: string;
      /** The target's bytes, base64. */
      readonly content: string;
    }
  | {
      readonly type: "submodule";
      readonly path: string;
      readonly name: string;
      readonly sha: string;
    };

export interface TreeItem {
  readonly path: string;
  readonly mode: string;
  readonly type: "blob" | "tree" | "commit";
  readonly sha: string;
}

export interface TreeListing {
  /** The commit's tree. */
  readonly sha: string;
  readonly entries: TreeItem[];
  /**
   * Not every entry is listed: too many, more trees than one request may
   * read, or a tree below the root that cannot be read.
   */
  readonly truncated: boolean;
}

/** Subtrees of one directory whose lookups a recursive listing batches at most. */
const PREFETCH_BATCH = 1_000;

const utf8 = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

/** What `path` names in the commit `ref` names, with that commit's id. */
export function contents(
  browse: RepoBrowse,
  input: {
    readonly ref?: string;
    readonly path: string;
    readonly after?: DirCursor;
    readonly limit: number;
  },
): Promise<Browsed<{ commit: string; view: ContentsView }>> {
  return guarded(async () => {
    const at = await browse.resolveTree(input.ref);
    if (!at.ok) return at;
    const segments = pathSegments(input.path);
    if (!segments) return invalidPath(input.path);
    return browse.reading(async (reader) => {
      const found = await walk(reader, at.value.tree, segments, input.path);
      if (!found.ok) return found;
      const view = await viewOf(browse, reader, found.value, input.path, input);
      if (!view.ok) return view;
      return { ok: true, value: { commit: oidToHex(at.value.commit), view: view.value } };
    });
  });
}

/**
 * The README in the root of the commit `ref` names: `README.md`, then other
 * README files by extension (`.md`, `.markdown`, none, `.txt`, ...), then
 * by name.
 */
export function readme(
  browse: RepoBrowse,
  ref: string | undefined,
): Promise<Browsed<{ commit: string; view: ContentsView }>> {
  return guarded(async () => {
    const at = await browse.resolveTree(ref);
    if (!at.ok) return at;
    return browse.reading(async (reader) => {
      const root = await readTree(reader, at.value.tree);
      if (!root) return unreadable();
      // The best so far only: a root can hold very many README.* files.
      let chosen: { entry: TreeEntry; name: string } | undefined;
      for (const entry of treeEntries(root)) {
        if (entry.mode !== FILE_MODES.file && entry.mode !== FILE_MODES.executable) continue;
        if (!isReadmeName(entry.name)) continue;
        const name = utf8.decode(entry.name);
        if (!/^readme(\.[^.]+)?$/i.test(name)) continue;
        if (
          !chosen ||
          readmeRank(name) - readmeRank(chosen.name) < 0 ||
          (readmeRank(name) === readmeRank(chosen.name) && compareText(name, chosen.name) < 0)
        )
          chosen = { entry, name };
      }
      if (!chosen) return fail(404, "readme_not_found", "The repository has no README.");
      const view = await viewOf(browse, reader, chosen.entry, chosen.name, { limit: 0 });
      if (!view.ok) return view;
      return { ok: true, value: { commit: oidToHex(at.value.commit), view: view.value } };
    });
  });
}

const README_ORDER = [".md", ".markdown", "", ".txt", ".rst", ".adoc", ".org"];

/** Whether a name starts with "readme", ignoring ASCII case (before decoding it). */
function isReadmeName(name: Uint8Array): boolean {
  const readme = [0x72, 0x65, 0x61, 0x64, 0x6d, 0x65];
  return name.length >= 6 && readme.every((c, i) => ((name[i] as number) | 0x20) === c);
}

function readmeRank(name: string): number {
  if (name === "README.md") return -1;
  const dot = name.indexOf(".");
  const rank = README_ORDER.indexOf(dot < 0 ? "" : name.slice(dot).toLowerCase());
  return rank < 0 ? README_ORDER.length : rank;
}

/**
 * The tree of the commit `ref` names: its entries, or with `recursive`
 * every entry below it in `git ls-tree -r -t` order. Each directory's
 * subtrees are looked up together. A listing is `truncated` (and ends
 * there) once it holds `maxTreeEntries` entries, once the walk has spent
 * its reads, at a subtree that cannot be read, or at one that would take
 * the tree bodies it holds (the directories it is inside) past
 * `maxHeldTreeBytes`.
 */
export function treeListing(
  browse: RepoBrowse,
  ref: string | undefined,
  recursive: boolean,
  limits: { readonly maxTreeEntries: number; readonly maxHeldTreeBytes: number } = CONTENTS_POLICY,
): Promise<Browsed<TreeListing>> {
  return guarded(async () => {
    const at = await browse.resolveTree(ref);
    if (!at.ok) return at;
    return browse.reading(async (reader) => {
      // Tree bodies the listing keeps while it goes deeper are reserved from
      // the object's memory budget, shared with every request it serves.
      const rootHeader = await reader.readHeader(at.value.tree);
      if (rootHeader?.type !== "tree") return unreadable();
      const rootHold = browse.hold(rootHeader.size);
      if (!rootHold) return BUSY;
      try {
        return await listFrom(at.value.tree, rootHold.bytes);
      } finally {
        rootHold.release();
      }
    });

    async function listFrom(rootTree: Oid, rootBytes: number): Promise<Browsed<TreeListing>> {
      const reader = await browse.reader();
      const root = await readTree(reader, rootTree);
      if (!root) return unreadable();
      const entries: TreeItem[] = [];
      let truncated = false;
      /**
       * Lists `body` (a tree) under `prefix`, holding `held` bytes of tree
       * bodies (this one and its ancestors'); false once the listing has to end.
       */
      const list = async (body: Uint8Array, prefix: string, held: number): Promise<boolean> => {
        if (recursive) {
          const subtrees: Oid[] = [];
          for (const e of treeEntries(body)) {
            if (subtrees.length >= PREFETCH_BATCH) break;
            if (isTreeMode(e.mode)) subtrees.push(e.oid);
          }
          await reader.prefetch(subtrees);
        }
        for (const e of treeEntries(body)) {
          if (entries.length >= limits.maxTreeEntries) return false;
          const path = prefix + utf8.decode(e.name);
          const type = isTreeMode(e.mode)
            ? "tree"
            : e.mode === FILE_MODES.gitlink
              ? "commit"
              : "blob";
          browse.take(2 * path.length + 120);
          entries.push({ path, mode: modeText(e.mode), type, sha: oidToHex(e.oid) });
          if (type !== "tree" || !recursive) continue;
          if (browse.reads >= browse.policy.walkReads) return false;
          const header = await reader.readHeader(e.oid);
          if (header?.type !== "tree" || held + header.size > limits.maxHeldTreeBytes) return false;
          const hold = browse.hold(header.size);
          if (!hold) return false;
          try {
            let child: Uint8Array | undefined;
            try {
              child = await readTree(reader, e.oid);
            } catch (error) {
              // Its delta needed working memory that stayed taken: stop here.
              if (error instanceof MemoryWaitTimeoutError) return false;
              throw error;
            }
            if (!child || !(await list(child, `${path}/`, held + child.length))) return false;
          } finally {
            hold.release();
          }
        }
        return true;
      };
      try {
        truncated = !(await list(root, "", rootBytes));
      } catch (error) {
        // Out of reads mid-walk: what is listed so far, truncated.
        if (!(error instanceof ReadBudgetError) || entries.length === 0) throw error;
        truncated = true;
      }
      return { ok: true, value: { sha: oidToHex(rootTree), entries, truncated } };
    }
  });
}

/** The bytes of the file (or symlink target) `path` names in the commit `ref` names. */
export function rawFile(
  browse: RepoBrowse,
  ref: string | undefined,
  path: string,
  /** The largest file read; a larger one answers 422 `too_large`. */
  maxBytes: number = CONTENTS_POLICY.maxRawBytes,
): Promise<Browsed<{ sha: string; bytes: Uint8Array }>> {
  return guarded(async () => {
    const at = await browse.resolveTree(ref);
    if (!at.ok) return at;
    const segments = pathSegments(path);
    if (!segments || segments.length === 0) return invalidPath(path);
    return browse.reading(async (reader) => {
      const walked = await walk(reader, at.value.tree, segments, path);
      if (!walked.ok) return walked;
      const found = walked.value;
      if (isTreeMode(found.mode) || found.mode === FILE_MODES.gitlink) return notFound(path);
      const header = await reader.readHeader(found.oid);
      if (header?.type !== "blob") return notFound(path);
      if (header.size > maxBytes)
        return fail(
          422,
          "too_large",
          `The file is larger than ${maxBytes} bytes; clone the repository to get it.`,
        );
      const object = await reader.readObject(found.oid);
      if (object?.type !== "blob") return notFound(path);
      return { ok: true, value: { sha: oidToHex(found.oid), bytes: object.bytes } };
    });
  });
}

/**
 * The entry at `segments` below `root` (the root itself for none): 404
 * when a readable tree on the way lacks the next name or the way goes
 * through something other than a directory, 422 when a tree on the way
 * cannot be read.
 */
async function walk(
  reader: ObjectReader,
  root: Oid,
  segments: readonly Uint8Array[],
  path: string,
): Promise<Browsed<TreeEntry>> {
  let entry: TreeEntry = { mode: FILE_MODES.tree, name: new Uint8Array(0), oid: root };
  for (const name of segments) {
    if (!isTreeMode(entry.mode)) return notFound(path);
    const body = await readTree(reader, entry.oid);
    if (!body) return unreadable();
    let next: TreeEntry | undefined;
    for (const e of treeEntries(body))
      if (sameBytes(e.name, name)) {
        next = e;
        break;
      }
    if (!next) return notFound(path);
    entry = next;
  }
  return { ok: true, value: entry };
}

/**
 * A tree's body, its entries checked to be readable (a tree that does not
 * parse, or is not a tree, is undefined).
 */
async function readTree(reader: ObjectReader, oid: Oid): Promise<Uint8Array | undefined> {
  const object = await reader.readObject(oid);
  if (object?.type !== "tree") return undefined;
  try {
    for (const _ of treeEntries(object.bytes));
  } catch (error) {
    if (error instanceof GitObjectError) return undefined;
    throw error;
  }
  return object.bytes;
}

async function viewOf(
  browse: RepoBrowse,
  reader: ObjectReader,
  entry: TreeEntry,
  path: string,
  page: { readonly after?: DirCursor; readonly limit: number },
): Promise<Browsed<ContentsView>> {
  const name = path.split("/").at(-1) ?? "";
  const sha = oidToHex(entry.oid);
  if (isTreeMode(entry.mode)) {
    if (page.after && page.after.tree !== sha)
      return fail(409, "cursor_stale", "The directory changed since that page; start again.");
    const body = await readTree(reader, entry.oid);
    if (!body) return unreadable();
    const prefix = path === "" ? "" : `${path}/`;
    const start = page.after?.index ?? 0;
    const views: EntryView[] = [];
    let index = 0;
    let more = false;
    for (const e of treeEntries(body)) {
      if (index++ < start) continue;
      if (views.length === page.limit) {
        more = true;
        break;
      }
      const entryName = utf8.decode(e.name);
      browse.take(4 * entryName.length + 2 * prefix.length + 160);
      views.push({
        type: entryType(e.mode),
        name: entryName,
        path: prefix + entryName,
        sha: oidToHex(e.oid),
        mode: modeText(e.mode),
      });
    }
    return {
      ok: true,
      value: {
        type: "dir",
        path,
        sha,
        entries: views,
        next: more ? { tree: sha, index: start + views.length } : null,
      },
    };
  }
  if (entry.mode === FILE_MODES.gitlink)
    return { ok: true, value: { type: "submodule", path, name, sha } };
  const header = await reader.readHeader(entry.oid);
  if (header?.type !== "blob") return unreadable();
  if (entry.mode === FILE_MODES.symlink) {
    const target = await reader.readObject(entry.oid);
    if (!target) return unreadable();
    browse.take(6 * target.bytes.length);
    return {
      ok: true,
      value: {
        type: "symlink",
        path,
        name,
        sha,
        size: header.size,
        target: utf8.decode(target.bytes),
        content: toBase64(target.bytes),
      },
    };
  }
  let content: string | null = null;
  if (header.size <= CONTENTS_POLICY.maxInlineBytes) {
    const object = await reader.readObject(entry.oid);
    if (!object) return unreadable();
    browse.take(2 * Math.ceil((object.bytes.length * 4) / 3));
    content = toBase64(object.bytes);
  }
  return {
    ok: true,
    value: {
      type: "file",
      path,
      name,
      sha,
      mode: modeText(entry.mode),
      size: header.size,
      content,
    },
  };
}

function entryType(mode: number): EntryType {
  if (isTreeMode(mode)) return "dir";
  if (mode === FILE_MODES.gitlink) return "submodule";
  if (mode === FILE_MODES.symlink) return "symlink";
  return "file";
}

/** Git's mode text, six digits as `git ls-tree` prints it. */
function modeText(mode: number): string {
  return mode.toString(8).padStart(6, "0");
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

const notFound = (path: string) =>
  fail(404, "path_not_found", `Nothing is at ${path || "the root"} in that commit.`);
const invalidPath = (path: string) => fail(422, "invalid_path", `${path} is not a valid path.`);
const unreadable = () =>
  fail(
    422,
    "tree_unreadable",
    "A tree on that path cannot be read; the repository may be damaged.",
  );
