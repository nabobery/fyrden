import { Sha1 } from "@fyrden/git-core";

/*
 * A webhook capture: what a delivery's body is made from, taken in the
 * change's own transaction. It is a JSON tree whose long text values are
 * replaced by references to blobs, each stored once by the hash of its JSON
 * encoding (so equal text is one blob, and the encoding keeps every string
 * exactly, lone surrogates included); the delivery resolves them back.
 */

/** A text value kept as a blob: its name, and the bytes of its JSON encoding. */
export interface BlobRef {
  readonly $blob: string;
  readonly bytes: number;
}

/** A blob: a text value's JSON encoding, named by its hash. */
export interface Blob {
  readonly hash: string;
  readonly json: string;
  readonly bytes: number;
}

/** Text values whose JSON encoding is this long or longer become blobs. Proposed. */
export const BLOB_MIN_BYTES = 1024;
/**
 * What a capture keeps inline at most (as JSON), past which shorter text
 * becomes blobs too; only a tree whose structure and short values alone
 * are longer stays over it (see `captureTree`). Proposed.
 */
export const INLINE_MAX_BYTES = 64 * 1024;
/**
 * The shorter threshold a capture over its inline bound uses: about the
 * size of a reference, so storing shorter text would not shrink the tree.
 * Proposed.
 */
export const BLOB_FALLBACK_MIN_BYTES = 64;

/** The key that marks a reference: no captured object may have it. */
const REF_KEY = "$blob";

const encoder = new TextEncoder();
const bytesOf = (text: string) => encoder.encode(text).length;

/** A text value's JSON encoding and its size, and its hash once it was needed. */
interface Encoded {
  readonly json: string;
  readonly bytes: number;
  hash?: string;
}

/**
 * Text values already encoded (and hashed, when long enough): one per
 * mutation, so a value appearing in several places or captures is encoded
 * and hashed once.
 */
export type CaptureCache = Map<string, Encoded>;

/**
 * The hex SHA-1 of `json` (UTF-8), with git's collision detection: a text
 * built to collide is refused (`Sha1CollisionError`), as git refuses it.
 */
function hashOf(json: string): string {
  const digest = new Sha1().update(encoder.encode(json)).digest();
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function encodedOf(text: string, cache: CaptureCache): Encoded {
  let encoded = cache.get(text);
  if (!encoded) {
    const json = JSON.stringify(text);
    encoded = { json, bytes: bytesOf(json) };
    cache.set(text, encoded);
  }
  return encoded;
}

/** Exactly a reference: its two own keys, nothing else (a captured object never has `$blob`). */
function isRef(value: unknown): value is BlobRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return (
    Object.keys(value).length === 2 &&
    Object.hasOwn(value, REF_KEY) &&
    Object.hasOwn(value, "bytes") &&
    typeof (value as BlobRef).$blob === "string" &&
    typeof (value as BlobRef).bytes === "number"
  );
}

/** A JSON value as a capture holds it: plain objects and arrays of strings, finite numbers, booleans and null. */
export type CaptureValue =
  | string
  | number
  | boolean
  | null
  | readonly CaptureValue[]
  | { readonly [key: string]: CaptureValue };

const isPlainObject = (value: object) => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * `tree` with text values encoding to `min` bytes or more replaced by
 * references, into `blobs`. Throws on anything else than a `CaptureValue`
 * (what serializing would change: `toJSON`, dates, undefined, non-finite
 * numbers), so the tree is exactly what is stored.
 */
