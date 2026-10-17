import { expect } from "vitest";
import { MergeLimitError, type NewObject, type TreeMerge } from "../../src/merge/merge-trees.js";
import { type Oid, oidToHex } from "../../src/object/oid.js";
import { parseTree, type TreeEntry } from "../../src/object/tree.js";

export const enc = new TextEncoder();
export const dec = new TextDecoder();

/** Trees and blobs by hex id, built here. */
export function store() {
  const objects = new Map<string, TreeEntry[] | Uint8Array>();
  let n = 0;
  const put = (value: TreeEntry[] | Uint8Array): Oid => {
    const oid = new Uint8Array(20) as Oid;
    new DataView(oid.buffer).setUint32(0, ++n);
    objects.set(oidToHex(oid), value);
    return oid;
  };
  // Equal content, equal id (as git's are).
  const blobs = new Map<string, Oid>();
  const blob = (text: string) => {
    let oid = blobs.get(text);
    if (!oid) {
      oid = put(enc.encode(text));
      blobs.set(text, oid);
    }
    return oid;
  };
  const tree = (entries: Record<string, { mode?: number; oid: Oid }>) =>
    put(
      Object.entries(entries)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([name, e]) => ({ name: enc.encode(name), mode: e.mode ?? 0o100644, oid: e.oid })),
    );
  // A tree of entries as given (names as bytes).
  const rawTree = (entries: TreeEntry[]) => put(entries);
  const source = {
    readTree: async (oid: Oid) => objects.get(oidToHex(oid)) as TreeEntry[],
    readBlob: async (oid: Oid, maxBytes: number) => {
      const bytes = objects.get(oidToHex(oid)) as Uint8Array;
      return bytes.length > maxBytes ? undefined : bytes;
    },
  };
  return { blob, tree, rawTree, source };
}

/** A tree's entries as [name, mode in octal, id in hex], from the merge's new objects or the store. */
export async function listed(s: ReturnType<typeof store>, tree: Oid, made: readonly NewObject[]) {
  const found = made.find((o) => oidToHex(o.oid) === oidToHex(tree));
  const list = found ? parseTree(found.bytes).value : await s.source.readTree(tree);
  return list.map((e) => [dec.decode(e.name), e.mode.toString(8), oidToHex(e.oid)]);
}

/** A merge's conflicts as [path, kind], or its kind when clean. */
export const kinds = (merged: TreeMerge) =>
  merged.kind === "conflicts" ? merged.conflicts.map((c) => [c.path, c.kind]) : merged.kind;

/** The error a merge stopped with. */
export const stopped = (merge: Promise<unknown>) =>
  merge.then(
    () => expect.fail("the merge finished"),
    (error: unknown) => {
      expect(error).toBeInstanceOf(MergeLimitError);
      const { name, limit, message } = error as MergeLimitError;
      return { name, limit, message };
    },
  );
