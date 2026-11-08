// The repository's blame source: the only port the blame walk sees, over
// one request's reader and the verified commit graph. It reads one object
// at a time with `readHeader` and `readObject` and nothing else, so the
// reader's limits and its work meter cover every read.
import type { BoundedCommit } from "@fyrden/adapters-cloudflare/git";
import {
  type BlameCommitInfo,
  BlameObjectUnreadable,
  BlameReadsSpent,
  type BlameSource,
  GitObjectError,
  isTreeMode,
  type ObjectReader,
  type ObjectType,
  type Oid,
  oidToHex,
  parseCommit,
  treeEntries,
} from "@fyrden/git-core";
import { ReadBudgetError } from "../../git/live-reader.js";
import { decoderFor, person } from "./browse.js";

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

const SYMLINK_MODE = 0o120000;
const GITLINK_MODE = 0o160000;

/** What git counts as blank when it looks for a commit's summary: space, tab, CR. */
const BLANK = new Set([0x20, 0x09, 0x0d]);

type Reads = Pick<ObjectReader, "readHeader" | "readObject">;
type Graph = { readBounded(oid: Oid, maxParents: number): BoundedCommit | undefined };

export function repoBlameSource(reader: Reads, graph: Graph): BlameSource {
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
        const entry = parsed(current, () => find(bytes, path[depth] as Uint8Array));
        if (!entry) return null;
        if (depth === path.length - 1) {
          if (isTreeMode(entry.mode) || entry.mode === GITLINK_MODE) return null;
          return { oid: entry.oid, kind: entry.mode === SYMLINK_MODE ? "symlink" : "file" };
        }
        if (!isTreeMode(entry.mode)) return null;
        current = entry.oid;
      }
      return null;
    },

    async blob(oid, maxBytes) {
      if ((await size(oid, "blob")) > maxBytes) return "too_large";
      return body(oid, "blob");
    },

    async commitInfo(oid): Promise<BlameCommitInfo | "too_large"> {
      if ((await size(oid, "commit")) > MAX_COMMIT_INFO_BYTES) return "too_large";
      const bytes = await body(oid, "commit");
      const commit = parsed(oid, () => parseCommit(bytes).value);
      const text = decoderFor(commit);
      const author = person(commit.author, text);
      const line = summaryLine(commit.message);
      return {
        // As git blame's porcelain says it: the commit id in parentheses when there's none.
        summary: line ? text.decode(line) : `(${oidToHex(oid)})`,
        name: author.name,
        email: author.email,
        date: author.date,
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

/** The first line of a message that isn't blank, without its line feed. */
function summaryLine(message: Uint8Array): Uint8Array | undefined {
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
