import { apiFetch } from "../lib/api.server.js";
import { refAndPath } from "../lib/target.js";
import type { Route } from "./+types/repo.blame-ranges";

/** What the blame page may pass on: the commit and path come from the URL. */
const QUERY = ["continuation", "per_page", "line_start", "line_end"] as const;

/**
 * One answer of blame's ranges for the page's script, at the commit and path the URL names,
 * streamed unread: a page can hold several MiB of JSON the browser parses anyway, and a
 * request has about 10 ms of CPU on Workers Free. A refusal keeps its status, body and
 * `Retry-After`. The URL ends in a slash, so a path ending in `.data` isn't taken for a data
 * request.
 */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { ref, path } = refAndPath(request);
  const asked = new URL(request.url).searchParams;
  const query = new URLSearchParams({ path, ref });
  for (const name of QUERY) {
    const value = asked.get(name);
    if (value !== null) query.set(name, value);
  }
  const res = await apiFetch(
    context,
    request,
    "GET",
    `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/blame?${query}`,
  );
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  for (const name of ["Content-Type", "Retry-After"]) {
    const value = res.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Response(res.body, { status: res.status, headers });
}
