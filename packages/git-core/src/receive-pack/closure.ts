import { OidTable } from "../graph/oid-table.js";
import { isObjectType, OBJECT_TYPES, type ObjectType } from "../object/object.js";
import { OID_BYTES, type Oid, oidFromBytes, oidFromHex } from "../object/oid.js";
import type { CommitGraph, CommitGraphEntry } from "../ports/commit-graph.js";
import type { MemoryBudget, MemoryReservation } from "../ports/memory-budget.js";
import type { ObjectReader } from "../reader/object-reader.js";

/** What a proof reads: commit rows, and trees and tags through a reader of this repository's view. */
export interface ClosureSource {
  readonly graph: CommitGraph;
  readonly reader: Pick<ObjectReader, "readObject" | "readHeader">;
  /** The repository's current ref tips. */
  refTips(): Promise<readonly Oid[]>;
  readonly memory: MemoryBudget;
  /** Most trees and tags one proof may read; beyond it, what is not found counts as absent. */
  readonly maxReads: number;
}

const GRAPH_BATCH = 1000;
/** Ancestor commits whose rows are read in one step, newest found first. */
const ANCESTOR_BATCH = 32;
/**
 * Ancestor rows one proof may read, per tree or tag read it may make
 * (Proposed). Rows come from the commit graph, not packs; the bound stops a
 * long history of commits that share trees from walking without end.
 */
const ANCESTOR_ROWS_PER_READ = 16;
/** Deepest tag chain a ref is peeled through (git's `deref_tag` has no limit; refs never need this many). */
const MAX_TAG_CHAIN = 16;
const MODE_TYPE_MASK = 0o170000;

/**
 * Proves that existing objects belong to this repository's closure, for a
 * push that wants to use them (as delta bases, link targets or ref tips)
 * when they are found only in packs shared with a fork network, which may
 * hold another member's objects:
 *
 * - a commit belongs when it has a verified row in this repository's
 *   commit graph;
 * - a tree, blob or tag belongs when it is reachable from the trees of
 *   the seed commits (verified commits the push builds on: parents of its
 *   new commits, existing commits it points refs at), then from the
 *   current refs (their commits' trees, and tag chains), and then from the
 *   trees of their ancestors, walked breadth first through verified rows.
 *
 * The search reads trees depth first. A tree that is itself asked for is
 * proven by being found and is read last, since a push's links usually
 * name subtrees it kept unchanged; the trees read are those along the
 * paths the push changed. The type comes from where the object was found
 * (the tree entry's mode, the tag's type line), which the push that
 * stored it checked. Reads are bounded by `maxReads`; anything not found
 * by then counts as absent (fail closed), and so is the ancestor walk
 * (`ANCESTOR_ROWS_PER_READ` rows per read). Gitlinks prove nothing.
 *
 * One instance keeps what it has seen, so later calls continue the search.
 * Call `release()` at the end.
 */
export class RepoClosure {
  readonly #source: ClosureSource;
  readonly #seen = new OidTable(1024);
  #types = new Uint8Array(1024);
  readonly #reservations: MemoryReservation[] = [];
  #reserved = 0;
  /** Trees to read: those found while searching, then those that were asked for. */
  readonly #stack: Oid[] = [];
  readonly #later: Oid[] = [];
  #seeds: Oid[] = [];
  #refsDone = false;
  #reads = 0;
  /**
   * Commits met by the walk. Kept apart from `#seen`: a parent is queued
   * before its row is read, and only a verified row proves a commit.
   */
  readonly #commits = new OidTable(256);
  /** Commits whose rows are still to be read for their trees and parents, oldest-found first. */
  #ancestors: Oid[] = [];
  #ancestorAt = 0;
  #ancestorRows = 0;
  #wanted = new OidTable(1);
  #remaining = 0;

  /** Bytes charged per object seen: oid table slot and oid, plus its type. Estimated. */
  static readonly BYTES_PER_OBJECT = 32;
  static readonly RESERVE_STEP = 1024 * 1024;

  constructor(source: ClosureSource) {
    this.#source = source;
  }

