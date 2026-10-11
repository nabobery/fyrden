import { isId } from "@fyrden/domain";

/*
 * Cache keys of responses about one repository's objects (blobs, trees,
 * rendered views, diffs, archives). Every key starts with the repository's
 * id, never only a SHA: two repositories that hold the same object (forks
 * in one network, or unrelated repositories) never share an entry, so a
 * response cached for one can never answer a request made through the
 * other. Only the internal pack-block tier is keyed by network
 * (`blockCacheUrl`). Keys sit under a reserved `.invalid` host (RFC 2606)
 * that no route serves.
 */

const KEY_ORIGIN = "https://responses.fyrden.invalid";
const OID = /^[0-9a-f]{40}$/;
/** A rendering of the object: `raw`, `json`, `html-v1`, `tar.gz`. */
const VARIANT = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** What a response is about: one object, or a diff between two commits. */
export type ResponseObject =
  | { readonly kind: "commit" | "tree" | "blob"; readonly oid: string }
  | { readonly kind: "diff"; readonly base: string; readonly head: string };

function checkOid(oid: string): string {
  if (!OID.test(oid)) throw new RangeError("not a lowercase hex object id");
  return oid;
}

/**
 * The cache key URL of a response: repository id, object kind, object id
 * (or base and head of a diff) and variant, each validated. Throws
 * RangeError for anything that may not form a key.
 */
export function responseCacheUrl(repoId: string, object: ResponseObject, variant: string): string {
  if (!isId(repoId, "rep")) throw new RangeError("not a repository id");
  if (!VARIANT.test(variant)) throw new RangeError("not a response variant");
  let target: string;
  switch (object.kind) {
    case "commit":
    case "tree":
    case "blob":
      target = checkOid(object.oid);
      break;
    case "diff":
      target = `${checkOid(object.base)}..${checkOid(object.head)}`;
      break;
    default:
      throw new RangeError("not a response object kind");
  }
  return `${KEY_ORIGIN}/v1/${repoId}/${object.kind}/${target}/${variant}`;
}
