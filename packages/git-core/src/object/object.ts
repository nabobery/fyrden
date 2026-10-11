import type { HasherFactory } from "../ports/hasher.js";
import { latin1Bytes } from "./bytes.js";
import { type Oid, oidFromBytes } from "./oid.js";

export const OBJECT_TYPES = ["commit", "tree", "blob", "tag"] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

export function isObjectType(text: string): text is ObjectType {
  return (OBJECT_TYPES as readonly string[]).includes(text);
}

/** The header git hashes before an object's body: `<type> <size>\0`. */
export function encodeObjectHeader(type: ObjectType, size: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError(`bad object size: ${size}`);
  return latin1Bytes(`${type} ${size}\0`);
}

/** The object id: SHA-1 over the header and the body. */
export async function hashObject(
  createHasher: HasherFactory,
  type: ObjectType,
  body: Uint8Array,
): Promise<Oid> {
  const hasher = createHasher();
  await hasher.update(encodeObjectHeader(type, body.length));
  await hasher.update(body);
  return oidFromBytes(await hasher.digest());
}
