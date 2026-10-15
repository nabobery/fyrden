/**
 * For answers no cache may keep: credentials, and what a signed-in person
 * sees (RFC 9111 §5.2.2.5; `Pragma` for HTTP/1.0 caches).
 */
export const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" } as const;

/**
 * A 304 for a GET or HEAD whose `If-None-Match` matches `etag` (weak
 * comparison, `*` for any; RFC 9110 §13.1.2), with `headers` (the
 * validators and caching the full answer would carry); else undefined.
 */
export function notModified(
  request: Request,
  etag: string,
  headers: Record<string, string>,
): Response | undefined {
  const condition = request.headers.get("If-None-Match");
  if (condition === null || (request.method !== "GET" && request.method !== "HEAD"))
    return undefined;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, "");
  const matches =
    condition.trim() === "*" || condition.split(",").some((tag) => opaque(tag) === opaque(etag));
  return matches
    ? new Response(null, { status: 304, headers: { ...headers, ETag: etag } })
    : undefined;
}
