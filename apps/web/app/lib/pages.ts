/**
 * Pages of the API's listings on a web page: the page's URL names each
 * listing's cursor by its own parameter, so a page with two listings moves
 * through each on its own.
 */

import { pageUrl } from "./target.js";

/** A positive id from a page's URL, else none. */
export const positiveId = (value: string | null): number | null =>
  value !== null && /^[1-9][0-9]{0,14}$/.test(value) ? Number(value) : null;

/** The API query for the page of a listing that `url` names with `param`. */
export function pageQuery(url: URL, param: string, perPage = 100): string {
  const query = new URLSearchParams({ per_page: String(perPage) });
  const cursor = url.searchParams.get(param);
  if (cursor) query.set("cursor", cursor);
  return query.toString();
}

export interface PageLinks {
  /** The next page, or null on the last. */
  readonly next: string | null;
  /** The first page, or null on it. */
  readonly first: string | null;
}

/** Links to a listing's next page (from the API's `next_cursor`) and its first. */
export function pageLinks(request: URL, param: string, nextCursor: string | null): PageLinks {
  // A navigation's data request's URL: links go to the page itself.
  const url = pageUrl(request);
  const at = (cursor: string | null) => {
    const query = new URLSearchParams(url.search);
    if (cursor === null) query.delete(param);
    else query.set(param, cursor);
    const search = query.toString();
    return search ? `${url.pathname}?${search}` : url.pathname;
  };
  return {
    next: nextCursor ? at(nextCursor) : null,
    first: url.searchParams.has(param) ? at(null) : null,
  };
}
