import { isId, secureRandomBytes, ulid } from "@fyrden/domain";
import { asPackId, isPackId, type PackId } from "@fyrden/git-core";

/**
 * R2 keys in the git bucket. Keys are built only from immutable ids, and
 * every id is checked against its format first, so a hostile or corrupted
 * value can never reach outside its network's prefix.
 *
 *   net/<network_id>/p/<pack_id>.pack
 *   net/<network_id>/p/<pack_id>.idx
 *   net/<network_id>/scratch/<upload_id>/<n>
 *   net/<network_id>/fetch/<cache_key>/<pack_id>.pack
 */

export function isNetworkId(text: string): boolean {
  return isId(text, "net");
}

export function assertNetworkId(text: string): string {
  if (!isNetworkId(text)) throw new RangeError("not a network id");
  return text;
}

export type PackFile = "pack" | "idx";

export function packObjectKey(networkId: string, packId: string, file: PackFile): string {
  assertNetworkId(networkId);
  if (!isPackId(packId)) throw new RangeError("not a pack id");
  if (file !== "pack" && file !== "idx") throw new RangeError("not a pack file kind");
  return `net/${networkId}/p/${packId}.${file}`;
}

/** The prefix every pack and index object of a network is stored under. */
export function packPrefix(networkId: string): string {
  assertNetworkId(networkId);
  return `net/${networkId}/p/`;
}

const FETCH_CACHE_KEY = /^[0-9a-f]{40}$/;

/** A materialised fetch object's cache key: 40 lowercase hex digits (a SHA-1 of its description). */
export function isFetchCacheKey(text: string): boolean {
  return FETCH_CACHE_KEY.test(text);
}

/** Every materialised object written for `cacheKey` is stored under this prefix. */
export function fetchObjectPrefix(networkId: string, cacheKey: string): string {
  assertNetworkId(networkId);
  if (!isFetchCacheKey(cacheKey)) throw new RangeError("not a fetch cache key");
  return `net/${networkId}/fetch/${cacheKey}/`;
}

/**
 * A materialised fetch object (a regenerated pack or a side-band framed
 * copy). Each write gets its own pack id, so a lease always names the
 * exact bytes it protects, even when two requests materialise one key.
 */
export function fetchObjectKey(networkId: string, cacheKey: string, packId: string): string {
  const prefix = fetchObjectPrefix(networkId, cacheKey);
  if (!isPackId(packId)) throw new RangeError("not a pack id");
  return `${prefix}${packId}.pack`;
}

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** An upload, lease or job id as `newUlid` makes it. */
export function isUlid(text: string): boolean {
  return ULID.test(text);
}

/** The prefix of an upload's indexing checkpoints. */
export function scratchPrefix(networkId: string, uploadId: string): string {
  assertNetworkId(networkId);
  if (!isUlid(uploadId)) throw new RangeError("not an upload id");
  return `net/${networkId}/scratch/${uploadId}/`;
}

/** A new pack id: a ULID, so ids sort by creation time. */
export function newPackId(now: number = Date.now()): PackId {
  return asPackId(ulid(now, secureRandomBytes));
}

/** A new id for an upload, lease or job: a ULID. */
export function newUlid(now: number = Date.now()): string {
  return ulid(now, secureRandomBytes);
}
