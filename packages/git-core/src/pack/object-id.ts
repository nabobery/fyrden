import { Sha1 } from "../hash/sha1.js";
import { encodeObjectHeader, type ObjectType } from "../object/object.js";

/**
 * The id of an object received in a pack: SHA-1 with collision detection,
 * which throws `Sha1CollisionError` for an attack input, as git does.
 * Synchronous, so a pack of many small objects pays no promise per object.
 */
export function receivedObjectId(type: ObjectType, data: Uint8Array): Uint8Array {
  return new Sha1().update(encodeObjectHeader(type, data.length)).update(data).digest();
}