  /** Trees and tags read so far. */
  get reads(): number {
    return this.#reads;
  }

  /** Commits whose trees are searched before the refs'; only those with verified rows count. */
  addSeeds(commits: readonly Oid[]): void {
    for (const oid of commits) this.#seeds.push(oid);
  }

  /** The type of each object when it belongs to the closure, else undefined. */
  async resolve(oids: readonly Oid[]): Promise<(ObjectType | undefined)[]> {
    const rows = await readRows(this.#source.graph, oids);
    const result = oids.map((oid, i) => (rows[i] ? "commit" : this.#typeOf(oid)));
    const pending = result.flatMap((type, i) => (type === undefined ? [i] : []));
    if (pending.length === 0) return result;
    this.#wanted = new OidTable(pending.length);
    for (const i of pending) this.#wanted.add(oids[i] as Oid);
    this.#remaining = this.#wanted.size;
    await this.#search();
    for (const i of pending) result[i] = this.#typeOf(oids[i] as Oid);
    return result;
  }

  release(): void {
    for (const reservation of this.#reservations.splice(0)) reservation.release();
    this.#reserved = 0;
  }

  #typeOf(oid: Oid): ObjectType | undefined {
    const at = this.#seen.indexOf(oid);
    return at < 0 ? undefined : OBJECT_TYPES[this.#types[at] as number];
  }

  async #search(): Promise<void> {
    while (this.#remaining > 0) {
      if (this.#stack.length === 0 && this.#later.length === 0) {
        if (this.#seeds.length > 0) {
          const seeds = this.#seeds;
          this.#seeds = [];
          for (const row of await readRows(this.#source.graph, seeds)) {
            if (row) await this.#foundCommit(row);
          }
        } else if (!this.#refsDone) {
          this.#refsDone = true;
          await this.#expandRefs();
        } else if (!(await this.#expandAncestors())) {
          return;
        }
        continue;
      }
      if (this.#reads >= this.#source.maxReads) return;
      const tree = (this.#stack.pop() ?? this.#later.pop()) as Oid;
      this.#reads++;
      const object = await this.#source.reader.readObject(tree);
      if (object?.type === "tree") await this.#scanTree(object.bytes);
    }
  }

  /** Ref tips: commits by their rows, other objects by reading them (tags peeled). */
  async #expandRefs(): Promise<void> {
    const tips = await this.#source.refTips();
    const rows = await readRows(this.#source.graph, tips);
    for (const row of rows) if (row) await this.#foundCommit(row);
    for (const [i, tip] of tips.entries()) {
      if (rows[i] || this.#seen.has(tip)) continue;
      if (this.#reads >= this.#source.maxReads) return;
      this.#reads++;
      const header = await this.#source.reader.readHeader(tip);
      if (!header) continue;
      if (header.type === "tag") await this.#peel(tip);
      else if (header.type !== "commit") await this.#found(tip, header.type);
    }
  }

  /** A tag chain from a ref: each tag, and what it ends at. */
  async #peel(tag: Oid): Promise<void> {
    let current = tag;
    for (let depth = 0; depth < MAX_TAG_CHAIN; depth++) {
      await this.#found(current, "tag");
      if (this.#reads >= this.#source.maxReads) return;
      this.#reads++;
      const object = await this.#source.reader.readObject(current);
      const target = object?.type === "tag" ? tagTarget(object.bytes) : undefined;
      if (!target) return;
      if (target.type === "commit") {
        const [row] = await this.#source.graph.read([target.oid], "verified");
        if (row) await this.#foundCommit(row);
        return;
      }
      if (target.type !== "tag") {
        await this.#found(target.oid, target.type);
        return;
      }
      if (this.#seen.has(target.oid)) return;
      current = target.oid;
    }
  }

  /**
   * The next ancestors' trees, newest first; false when there is nothing
   * left to walk or the walk's bounds are spent.
   */
  async #expandAncestors(): Promise<boolean> {
    const maxRows = this.#source.maxReads * ANCESTOR_ROWS_PER_READ;
    if (this.#reads >= this.#source.maxReads || this.#ancestorRows >= maxRows) return false;
    const take = Math.min(ANCESTOR_BATCH, maxRows - this.#ancestorRows);
    const batch = this.#ancestors.slice(this.#ancestorAt, this.#ancestorAt + take);
    if (batch.length === 0) return false;
    this.#ancestorAt += batch.length;
    if (this.#ancestorAt === this.#ancestors.length) {
      this.#ancestors = [];
      this.#ancestorAt = 0;
    }
    this.#ancestorRows += batch.length;
    const rows = await this.#source.graph.read(batch, "verified");
    // The stack reads the last tree found first: find the newest last.
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (row) await this.#foundCommit(row);
    }
    return true;
  }

  /** A verified commit: its tree is searched, and its parents queued for the ancestor walk. */
  async #foundCommit(row: CommitGraphEntry): Promise<void> {
    this.#commits.add(row.oid);
    await this.#found(row.tree, "tree");
    for (const parent of row.parents) {
      const before = this.#commits.size;
      if (this.#commits.add(parent) < before) continue;
      await this.#charge();
      this.#ancestors.push(parent);
    }
  }

  /** Every entry of a tree body, without copying names (the tree passed fsck when it was pushed). */
  async #scanTree(body: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < body.length) {
      const space = body.indexOf(0x20, offset);
      if (space < 0) return;
      let mode = 0;
      for (let i = offset; i < space; i++)
        mode = (mode * 8 + ((body[i] as number) - 0x30)) & 0xffff;
      const nul = body.indexOf(0, space + 1);
      if (nul < 0 || nul + 1 + OID_BYTES > body.length) return;
      offset = nul + 1 + OID_BYTES;
      const kind = mode & MODE_TYPE_MASK;
      const type =
        kind === 0o040000 ? "tree" : kind === 0o100000 || kind === 0o120000 ? "blob" : undefined;
      // Every entry is recorded, for later questions too.
      if (type) await this.#found(oidFromBytes(body, nul + 1), type);
    }
  }

  async #found(oid: Oid, type: ObjectType): Promise<void> {
    const before = this.#seen.size;
    const at = this.#seen.add(oid);
    if (at < before) return;
    if (at >= this.#types.length) {
      const grown = new Uint8Array(this.#types.length * 2);
      grown.set(this.#types);
      this.#types = grown;
    }
    this.#types[at] = OBJECT_TYPES.indexOf(type);
    await this.#charge();
    const wanted = this.#wanted.has(oid);
    if (wanted) this.#remaining--;
    if (type === "tree") (wanted ? this.#later : this.#stack).push(oid);
  }

  /** Reserves memory for every object and commit met so far. */
  async #charge(): Promise<void> {
    const needed = (this.#seen.size + this.#commits.size) * RepoClosure.BYTES_PER_OBJECT;
    while (this.#reserved < needed) {
      this.#reservations.push(await this.#source.memory.reserve(RepoClosure.RESERVE_STEP));
      this.#reserved += RepoClosure.RESERVE_STEP;
    }
  }
}

async function readRows(
  graph: CommitGraph,
  oids: readonly Oid[],
): Promise<(CommitGraphEntry | undefined)[]> {
  const rows: (CommitGraphEntry | undefined)[] = [];
  for (let i = 0; i < oids.length; i += GRAPH_BATCH) {
    for (const row of await graph.read(oids.slice(i, i + GRAPH_BATCH), "verified")) rows.push(row);
  }
  return rows;
}

const LATIN1 = new TextDecoder("latin1");

/** A tag's `object` and `type` lines (the first two header lines git writes and checks). */
function tagTarget(body: Uint8Array): { oid: Oid; type: ObjectType } | undefined {
  const head = LATIN1.decode(body.subarray(0, Math.min(body.length, 128)));
  const match = /^object ([0-9a-f]{40})\ntype ([a-z]+)\n/.exec(head);
  if (!match || !isObjectType(match[2] as string)) return undefined;
  return { oid: oidFromHex(match[1] as string), type: match[2] as ObjectType };
}
