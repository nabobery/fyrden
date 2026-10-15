import { compareOids, type Oid, oidToHex } from "../object/oid.js";
import type { CommitGraph, CommitGraphView } from "../ports/commit-graph.js";
import { MissingCommitError, WalkLimitError } from "./errors.js";
import { OidTable } from "./oid-table.js";

export interface WalkOptions {
  /**
   * Most commits a walk may load before it fails with `WalkLimitError`.
   * Unlimited by default; request paths that must stay bounded (want
   * validation, for example) set it and fail closed.
   */
  readonly maxCommits?: number;
  /** Keeps each loaded commit's tree (`treeOf`), for walks that read trees. */
  readonly keepTrees?: boolean;
}

/**
 * The commits one walk has touched, numbered by an `OidTable`, with their
 * generation, date, flags and parent lists in flat typed arrays (about 60
 * bytes per commit before growth slack, no object per commit). Rows are
 * loaded from the `CommitGraph` port on demand, in one read per batch.
 *
 * The per-commit arrays are replaced when they grow, so read them through
 * the walk (`walk.flags[i]`) rather than keeping a reference across `load`.
 */
export class CommitWalk {
  readonly oids = new OidTable();
  generation = new Float64Array(64);
  date = new Float64Array(64);
  /** Free for the algorithm running the walk. */
  flags = new Uint8Array(64);
  #loaded = new Uint8Array(64);
  #parentStart = new Int32Array(64);
  #parentCount = new Int32Array(64);
  #parents = new Int32Array(256);
  #parentsUsed = 0;
  #loadedCount = 0;
  readonly #graph: CommitGraph;
  readonly #view: CommitGraphView;
  readonly #maxCommits: number;
  readonly #trees: Map<number, Oid> | undefined;

  constructor(graph: CommitGraph, view: CommitGraphView, options: WalkOptions = {}) {
    this.#graph = graph;
    this.#view = view;
    this.#maxCommits = options.maxCommits ?? Number.POSITIVE_INFINITY;
    if (options.keepTrees) this.#trees = new Map();
  }

  /** The tree of loaded commit `i`; only for a walk made with `keepTrees`. */
  treeOf(i: number): Oid {
    const tree = this.#trees?.get(i);
    if (!tree) throw new Error("the walk keeps no tree for this commit");
    return tree;
  }

  /** The walk index of `oid`, added unloaded if new. */
  intern(oid: Oid): number {
    const index = this.oids.add(oid);
    if (index >= this.flags.length) this.#grow(this.flags.length * 2);
    return index;
  }

