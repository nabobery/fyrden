import { isObjectType, OBJECT_TYPES, type ObjectType } from "../object/object.js";
import { OID_BYTES, type Oid, oidFromBytes } from "../object/oid.js";
import type { CommitInfo } from "../ports/commit-graph.js";
import { asPackId, type PackId } from "../ports/pack-store.js";

/*
 * The indexing job's state between phases: what the parse found that later
 * phases need, in a versioned binary form the Durable Object keeps in
 * `uploads.cursor` (or in R2 scratch when it is large). Size: about 60
 * bytes per new commit plus 20 per parent, 21 per link to an object
 * outside the pack, 21 per pending `.gitmodules`/`.gitattributes` blob and
 * 20 per thin base, plus a small header.
 */

export type IndexPhase = "parse" | "completion" | "connect" | "graph" | "done";
const PHASES: readonly IndexPhase[] = ["parse", "completion", "connect", "graph", "done"];

/** A ref the push wants to set, as the indexer checks it. */
export interface PushTip {
  /** The command's position in the request. */
  readonly index: number;
  readonly oid: Oid;
  /** The ref is under refs/heads/ (and so must point to a commit). */
  readonly branch: boolean;
}

export interface WrittenPack {
  readonly packId: PackId;
  readonly bytes: number;
  readonly objectCount: number;
}

/** Why the push is refused at indexing: every command reports "unpacker error". */
export interface UnpackFailure {
  /** The `unpack` status, git's "index-pack abnormal exit". */
  readonly status: string;
  /** Lines for the client's progress channel. */
  readonly messages: readonly string[];
}

export interface PendingBlob {
  readonly oid: Oid;
  readonly gitmodules: boolean;
  readonly gitattributes: boolean;
}

export interface IndexState {
  phase: IndexPhase;
  readonly uploadId: string;
  readonly packOffset: number;
  readonly tips: readonly PushTip[];
  readonly shallow: readonly Oid[];
  received: WrittenPack | null;
  completion: WrittenPack | null;
  thinBases: Oid[];
  commits: CommitInfo[];
  /** Links from new objects to objects outside the pack, with the type each needs. */
  externalLinks: (readonly [Oid, ObjectType])[];
  pendingBlobs: PendingBlob[];
  /** Types of tips found in the pack, by tip position. */
  tipTypes: (ObjectType | null)[];
  /** Existing packs the checks relied on. */
  deps: PackId[];
  /** Per-command refusals from the checks, by command index. */
  tipErrors: [number, string][];
  /** Non-fatal lines for the client (fsck warnings). */
  messages: string[];
  failure: UnpackFailure | null;
}

const MAGIC = [0x46, 0x52, 0x50, 0x49]; // "FRPI"
const VERSION = 1;

