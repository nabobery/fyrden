import { parseCommit } from "../object/commit.js";
import { OBJECT_TYPES, type ObjectType } from "../object/object.js";
import { OID_BYTES, type Oid, oidFromBytes, oidToHex } from "../object/oid.js";
import { parseTag } from "../object/tag.js";
import { FILE_MODES, isTreeMode, parseTree } from "../object/tree.js";
import type { CommitGraph } from "../ports/commit-graph.js";
import { isPackId, type PackId } from "../ports/pack-store.js";
import { MissingObjectError } from "../reader/errors.js";
import type { ObjectReader, StoredObject } from "../reader/object-reader.js";
import { BitSet } from "./bitset.js";
import { OidTable } from "./oid-table.js";

/*
 * Reachability marking for maintenance: from the roots (ref
 * tips, then reflog entries), every reachable object is marked in one bit
 * set per pack, by its position in the pack's `.idx` (the approach of
 * reachability bitmaps; one bit per object, so 125 KB per million objects).
 * An object stored in several packs is marked in each.
 *
 * The walk is depth first over an explicit stack, so it can stop after any
 * number of objects and continue later from `checkpoint()`: maintenance
 * runs it in alarm slices. Blobs are marked from the tree entry that names
 * them and never read. Commits come from the commit graph when it has them
 * (no pack read); trees, tags and commits it lacks are read through the
 * reader. Gitlinks are skipped: their commits live in another repository.
 *
 * What happens at an object in none of the marked packs is the caller's
 * choice (`outside`):
 * - "error" (the default, for garbage collection): the mark cannot be
 *   complete, so it throws `MissingObjectError` instead of letting a
 *   collector treat a reachable object as garbage;
 * - "stop": the walk does not go through it. The marks are then a lower
 *   bound: everything marked is reachable (for flagging packs whose every
 *   object is reachable, cheaply, from the newest packs alone);
 * - "descend": the walk reads it through the reader and goes on, so objects
 *   in the marked packs reached only through other packs are found too.
 */

/** What an object on the stack is known to be ("any" for a root). */
type Kind = ObjectType | "any";
const KIND_CODES: readonly Kind[] = ["any", ...OBJECT_TYPES];
const ENTRY_BYTES = OID_BYTES + 1;

export type MarkOutside = "error" | "stop" | "descend";

/** A pack whose objects are marked: its id and its `.idx`. */
export interface MarkSource {
  readonly packId: PackId;
  readonly idx: { readonly count: number; find(oid: Uint8Array, at?: number): number };
}

export interface ObjectMarkOptions {
  /** The packs to mark, in lookup order. */
  readonly sources: readonly MarkSource[];
  /** Reads trees, tags, root objects and commits the graph lacks. Its view must hold every object walked. */
  readonly reader: Pick<ObjectReader, "readObject">;
  /** The repository's verified commit graph: parents and trees without reading packs. */
  readonly commits?: Pick<CommitGraph, "read">;
  /** What to do at an object in none of `sources`. Default "error". */
  readonly outside?: MarkOutside;
}

const MAGIC = [0x46, 0x4f, 0x4d, 0x4b]; // "FOMK"
const VERSION = 1;
const OUTSIDE_CODES: readonly MarkOutside[] = ["error", "stop", "descend"];

export class ObjectMark {
  /** One bit set per source, by `.idx` position. */
  readonly bits: readonly BitSet[];
  readonly #options: ObjectMarkOptions;
  readonly #outside: MarkOutside;
  /** Objects outside the sources already walked ("descend" only). */
  readonly #walkedOutside: OidTable;
  #stack: Uint8Array;
  #depth = 0;
  /** Distinct objects marked so far. */
  marked: number;

  private constructor(
    options: ObjectMarkOptions,
    state: {
      bits: BitSet[];
      walkedOutside: OidTable;
      stack: Uint8Array;
      depth: number;
      marked: number;
    },
  ) {
    this.#options = options;
    this.#outside = options.outside ?? "error";
    this.bits = state.bits;
    this.#walkedOutside = state.walkedOutside;
    this.#stack = state.stack;
    this.#depth = state.depth;
    this.marked = state.marked;
  }

