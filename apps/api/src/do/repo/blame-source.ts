// The repository's blame source: the only port the blame walk sees, over
// one request's reader and the verified commit graph. It reads one object
// at a time with `readHeader` and `readObject` and nothing else, so the
// reader's limits and its work meter cover every read; and it charges that
// meter for every tree it scans or hands out to be scanned, which the reader
// can't see.
import type { BoundedCommit } from "@fyrden/adapters-cloudflare/git";
import {
  type BlameCommitInfo,
  BlameObjectUnreadable,
  BlameReadsSpent,
  type BlameSource,
  type Commit,
  GitObjectError,
  type ObjectReader,
  type ObjectType,
  type Oid,
  oidToHex,
  parseCommit,
  type ReaderWork,
  treeEntries,
} from "@fyrden/git-core";
import { ReadBudgetError } from "../../git/live-reader.js";

/** Past this many parents a commit's lines are refused, before any diff. */
export const BLAME_MAX_PARENTS = 16;

/**
 * The most of a commit object read for its facts. A larger one answers
 * "too_large", and the walk refuses its own lines. Every field of a commit
 * this size or smaller fits a checkpoint's two-byte length, since the tree
 * line comes first. Measured: no public history on hand had a commit over
 * 64 KiB.
 */
export const MAX_COMMIT_INFO_BYTES = 64 * 1024;

// A tree entry's kind is its mode's type bits, as push validation reads them, so a
// legacy mode such as 120755 is still a symlink.
const TYPE_BITS = 0o170000;
const TREE_TYPE = 0o040000;
const FILE_TYPE = 0o100000;
const SYMLINK_TYPE = 0o120000;

/** What git counts as blank when it looks for a commit's summary: space, tab, CR. */
const BLANK = new Set([0x20, 0x09, 0x0d]);

type Reads = Pick<ObjectReader, "readHeader" | "readObject">;
type Graph = { readBounded(oid: Oid, maxParents: number): BoundedCommit | undefined };

/** The walk's source, with the tree reads its rename checks make. */
export type RepoBlameSource = BlameSource & {
  tree(oid: Oid, maxBytes: number): Promise<Uint8Array | "too_large">;
};

/**
 * `work` is the request's meter, the one its reader charges: a tree's scan is
 * charged on it, by its size, before the tree is scanned.
 */
export function repoBlameSource(reader: Reads, graph: Graph, work: ReaderWork): RepoBlameSource {
  const size = async (oid: Oid, type: ObjectType): Promise<number> => {
    const found = await spent(() => reader.readHeader(oid));
    if (found?.type !== type) throw missing(oid, type);
    return found.size;
  };
  const body = async (oid: Oid, type: ObjectType): Promise<Uint8Array> => {
    const found = await spent(() => reader.readObject(oid));
    if (found?.type !== type) throw missing(oid, type);
    return found.bytes;
  };

  return {
    async commit(oid) {
      return graph.readBounded(oid, BLAME_MAX_PARENTS);
    },

    // A tree that can't be read is unreadable, never "nothing there": in a
    // parent, null means the file isn't there, and its lines would settle on
    // the child.
    async fileAt(tree, path) {
      let current = tree;
      for (let depth = 0; depth < path.length; depth++) {
        const bytes = await body(current, "tree");
        work.charge("tree-scan", bytes.length);
        const entry = parsed(current, () => find(bytes, path[depth] as Uint8Array));
        if (!entry) return null;
        const type = entry.mode & TYPE_BITS;
        if (depth === path.length - 1) {
          // A directory, a submodule or anything else that isn't a blob has no file here.
          if (type === FILE_TYPE) return { oid: entry.oid, kind: "file" };
          if (type === SYMLINK_TYPE) return { oid: entry.oid, kind: "symlink" };
          return null;
        }
        if (type !== TREE_TYPE) return null;
        current = entry.oid;
      }
      return null;
    },

    async tree(oid, maxBytes) {
      if ((await size(oid, "tree")) > maxBytes) return "too_large";
      const bytes = await body(oid, "tree");
      work.charge("tree-scan", bytes.length);
      return bytes;
    },

    async blob(oid, maxBytes) {
      if ((await size(oid, "blob")) > maxBytes) return "too_large";
      return body(oid, "blob");
    },

    async commitInfo(oid): Promise<BlameCommitInfo | "too_large"> {
      if ((await size(oid, "commit")) > MAX_COMMIT_INFO_BYTES) return "too_large";
      const bytes = await body(oid, "commit");
      const commit = parsed(oid, () => parseCommit(bytes).value);
      const text = fieldDecoder(commit);
      const line = summaryLine(commit.message);
      return {
        // As git blame's porcelain says it: the commit id in parentheses when there's none.
        summary: line ? text.decode(line) : `(${oidToHex(oid)})`,
        name: text.decode(commit.author.name),
        email: text.decode(commit.author.email),
        date: authorDate(bytes),
      };
    },
  };
}

