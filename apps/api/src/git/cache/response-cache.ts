import { responseCacheUrl } from "@fyrden/adapters-cloudflare";
import { admitExternalCall } from "@fyrden/adapters-cloudflare/obs";
import { assertGrant, type RepoAccessGrant } from "./grant.js";
import { ObjectGrant } from "./object-grant.js";

/** The Cache API cache for repository object responses, apart from pack blocks. */
export const RESPONSE_CACHE = "fyrden-responses";

/**
 * External calls the invocation may have made (Cache API calls of any tier
 * and outbound fetches) for the response cache to make another. Free allows
 * 50 per invocation, shared with outbound fetches (verified,
 * developers.cloudflare.com/workers/platform/limits/; measured on Workers
 * Free, 2026-10-10). Proposed.
 */
export const DEFAULT_RESPONSE_CACHE_CALLS = 10;

/** How long a colo may keep a stored response; the content never changes. Proposed: 30 days. */
const STORED_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * What clients are told about a response served from (or stored in) the
 * cache. Private content never gets a public `Cache-Control`; every
 * repository is private for now. Proposed.
 */
export const PRIVATE_CACHE_CONTROL = "private, no-store";

/**
 * Headers a stored response keeps. Everything else is dropped, in
 * particular `Set-Cookie` (the Cache API never stores a response that has
 * one, verified, developers.cloudflare.com/workers/runtime-apis/cache/)
 * and any `Cache-Control` the producer set.
 */
const KEPT_HEADERS = ["content-type", "content-disposition", "etag", "last-modified"];

export interface RepoResponseCache {
  /** The cached response for an authorized object, or undefined. */
  match(object: ObjectGrant, variant: string): Promise<Response | undefined>;
  /**
   * Stores a 200 response for an authorized object. Consumes `response`'s
   * body: pass a clone of what is sent to the client.
   */
  put(object: ObjectGrant, variant: string, response: Response): Promise<void>;
  /** Cache API calls made so far. */
  readonly calls: number;
}

export interface ResponseCacheOptions {
  /** Opens the cache; default `caches.open(RESPONSE_CACHE)`. Called on first use. */
  readonly open?: () => Promise<Cache>;
  /**
   * Most external calls the invocation may have made for this cache to make
   * another (matches and puts); later calls miss or do nothing.
   */
  readonly maxCalls?: number;
}

/**
 * The response cache of the repository a grant is for. It cannot be made
 * without a grant from the access check, and it looks up or stores only
 * objects that passed that repository's object check (`ObjectGrant`) for
 * the same grant. Keys are built here from the grant's repository id, the
 * object and the variant, so no caller can reach another repository's
 * entries, and the same SHA in two repositories is two entries.
 */
export function authorizedCache(
  grant: RepoAccessGrant,
  options: ResponseCacheOptions = {},
): RepoResponseCache {
  assertGrant(grant);
  const maxCalls = options.maxCalls ?? DEFAULT_RESPONSE_CACHE_CALLS;
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 0) {
    throw new RangeError(`bad Cache API call budget ${maxCalls}`);
  }
  let opened: Promise<Cache> | undefined;
  const cache = () => {
    opened ??= (options.open ?? (() => caches.open(RESPONSE_CACHE)))();
    return opened;
  };
  let calls = 0;
  const keyFor = (object: ObjectGrant, variant: string): string => {
    if (!ObjectGrant.isObjectGrant(object) || object.grant !== grant) {
      throw new TypeError("not an object authorized for this grant");
    }
    return responseCacheUrl(grant.repoId, object.object, variant);
  };

  return {
    get calls() {
      return calls;
    },
    async match(object, variant) {
      const key = keyFor(object, variant);
      if (!admitExternalCall(maxCalls, calls)) return undefined;
      calls++;
      let hit: Response | undefined;
      try {
        hit = await (await cache()).match(key);
      } catch {
        // The cache is optional: a refused or failed call is a miss.
        return undefined;
      }
      if (hit === undefined) return undefined;
      return new Response(hit.body, { status: hit.status, headers: clientHeaders(hit.headers) });
    },
    async put(object, variant, response) {
      const key = keyFor(object, variant);
      if (response.status !== 200 || !admitExternalCall(maxCalls, calls)) return;
      calls++;
      const headers = keptHeaders(response.headers);
      headers.set("cache-control", `max-age=${STORED_MAX_AGE_SECONDS}, immutable`);
      try {
        await (await cache()).put(key, new Response(response.body, { status: 200, headers }));
      } catch {
        // Not stored; the next request reads the object again.
      }
    },
  };
}

function keptHeaders(from: Headers): Headers {
  const headers = new Headers();
  for (const name of KEPT_HEADERS) {
    const value = from.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

function clientHeaders(from: Headers): Headers {
  const headers = keptHeaders(from);
  headers.set("cache-control", PRIVATE_CACHE_CONTROL);
  return headers;
}