  /** A mark with nothing marked and no roots yet. */
  static start(options: ObjectMarkOptions): ObjectMark {
    checkSources(options.sources);
    return new ObjectMark(options, {
      bits: options.sources.map((s) => new BitSet(s.idx.count)),
      walkedOutside: new OidTable(),
      stack: new Uint8Array(64 * ENTRY_BYTES),
      depth: 0,
      marked: 0,
    });
  }

  /** Continues a mark from `checkpoint()` over the same sources. Throws RangeError for a checkpoint that does not fit. */
  static resume(options: ObjectMarkOptions, checkpoint: Uint8Array): ObjectMark {
    checkSources(options.sources);
    const bad = (why: string) => new RangeError(`bad mark checkpoint: ${why}`);
    const view = new DataView(checkpoint.buffer, checkpoint.byteOffset, checkpoint.byteLength);
    let at = 0;
    const need = (n: number) => {
      if (at + n > checkpoint.length) throw bad("truncated");
    };
    need(12);
    if (MAGIC.some((b, i) => checkpoint[i] !== b)) throw bad("not a mark checkpoint");
    if (checkpoint[4] !== VERSION) throw bad(`version ${checkpoint[4]}`);
    // The rule for objects outside the sources may change between runs (a
    // final walk that goes through newer packs continues a strict mark).
    if (OUTSIDE_CODES[checkpoint[5] as number] === undefined) throw bad("bad outside rule");
    const count = view.getUint16(6);
    const marked = view.getUint32(8);
    at = 12;
    if (count !== options.sources.length) throw bad("taken over other sources");
    const bits: BitSet[] = [];
    for (const source of options.sources) {
      need(30);
      const id = String.fromCharCode(...checkpoint.subarray(at, at + 26));
      const size = view.getUint32(at + 26);
      at += 30;
      if (id !== source.packId || size !== source.idx.count) throw bad("taken over other sources");
      const length = 4 * Math.ceil(size / 32);
      need(length);
      bits.push(BitSet.fromBytes(size, checkpoint.subarray(at, at + length)));
      at += length;
    }
    need(4);
    const outsideCount = view.getUint32(at);
    at += 4;
    need(outsideCount * OID_BYTES);
    const walkedOutside = new OidTable(outsideCount);
    for (let i = 0; i < outsideCount; i++, at += OID_BYTES) {
      walkedOutside.add(oidFromBytes(checkpoint, at));
    }
    need(4);
    const depth = view.getUint32(at);
    at += 4;
    need(depth * ENTRY_BYTES);
    const stack = new Uint8Array(Math.max(64, depth) * ENTRY_BYTES);
    stack.set(checkpoint.subarray(at, at + depth * ENTRY_BYTES));
    at += depth * ENTRY_BYTES;
    for (let i = 0; i < depth; i++) {
      if ((stack[i * ENTRY_BYTES + OID_BYTES] as number) >= KIND_CODES.length)
        throw bad("bad kind");
    }
    if (at !== checkpoint.length) throw bad("trailing bytes");
    return new ObjectMark(options, { bits, walkedOutside, stack, depth, marked });
  }

  /** Objects waiting to be walked. */
  get pending(): number {
    return this.#depth;
  }

  /** Adds objects to walk from (roots of any type, unless `kind` says). */
  push(oids: readonly Uint8Array[], kind: Kind = "any"): void {
    for (let i = oids.length - 1; i >= 0; i--) this.#push(oids[i] as Uint8Array, kind);
  }

