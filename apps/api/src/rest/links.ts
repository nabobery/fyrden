/**
 * GitHub's `Link` header for a list paged by `page` and `per_page`: `prev`
 * and `first` past the first page, `next` and `last` before the last, each
 * the request's URL with only `page` changed (every other byte of the URL as
 * the client sent it, so a client follows the origin and path it used). The
 * last page comes from `total_count` and the page size the list read, which
 * may be smaller than the one asked. Nothing when everything fits one page.
 */
export function pageLinks(
  url: URL,
  page: number,
  perPage: number,
  totalCount: number,
): string | undefined {
  const last = Math.max(1, Math.ceil(totalCount / perPage));
  const links: string[] = [];
  const link = (to: number, rel: string) => links.push(`<${withPage(url, to)}>; rel="${rel}"`);
  if (page > 1) link(Math.min(page - 1, last), "prev");
  if (page < last) {
    link(page + 1, "next");
    link(last, "last");
  }
  if (page > 1) link(1, "first");
  return links.length > 0 ? links.join(", ") : undefined;
}

function withPage(url: URL, page: number): string {
  const parts = url.search === "" ? [] : url.search.slice(1).split("&");
  let placed = false;
  const kept: string[] = [];
  for (const part of parts) {
    if (keyOf(part) !== "page") kept.push(part);
    else if (!placed) {
      kept.push(`page=${page}`);
      placed = true;
    }
  }
  if (!placed) kept.push(`page=${page}`);
  return `${url.origin}${url.pathname}?${kept.join("&")}`;
}

function keyOf(part: string): string {
  const key = part.split("=", 1)[0] ?? "";
  try {
    return decodeURIComponent(key.replaceAll("+", " "));
  } catch {
    return key;
  }
}
