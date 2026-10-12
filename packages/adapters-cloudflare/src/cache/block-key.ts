import { isPackId } from "@fyrden/git-core";

/**
 * Scopes are network ids. Only URL-safe characters are accepted, so a scope
 * can sit in a cache key without escaping and never changes its shape.
 */
const SCOPE = /^[A-Za-z0-9_-]{1,128}$/;

/** Throws RangeError for a scope, pack id or block index that may not form a key. */
export function checkBlockAddress(scope: string, packId: string, blockIndex: number): void {
  if (!SCOPE.test(scope)) throw new RangeError("not a block cache scope");
  if (!isPackId(packId)) throw new RangeError("not a pack id");
  if (!Number.isSafeInteger(blockIndex) || blockIndex < 0) {
    throw new RangeError(`bad block index ${blockIndex}`);
  }
}
