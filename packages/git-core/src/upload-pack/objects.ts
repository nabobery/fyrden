import { OidTable } from "../graph/oid-table.js";
import { latin1 } from "../object/bytes.js";
import type { Oid } from "../object/oid.js";
import { oidToHex } from "../object/oid.js";
import { FILE_MODES, isTreeMode, parseTree, type TreeEntry } from "../object/tree.js";
import type { ObjectReader } from "../reader/object-reader.js";
import { UploadPackError } from "./errors.js";

/** What the object walk reads. */
export type TreeReader = Pick<ObjectReader, "readObject">;

export interface ObjectSelection {
  readonly trees: OidTable;
  readonly blobs: OidTable;
  /**
   * Objects the walk found the client holding: the edge trees and the
   * entries of the edge trees it read. A thin pack may use these as
   * delta bases.
   */
  readonly held: OidTable;
}

interface Level {
  readonly interesting: readonly Oid[];
  readonly uninteresting: readonly Oid[];
}

/**
 * The trees and blobs the client lacks under `roots` (the trees of the
 * commits being sent, and wanted trees), walking path by path alongside
 * `edges`, the root trees of commits the client is proven to have (the
 * approach of git's sparse object walk, `pack.useSparse`). At each
 * directory the edge trees at the same path are read and their entries
 * counted as held by the client; a subtree whose oid they hold is skipped
 * whole, and only changed directories are descended into. Nothing is
 * skipped against a tree the client is not proven to have: a commit at a
 * shallow boundary gets its whole tree even when its parent's is the same.
 * Gitlinks are skipped (their commits live in another repository). Throws
 * `UploadPackError("too-large")` past `maxObjects`.
 */
export async function selectObjects(
  reader: TreeReader,
  roots: readonly Oid[],
  edges: readonly Oid[],
  maxObjects: number,
): Promise<ObjectSelection> {
  const trees = new OidTable();
  const blobs = new OidTable();
  const known = new OidTable();
  for (const edge of edges) known.add(edge);
  const count = () => {
    if (trees.size + blobs.size > maxObjects) {
      throw new UploadPackError(
        "too-large",
        `upload-pack: the fetch needs more than ${maxObjects} objects; fetch less history`,
      );
    }
  };
  const stack: Level[] = [{ interesting: roots, uninteresting: edges }];
  for (let level = stack.pop(); level; level = stack.pop()) {
    const todo = unique(level.interesting.filter((t) => !known.has(t) && !trees.has(t)));
    if (todo.length === 0) continue;
    const held = new Map<string, Oid[]>();
    for (const tree of unique(level.uninteresting)) {
      for (const entry of await entriesOf(reader, tree)) {
        if (entry.mode === FILE_MODES.gitlink) continue;
        known.add(entry.oid);
        if (isTreeMode(entry.mode)) push(held, latin1(entry.name), entry.oid);
      }
    }
    const wanted = new Map<string, Oid[]>();
    for (const tree of todo) {
      if (trees.has(tree)) continue;
      trees.add(tree);
      count();
      for (const entry of await entriesOf(reader, tree)) {
        if (entry.mode === FILE_MODES.gitlink || known.has(entry.oid)) continue;
        if (isTreeMode(entry.mode)) push(wanted, latin1(entry.name), entry.oid);
        else if (!blobs.has(entry.oid)) {
          blobs.add(entry.oid);
          count();
        }
      }
    }
    for (const [name, subtrees] of wanted) {
      stack.push({ interesting: subtrees, uninteresting: held.get(name) ?? [] });
    }
  }
  return { trees, blobs, held: known };
}

function push(map: Map<string, Oid[]>, key: string, oid: Oid): void {
  const list = map.get(key);
  if (list) list.push(oid);
  else map.set(key, [oid]);
}

function unique(oids: readonly Oid[]): Oid[] {
  if (oids.length < 2) return [...oids];
  const seen = new OidTable(oids.length);
  return oids.filter((oid) => {
    const before = seen.size;
    return seen.add(oid) === before;
  });
}

async function entriesOf(reader: TreeReader, oid: Oid): Promise<TreeEntry[]> {
  const object = await reader.readObject(oid);
  if (object?.type !== "tree") {
    throw new Error(`tree ${oidToHex(oid)} is ${object ? `a ${object.type}` : "missing"}`);
  }
  return parseTree(object.bytes).value;
}