/** The entry named `name`, scanned in place, as browse's path lookup does. */
function find(tree: Uint8Array, name: Uint8Array): { mode: number; oid: Oid } | undefined {
  for (const e of treeEntries(tree)) {
    if (e.name.length === name.length && e.name.every((b, i) => b === name[i]))
      return { mode: e.mode, oid: e.oid.slice() as Oid };
  }
  return undefined;
}

/**
 * The first line of a message that isn't blank, without its line feed. Git
 * reads a message only up to its first NUL.
 */
function summaryLine(whole: Uint8Array): Uint8Array | undefined {
  const nul = whole.indexOf(0);
  const message = nul === -1 ? whole : whole.subarray(0, nul);
  let start = 0;
  while (start < message.length) {
    let end = message.indexOf(0x0a, start);
    if (end === -1) end = message.length;
    for (let k = start; k < end; k++) {
      if (!BLANK.has(message[k] as number)) return message.subarray(start, end);
    }
    start = end + 1;
  }
  return undefined;
}

/**
 * The author date as git blame's porcelain prints it, `author-time` then
 * `author-tz`: epoch seconds and offset, from the author line itself. A
 * number would round past 2^53, and a JavaScript date can't hold every time
 * git can, so neither is used. The commit has parsed, so the line is well
 * formed: no leading zeros, an offset of four digits.
 */
function authorDate(bytes: Uint8Array): string {
  const head = latin1.decode(bytes.subarray(0, headerEnd(bytes)));
  const line = head.split("\n").find((l) => l.startsWith("author ")) ?? "";
  const when = /> [ \t]*(\d+) ([+-]\d{4})$/.exec(line);
  if (!when) throw new BlameObjectUnreadable("an author line without a date");
  return `${when[1]} ${when[2]}`;
}

/** Where a commit's headers end: its first blank line, or its end. */
function headerEnd(bytes: Uint8Array): number {
  for (let k = 0; k + 1 < bytes.length; k++)
    if (bytes[k] === 0x0a && bytes[k + 1] === 0x0a) return k;
  return bytes.length;
}

const latin1 = new TextDecoder("latin1");

/**
 * Decodes a commit's fields as its `encoding` header says (git re-encodes
 * the whole commit, people included), else, or when the encoding is unknown,
 * as UTF-8. Each field is decoded on its own and keeps a leading byte order
 * mark, as git shows it: here it's content, not a mark for a whole stream.
 * Single-byte code pages give one character per byte: a label the runtime
 * maps to a windows- page shows its bytes 0x80 to 0x9F as U+0080 to U+009F.
 */
function fieldDecoder(commit: Commit): { decode(bytes: Uint8Array): string } {
  const header = commit.headers.find((h) => h.key === "encoding");
  const utf8 = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  if (!header) return utf8;
  const name = utf8.decode(header.value).trim().toLowerCase();
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(name, { fatal: false, ignoreBOM: true });
  } catch {
    return utf8;
  }
  if (!decoder.encoding.startsWith("windows-") || /^(windows-|x-cp125|cp125|dos-)/.test(name))
    return decoder;
  return {
    decode: (bytes) => {
      const text = decoder.decode(bytes);
      if (text.length !== bytes.length) return text;
      let out = "";
      for (let i = 0; i < bytes.length; i++) {
        const byte = bytes[i] as number;
        out += byte >= 0x80 && byte <= 0x9f ? String.fromCharCode(byte) : text[i];
      }
      return out;
    },
  };
}

function missing(oid: Oid, type: ObjectType): BlameObjectUnreadable {
  return new BlameObjectUnreadable(`${type} ${oidToHex(oid)} is missing or isn't a ${type}`);
}

/** A read, with a spent request budget told as the walk's own refusal. */
async function spent<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ReadBudgetError) throw new BlameReadsSpent(error.message);
    throw error;
  }
}

/** A parse, with a malformed object told as unreadable: it fails the same way every time. */
function parsed<T>(oid: Oid, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof GitObjectError)
      throw new BlameObjectUnreadable(`${oidToHex(oid)}: ${error.message}`);
    throw error;
  }
}
