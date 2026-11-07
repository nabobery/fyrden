import { apiFetch } from "../lib/api.server.js";
import type { Route } from "./+types/repo.paths";

/** What the finder may ask the API. */
const QUERY = ["ref", "cursor", "per_page"] as const;

/**
 * A page of a tree's paths for the finder, streamed unread: a request has about
 * 10 ms of CPU on Workers Free, and a page can hold 1 MiB of JSON the browser
 * parses anyway. A refusal keeps its body: `repo_empty` and `busy` are both 409.
 */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const asked = new URL(request.url).searchParams;
  const query = new URLSearchParams();
  for (const name of QUERY) {
    const value = asked.get(name);
    if (value !== null) query.set(name, value);
  }
  const res = await apiFetch(
    context,
    request,
    "GET",
    `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/paths?${query}`,
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
