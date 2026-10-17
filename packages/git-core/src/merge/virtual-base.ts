import { type Oid, oidToHex } from "../object/oid.js";
import { parseTree } from "../object/tree.js";
import {
  MergeBudget,
  mergeTrees,
  type NewObject,
  type ObjectSource,
  type TreeMergeOptions,
} from "./merge-trees.js";

/*
 * The base of a three-way merge when there is more than one merge base (a
 * criss-cross history): the merge bases are merged among themselves, each
 * pair from its own merge bases, into a virtual base. A conflict in that
 * merge leaves no base to merge from: the result is `manual`, where git
 * would build a base holding conflict markers. The recursion is bounded,
 * and every step spends from one budget.
 */

export interface History {
  /** The merge bases of `one` against all of `others`, as merge bases are found for a merge of several. */
  mergeBases(one: Oid, others: readonly Oid[]): Promise<Oid[]>;
  /** A commit's tree. */
  treeOf(commit: Oid): Promise<Oid>;
}

export type BaseTree =
  /** The tree to merge from (null when the sides share no history: an empty base). */
  | { readonly kind: "tree"; readonly tree: Oid | null; readonly objects: readonly NewObject[] }
  /** The merge bases conflict among themselves: the merge needs a person. */
  | { readonly kind: "manual" };

/** Deepest recursion of virtual bases. Proposed. */
export const MAX_VIRTUAL_DEPTH = 8;

/** The base tree for merging commits whose merge bases are `bases`. */
export async function baseTreeOf(
  source: ObjectSource,
  history: History,
  bases: readonly Oid[],
  options: TreeMergeOptions = {},
  depth = 0,
): Promise<BaseTree> {
  const [first, ...rest] = bases;
  if (!first) return { kind: "tree", tree: null, objects: [] };
  if (rest.length === 0) return { kind: "tree", tree: await history.treeOf(first), objects: [] };
  if (depth >= MAX_VIRTUAL_DEPTH) return { kind: "manual" };
  // One budget for every step, however many bases and levels.
  const shared = { ...options, budget: options.budget ?? new MergeBudget() };
  // Merge the bases one by one into a running virtual base, each step from
  // the merge bases of the next one against those already merged. What the
  // steps make is read from here: it is in no store yet.
  const objects: NewObject[] = [];
  const made = new Map<string, NewObject>();
  const overlay: ObjectSource = {
    readTree: async (oid) => {
      const object = made.get(oidToHex(oid));
      return object ? parseTree(object.bytes).value : source.readTree(oid);
    },
    readBlob: async (oid, maxBytes) => {
      const object = made.get(oidToHex(oid));
      if (!object) return source.readBlob(oid, maxBytes);
      return object.bytes.length > maxBytes ? undefined : object.bytes;
    },
  };
  const keep = (list: readonly NewObject[]) => {
    for (const object of list) {
      objects.push(object);
      made.set(oidToHex(object.oid), object);
    }
  };
  let tree = await history.treeOf(first);
  const merged: Oid[] = [first];
  for (const next of rest) {
    const under = await baseTreeOf(
      overlay,
      history,
      await history.mergeBases(next, merged),
      shared,
      depth + 1,
    );
    if (under.kind === "manual") return under;
    keep(under.objects);
    const result = await mergeTrees(overlay, under.tree, tree, await history.treeOf(next), shared);
    if (result.kind === "conflicts") return { kind: "manual" };
    keep(result.objects);
    tree = result.tree;
    merged.push(next);
  }
  return { kind: "tree", tree, objects };
}
