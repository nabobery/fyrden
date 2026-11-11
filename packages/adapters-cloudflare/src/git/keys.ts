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

/**
 * The prefix of a repository's blame checkpoints. It names the repository
 * alone, not a network: a restored database can't know which networks the
 * repository has been in since its backup, so a key under one could be found
 * by nothing.
 */
export function blameCheckpointPrefix(repoId: string): string {
  if (!isId(repoId, "rep")) throw new RangeError("not a repository id");
  return `repo/${repoId}/blame/`;
}

/** One blame checkpoint: the run's folder, then its generation and a ULID of when it was written. */
export function blameCheckpointKey(at: {
  readonly repoId: string;
  readonly runId: string;
  readonly generation: number;
  readonly ulid: string;
}): string {
  const prefix = blameCheckpointPrefix(at.repoId);
  if (!isUlid(at.runId)) throw new RangeError("not a run id");
  if (!Number.isSafeInteger(at.generation) || at.generation < 0)
    throw new RangeError("not a generation");
  if (!isUlid(at.ulid)) throw new RangeError("not a ULID");
  return `${prefix}${at.runId}/${at.generation}-${at.ulid}`;
}

const CHECKPOINT =
  /^([0-7][0-9A-HJKMNP-TV-Z]{25})\/(0|[1-9]\d{0,15})-([0-7][0-9A-HJKMNP-TV-Z]{25})$/;

/** The run, generation and ULID of a checkpoint key under the repository's prefix, or undefined. */
export function parseBlameCheckpointKey(
  repoId: string,
  key: string,
): { runId: string; generation: number; ulid: string } | undefined {
  const prefix = blameCheckpointPrefix(repoId);
  if (!key.startsWith(prefix)) return undefined;
  const match = CHECKPOINT.exec(key.slice(prefix.length));
  if (!match) return undefined;
  const generation = Number(match[2]);
  if (!Number.isSafeInteger(generation)) return undefined;
  return { runId: match[1] as string, generation, ulid: match[3] as string };
}

/** A new pack id: a ULID, so ids sort by creation time. */
export function newPackId(now: number = Date.now()): PackId {
  return asPackId(ulid(now, secureRandomBytes));
}

/** A new id for an upload, lease or job: a ULID. */
export function newUlid(now: number = Date.now()): string {
  return ulid(now, secureRandomBytes);
}