  /** Loads the rows of `indices` that are not loaded yet; throws for any not visible. */
  async load(indices: ArrayLike<number>): Promise<void> {
    const wanted: number[] = [];
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k] as number;
      if (this.#loaded[i] === 0) {
        this.#loaded[i] = 2; // requested; marked 1 once the row is in
        wanted.push(i);
      }
    }
    if (wanted.length === 0) return;
    this.#loadedCount += wanted.length;
    if (this.#loadedCount > this.#maxCommits) throw new WalkLimitError(this.#maxCommits);
    const rows = await this.#graph.read(
      wanted.map((i) => this.oids.oidAt(i)),
      this.#view,
    );
    const missing: Oid[] = [];
    wanted.forEach((i, k) => {
      const row = rows[k];
      if (!row) {
        missing.push(this.oids.oidAt(i));
        return;
      }
      const parents = row.parents.map((p) => this.intern(p));
      this.#trees?.set(i, row.tree);
      this.generation[i] = row.generation;
      this.date[i] = row.commitTime;
      this.#parentStart[i] = this.#parentsUsed;
      this.#parentCount[i] = parents.length;
      if (this.#parentsUsed + parents.length > this.#parents.length) {
        const grown = new Int32Array(
          Math.max(this.#parents.length * 2, this.#parentsUsed + parents.length),
        );
        grown.set(this.#parents);
        this.#parents = grown;
      }
      this.#parents.set(parents, this.#parentsUsed);
      this.#parentsUsed += parents.length;
      this.#loaded[i] = 1;
    });
    if (missing.length > 0) throw new MissingCommitError(missing);
  }

  /**
   * Loads the parents of loaded commit `i`, checking that each has a lower
   * generation: the walks' early stops are only correct if that holds.
   */
  async loadParents(i: number): Promise<void> {
    const parents = this.parentsOf(i);
    for (const p of parents) {
      if (this.#loaded[p] !== 1) {
        await this.load(Array.from(parents));
        break;
      }
    }
    for (const p of this.parentsOf(i)) {
      if (!((this.generation[p] as number) < (this.generation[i] as number))) {
        throw new Error(
          `commit graph is inconsistent: parent ${oidToHex(this.oids.oidAt(p))} of ` +
            `${oidToHex(this.oids.oidAt(i))} does not have a lower generation`,
        );
      }
    }
  }

  /** Parent indexes of loaded commit `i`; a view, valid until the next `load`. */
  parentsOf(i: number): Int32Array {
    const start = this.#parentStart[i] as number;
    return this.#parents.subarray(start, start + (this.#parentCount[i] as number));
  }

  #grow(capacity: number): void {
    const grow = <T extends Float64Array | Uint8Array | Int32Array>(old: T): T => {
      const next = new (old.constructor as new (n: number) => T)(capacity);
      next.set(old);
      return next;
    };
    this.generation = grow(this.generation);
    this.date = grow(this.date);
    this.flags = grow(this.flags);
    this.#loaded = grow(this.#loaded);
    this.#parentStart = grow(this.#parentStart);
    this.#parentCount = grow(this.#parentCount);
  }
}

/**
 * A max-heap of walk indexes ordered by generation, then commit date: the
 * order of git's `compare_commits_by_gen_then_commit_date`. With
 * `byOidOnTies`, commits equal in both come out by ascending oid, so the
 * order does not depend on how the heap was filled (a walk resumed from a
 * saved frontier pops them as the uninterrupted one did).
 */
export class CommitQueue {
  #heap = new Int32Array(64);
  #size = 0;
  readonly #walk: CommitWalk;
  readonly #byOidOnTies: boolean;

  constructor(walk: CommitWalk, options: { readonly byOidOnTies?: boolean } = {}) {
    this.#walk = walk;
    this.#byOidOnTies = options.byOidOnTies ?? false;
  }

  get size(): number {
    return this.#size;
  }

  push(i: number): void {
    if (this.#size === this.#heap.length) {
      const grown = new Int32Array(this.#heap.length * 2);
      grown.set(this.#heap);
      this.#heap = grown;
    }
    const heap = this.#heap;
    let k = this.#size++;
    while (k > 0) {
      const parent = (k - 1) >> 1;
      if (!this.#above(i, heap[parent] as number)) break;
      heap[k] = heap[parent] as number;
      k = parent;
    }
    heap[k] = i;
  }

  pop(): number {
    if (this.#size === 0) throw new RangeError("pop from an empty commit queue");
    const heap = this.#heap;
    const top = heap[0] as number;
    const last = heap[--this.#size] as number;
    let k = 0;
    for (;;) {
      let child = 2 * k + 1;
      if (child >= this.#size) break;
      if (child + 1 < this.#size && this.#above(heap[child + 1] as number, heap[child] as number)) {
        child++;
      }
      if (!this.#above(heap[child] as number, last)) break;
      heap[k] = heap[child] as number;
      k = child;
    }
    heap[k] = last;
    return top;
  }

  #above(a: number, b: number): boolean {
    const { generation, date } = this.#walk;
    const ga = generation[a] as number;
    const gb = generation[b] as number;
    if (ga !== gb) return ga > gb;
    const da = date[a] as number;
    const db = date[b] as number;
    if (da !== db || !this.#byOidOnTies) return da > db;
    const { oids } = this.#walk;
    return compareOids(oids.oidAt(a), oids.oidAt(b)) < 0;
  }
}