  /** Walks up to `maxObjects` more objects. Returns true when nothing is left to walk. */
  async run(maxObjects = Number.POSITIVE_INFINITY): Promise<boolean> {
    for (let n = 0; n < maxObjects && this.#depth > 0; n++) {
      this.#depth--;
      const at = this.#depth * ENTRY_BYTES;
      const oid = oidFromBytes(this.#stack, at);
      const kind = KIND_CODES[this.#stack[at + OID_BYTES] as number] as Kind;
      await this.#visit(oid, kind);
    }
    return this.#depth === 0;
  }

  /** The mark's state, for `resume`. */
  checkpoint(): Uint8Array {
    const sources = this.#options.sources;
    const bitBytes = this.bits.map((b) => b.toBytes());
    const length =
      12 +
      sources.length * 30 +
      bitBytes.reduce((n, b) => n + b.length, 0) +
      4 +
      this.#walkedOutside.size * OID_BYTES +
      4 +
      this.#depth * ENTRY_BYTES;
    const out = new Uint8Array(length);
    const view = new DataView(out.buffer);
    out.set(MAGIC);
    out[4] = VERSION;
    out[5] = OUTSIDE_CODES.indexOf(this.#outside);
    view.setUint16(6, sources.length);
    view.setUint32(8, this.marked);
    let at = 12;
    sources.forEach((source, i) => {
      for (let c = 0; c < 26; c++) out[at + c] = source.packId.charCodeAt(c);
      view.setUint32(at + 26, source.idx.count);
      at += 30;
      out.set(bitBytes[i] as Uint8Array, at);
      at += (bitBytes[i] as Uint8Array).length;
    });
    view.setUint32(at, this.#walkedOutside.size);
    at += 4;
    out.set(this.#walkedOutside.packedOids(), at);
    at += this.#walkedOutside.size * OID_BYTES;
    view.setUint32(at, this.#depth);
    at += 4;
    out.set(this.#stack.subarray(0, this.#depth * ENTRY_BYTES), at);
    return out;
  }

  #push(oid: Uint8Array, kind: Kind): void {
    if (oid.length < OID_BYTES) throw new RangeError("an object id is 20 bytes");
    if ((this.#depth + 1) * ENTRY_BYTES > this.#stack.length) {
      const grown = new Uint8Array(this.#stack.length * 2);
      grown.set(this.#stack);
      this.#stack = grown;
    }
    const at = this.#depth * ENTRY_BYTES;
    this.#stack.set(oid.subarray(0, OID_BYTES), at);
    this.#stack[at + OID_BYTES] = KIND_CODES.indexOf(kind);
    this.#depth++;
  }

  async #visit(oid: Oid, kind: Kind): Promise<void> {
    const sources = this.#options.sources;
    let found = false;
    for (let s = 0; s < sources.length; s++) {
      const p = (sources[s] as MarkSource).idx.find(oid);
      if (p < 0) continue;
      const bits = this.bits[s] as BitSet;
      // Marked in every pack holding it at once, so one set bit means visited.
      if (bits.has(p)) return;
      bits.set(p);
      found = true;
    }
    if (found) this.marked++;
    else {
      if (this.#outside === "error") throw new MissingObjectError([oid]);
      if (this.#outside === "stop") return;
      if (this.#walkedOutside.has(oid)) return;
      this.#walkedOutside.add(oid);
    }
    await this.#expand(oid, kind);
  }

  async #expand(oid: Oid, kind: Kind): Promise<void> {
    if (kind === "blob") return;
    if (kind === "commit" && this.#options.commits) {
      const [row] = await this.#options.commits.read([oid], "verified");
      if (row) {
        this.push(row.parents, "commit");
        this.#push(row.tree, "tree");
        return;
      }
    }
    const object = await this.#options.reader.readObject(oid);
    if (!object) throw new MissingObjectError([oid]);
    if (kind !== "any" && object.type !== kind) {
      throw new Error(`object ${oidToHex(oid)} is a ${object.type}, not a ${kind}`);
    }
    this.#children(object);
  }

  #children(object: StoredObject): void {
    switch (object.type) {
      case "blob":
        return;
      case "commit": {
        const commit = parseCommit(object.bytes).value;
        this.push(commit.parents, "commit");
        this.#push(commit.tree, "tree");
        return;
      }
      case "tag": {
        const tag = parseTag(object.bytes).value;
        this.#push(tag.object, tag.type);
        return;
      }
      case "tree": {
        const entries = parseTree(object.bytes).value;
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i] as (typeof entries)[number];
          if (entry.mode === FILE_MODES.gitlink) continue;
          this.#push(entry.oid, isTreeMode(entry.mode) ? "tree" : "blob");
        }
        return;
      }
    }
  }
}

function checkSources(sources: readonly MarkSource[]): void {
  if (sources.length > 0xffff) throw new RangeError(`${sources.length} sources are too many`);
  const seen = new Set<string>();
  for (const source of sources) {
    if (!isPackId(source.packId)) throw new RangeError("not a pack id");
    if (seen.has(source.packId)) throw new RangeError(`pack ${source.packId} is a source twice`);
    seen.add(source.packId);
  }
}