function blobify(
  tree: CaptureValue,
  min: number,
  blobs: Map<string, Blob>,
  cache: CaptureCache,
): unknown {
  if (typeof tree === "string") {
    const encoded = encodedOf(tree, cache);
    if (encoded.bytes < min) return tree;
    encoded.hash ??= hashOf(encoded.json);
    const { hash, json, bytes } = encoded;
    if (!blobs.has(hash)) blobs.set(hash, { hash, json, bytes });
    return { $blob: hash, bytes } satisfies BlobRef;
  }
  if (tree === null || typeof tree === "boolean") return tree;
  if (typeof tree === "number") {
    if (!Number.isFinite(tree))
      throw new Error("a webhook capture may not hold a non-finite number");
    return tree;
  }
  if (Array.isArray(tree)) return tree.map((item) => blobify(item, min, blobs, cache));
  if (typeof tree === "object" && isPlainObject(tree)) {
    if (Object.hasOwn(tree, REF_KEY))
      throw new Error(`a webhook capture may not hold an object with a "${REF_KEY}" key`);
    return Object.fromEntries(
      Object.entries(tree).map(([key, value]) => [key, blobify(value, min, blobs, cache)]),
    );
  }
  throw new Error(`a webhook capture may hold only JSON values, not ${typeof tree}`);
}

/**
 * `tree` as a capture: its long text values as blob references (each blob
 * once), within `INLINE_MAX_BYTES` inline unless its structure, its
 * references (about 60 bytes each) and its values under
 * `BLOB_FALLBACK_MIN_BYTES` alone are longer (`inlineBytes` says; the
 * capture schemas bound every event's). `blobBytes` is what reading every
 * blob back reads. `cache` shares encodings and hashes across the
 * captures of one mutation. Throws when `tree` holds anything but JSON
 * values (see `blobify`) or an object with a `$blob` key, or a text was
 * built to collide under SHA-1.
 */
export function captureTree(
  tree: CaptureValue,
  cache: CaptureCache = new Map(),
): {
  readonly tree: unknown;
  readonly blobs: ReadonlyMap<string, Blob>;
  readonly blobBytes: number;
  readonly inlineBytes: number;
} {
  let blobs = new Map<string, Blob>();
  let inline = blobify(tree, BLOB_MIN_BYTES, blobs, cache);
  let inlineBytes = bytesOf(JSON.stringify(inline));
  if (inlineBytes > INLINE_MAX_BYTES) {
    blobs = new Map();
    inline = blobify(tree, BLOB_FALLBACK_MIN_BYTES, blobs, cache);
    inlineBytes = bytesOf(JSON.stringify(inline));
  }
  let blobBytes = 0;
  for (const blob of blobs.values()) blobBytes += blob.bytes;
  return { tree: inline, blobs, blobBytes, inlineBytes };
}

/** The distinct blob references in `tree`, in the order first met. */
export function refsOf(tree: unknown): BlobRef[] {
  const seen = new Map<string, BlobRef>();
  const walk = (value: unknown): void => {
    if (isRef(value)) {
      if (!seen.has(value.$blob)) seen.set(value.$blob, value);
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === "object" && value !== null) Object.values(value).forEach(walk);
  };
  walk(tree);
  return [...seen.values()];
}

/** The bytes `tree`'s references stand for, each place they appear: what resolving it adds. */
export function expandedBytesOf(tree: unknown): number {
  if (isRef(tree)) return tree.bytes;
  if (Array.isArray(tree))
    return tree.reduce((sum: number, item) => sum + expandedBytesOf(item), 0);
  if (typeof tree === "object" && tree !== null)
    return Object.values(tree).reduce((sum: number, item) => sum + expandedBytesOf(item), 0);
  return 0;
}

/**
 * `tree` with each reference replaced by its blob's text (`texts`: hash to
 * JSON encoding). Throws when a blob is missing or not the size its
 * reference recorded.
 */
export function resolveTree(tree: unknown, texts: ReadonlyMap<string, string>): unknown {
  if (isRef(tree)) {
    const json = texts.get(tree.$blob);
    if (json === undefined) throw new Error(`webhook blob ${tree.$blob} is missing`);
    if (bytesOf(json) !== tree.bytes)
      throw new Error(`webhook blob ${tree.$blob} is not the size its reference recorded`);
    return JSON.parse(json) as string;
  }
  if (Array.isArray(tree)) return tree.map((item) => resolveTree(item, texts));
  if (typeof tree === "object" && tree !== null)
    return Object.fromEntries(
      Object.entries(tree).map(([key, value]) => [key, resolveTree(value, texts)]),
    );
  return tree;
}
