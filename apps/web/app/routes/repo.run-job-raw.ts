import { apiFetch, type Problem, signInUrl } from "../lib/api.server.js";
import { jobRawPath, logRefusalWords, runsApi } from "../lib/runs.js";
import type { Route } from "./+types/repo.run-job-raw";

const JOB_ID = /^[1-9][0-9]{0,9}$/;
const NO_STORE = "private, no-store";
/** The API's text page headers a browser gets: log text is whatever a workflow printed. */
const KEPT = [
  "Content-Type",
  "X-Content-Type-Options",
  "Content-Security-Policy",
  "X-Fyrden-Log-State",
];

function words(status: number, text: string, retryAfter: string | null): Response {
  const headers = new Headers({
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": NO_STORE,
    "X-Content-Type-Options": "nosniff",
  });
  if (retryAfter !== null) headers.set("Retry-After", retryAfter);
  return new Response(`${text}\n`, { status, headers });
}

/** The API's `Link` to the next page, pointed at this route with its cursor alone. */
export function nextLink(link: string | null, here: string): string | null {
  const match = link?.match(/<([^>]*)>;\s*rel="next"/);
  if (!match?.[1]) return null;
  let cursor: string | null;
  try {
    cursor = new URL(match[1], "https://api.invalid").searchParams.get("cursor");
  } catch {
    return null;
  }
  return cursor ? `<${here}?cursor=${encodeURIComponent(cursor)}>; rel="next"` : null;
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  if (!JOB_ID.test(params.job_id)) return words(404, "No such job.", null);
  const cursor = new URL(request.url).searchParams.get("cursor");
  const path = `${runsApi(params.owner, params.repo)}/runs/${encodeURIComponent(params.run_id)}/jobs/${params.job_id}/logs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
  const res = await apiFetch(context, request, "GET", path);
  if (res.status === 401) {
    void res.body?.cancel();
    return new Response(null, {
      status: 302,
      headers: { Location: signInUrl(request), "Cache-Control": NO_STORE },
    });
  }
  if (res.status !== 200) {
    const problem = (await res.json().catch(() => null)) as Problem | null;
    const status = [403, 404, 410, 422, 429, 503].includes(res.status) ? res.status : 502;
    return words(
      status,
      logRefusalWords(res.status, problem?.code),
      res.headers.get("Retry-After"),
    );
  }
  const headers = new Headers({ "Cache-Control": NO_STORE });
  for (const name of KEPT) {
    const value = res.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const here = jobRawPath(params.owner, params.repo, params.run_id, Number(params.job_id));
  const link = nextLink(res.headers.get("Link"), here);
  if (link !== null) headers.set("Link", link);
  return new Response(res.body, { status: 200, headers });
}