class Writer {
  #parts: Uint8Array[] = [];
  #length = 0;
  push(bytes: Uint8Array): void {
    this.#parts.push(bytes);
    this.#length += bytes.length;
  }
  u8(n: number): void {
    this.push(Uint8Array.of(n));
  }
  u32(n: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n);
    this.push(b);
  }
  f64(n: number): void {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, n);
    this.push(b);
  }
  bytes(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(this.#length);
    let at = 0;
    for (const p of this.#parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

class Reader {
  #at = 0;
  readonly bytes: Uint8Array;
  readonly #view: DataView;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  #need(n: number): number {
    if (this.#at + n > this.bytes.length) throw new RangeError("index cursor is truncated");
    const at = this.#at;
    this.#at += n;
    return at;
  }
  u8(): number {
    return this.#view.getUint8(this.#need(1));
  }
  u32(): number {
    return this.#view.getUint32(this.#need(4));
  }
  f64(): number {
    return this.#view.getFloat64(this.#need(8));
  }
  oid(): Oid {
    return oidFromBytes(this.bytes, this.#need(OID_BYTES));
  }
  take(n: number): Uint8Array {
    const at = this.#need(n);
    return this.bytes.subarray(at, at + n);
  }
  end(): void {
    if (this.#at !== this.bytes.length) throw new RangeError("index cursor has trailing bytes");
  }
}

const typeCode = (type: ObjectType) => OBJECT_TYPES.indexOf(type);
function typeOf(code: number): ObjectType {
  const type = OBJECT_TYPES[code];
  if (!type) throw new RangeError(`bad object type code ${code} in index cursor`);
  return type;
}

interface Header {
  phase: IndexPhase;
  uploadId: string;
  packOffset: number;
  tips: { index: number; branch: boolean }[];
  received: { packId: string; bytes: number; objectCount: number } | null;
  completion: { packId: string; bytes: number; objectCount: number } | null;
  tipTypes: (ObjectType | null)[];
  deps: string[];
  tipErrors: [number, string][];
  messages: string[];
  failure: UnpackFailure | null;
}

/** Encodes the state as cursor bytes. */
export function encodeCursor(state: IndexState): Uint8Array<ArrayBuffer> {
  const w = new Writer();
  w.push(Uint8Array.from(MAGIC));
  w.u8(VERSION);
  const header: Header = {
    phase: state.phase,
    uploadId: state.uploadId,
    packOffset: state.packOffset,
    tips: state.tips.map((t) => ({ index: t.index, branch: t.branch })),
    received: state.received,
    completion: state.completion,
    tipTypes: state.tipTypes,
    deps: state.deps,
    tipErrors: state.tipErrors,
    messages: state.messages,
    failure: state.failure,
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  w.u32(json.length);
  w.push(json);
  for (const tip of state.tips) w.push(tip.oid);
  w.u32(state.shallow.length);
  for (const oid of state.shallow) w.push(oid);
  w.u32(state.thinBases.length);
  for (const oid of state.thinBases) w.push(oid);
  w.u32(state.externalLinks.length);
  for (const [oid, type] of state.externalLinks) {
    w.push(oid);
    w.u8(typeCode(type));
  }
  w.u32(state.pendingBlobs.length);
  for (const blob of state.pendingBlobs) {
    w.push(blob.oid);
    w.u8((blob.gitmodules ? 1 : 0) | (blob.gitattributes ? 2 : 0));
  }
  w.u32(state.commits.length);
  for (const commit of state.commits) {
    w.push(commit.oid);
    w.push(commit.tree);
    w.f64(commit.commitTime);
    w.u32(commit.parents.length);
    for (const parent of commit.parents) w.push(parent);
  }
  return w.bytes();
}

/** Decodes cursor bytes. Throws RangeError for anything this version did not write. */
export function decodeCursor(bytes: Uint8Array): IndexState {
  try {
    return decode(bytes);
  } catch (error) {
    if (error instanceof RangeError) throw error;
    // A damaged header (bad JSON, wrong shapes).
    throw new RangeError(`index cursor is damaged: ${(error as Error).message}`);
  }
}

function decode(bytes: Uint8Array): IndexState {
  const r = new Reader(bytes);
  for (const byte of MAGIC) if (r.u8() !== byte) throw new RangeError("not an index cursor");
  const version = r.u8();
  if (version !== VERSION) throw new RangeError(`index cursor version ${version} is not supported`);
  const header = JSON.parse(new TextDecoder().decode(r.take(r.u32()))) as Header;
  if (!PHASES.includes(header.phase)) throw new RangeError(`bad phase ${header.phase}`);
  for (const t of header.tipTypes)
    if (t !== null && !isObjectType(t)) throw new RangeError("bad tip type");
  const tips = header.tips.map((t) => ({ index: t.index, branch: t.branch, oid: r.oid() }));
  const list = <T>(read: () => T): T[] => Array.from({ length: r.u32() }, read);
  const shallow = list(() => r.oid());
  const thinBases = list(() => r.oid());
  const externalLinks = list((): readonly [Oid, ObjectType] => [r.oid(), typeOf(r.u8())]);
  const pendingBlobs = list((): PendingBlob => {
    const oid = r.oid();
    const flags = r.u8();
    return { oid, gitmodules: (flags & 1) !== 0, gitattributes: (flags & 2) !== 0 };
  });
  const commits = list((): CommitInfo => {
    const oid = r.oid();
    const tree = r.oid();
    const commitTime = r.f64();
    const parents = list(() => r.oid());
    return { oid, tree, parents, commitTime };
  });
  r.end();
  const pack = (p: Header["received"]): WrittenPack | null =>
    p && { packId: asPackId(p.packId), bytes: p.bytes, objectCount: p.objectCount };
  return {
    phase: header.phase,
    uploadId: header.uploadId,
    packOffset: header.packOffset,
    tips,
    shallow,
    received: pack(header.received),
    completion: pack(header.completion),
    thinBases,
    commits,
    externalLinks,
    pendingBlobs,
    tipTypes: header.tipTypes,
    deps: header.deps.map(asPackId),
    tipErrors: header.tipErrors,
    messages: header.messages,
    failure: header.failure,
  };
}
