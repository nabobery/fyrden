import { data } from "react-router";
import { withoutTrailingSlashes } from "./types.js";

/**
 * The ref and path a repository page names (`/:owner/:repo/<view>/:ref/<path>`),
 * read from the request's own URL with each segment decoded once. React
 * Router decodes its params twice, so a name holding a literal `%2F` would
 * read as one with a slash, and name another file or branch.
 */
export function refAndPath(request: Request): { ref: string; path: string } {
  const [ref = "", ...path] = pagePath(request).split("/").slice(4);
  try {
    return {
      ref: decodeURIComponent(ref),
      path: withoutTrailingSlashes(path.map(decodeURIComponent).join("/")),
    };
  } catch {
    throw data("Not found", { status: 404 });
  }
}

/**
 * The page's path, as React Router matched it: a navigation's data request
 * (`<path>.data`, or `<path>/_.data` for one ending in a slash) reaches the
 * loader with its suffix still on.
 */
function pagePath(request: Request): string {
  return pageUrl(new URL(request.url)).pathname;
}

/**
 * The page's URL, as React Router matched it: a data request's suffix off
 * its path, and its `_routes` (which of the page's loaders to run) off its
 * query. Links a loader builds from its request's URL are built from this.
 */
export function pageUrl(url: URL): URL {
  const page = new URL(url);
  const { pathname } = page;
  if (pathname.endsWith("/_.data")) page.pathname = pathname.slice(0, -"_.data".length);
  else if (pathname.endsWith(".data")) page.pathname = pathname.slice(0, -".data".length);
  page.searchParams.delete("_routes");
  return page;
}
