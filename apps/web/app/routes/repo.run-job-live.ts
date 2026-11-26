import { apiCall, assertSameOrigin, checkSession, readForm } from "../lib/api.server.js";
import type { Ticket } from "../lib/live-log.js";
import { runsApi } from "../lib/runs.js";
import type { Route } from "./+types/repo.run-job-live";

const JOB_ID = /^[1-9][0-9]{0,9}$/;
const FROM = /^(0|[1-9][0-9]{0,9})$/;

const answer = (ticket: Ticket) =>
  Response.json(ticket, { headers: { "Cache-Control": "private, no-store" } });

/**
 * A live log ticket for the page's script, issued to the session the page
 * was drawn for, with the socket's address on this origin (which forwards
 * `/api/*` to the API with the session's cookie).
 */
export async function action({ request, context, params }: Route.ActionArgs) {
  assertSameOrigin(request);
  const form = await readForm(request, 1024);
  const from = String(form.get("from") ?? "");
  if (!JOB_ID.test(params.job_id) || !FROM.test(from) || Number(from) > 2 ** 31 - 1)
    return answer({ refused: "invalid" });
  const session = await checkSession(context, request);
  if (session.state !== "signed-in" || session.user.id !== String(form.get("viewer") ?? ""))
    return answer({ refused: "signed_out" });
  const issued = await apiCall<{ ticket?: unknown; url?: unknown }>(
    context,
    request,
    "POST",
    `${runsApi(params.owner, params.repo)}/runs/${encodeURIComponent(params.run_id)}/jobs/${params.job_id}/logs/live`,
  );
  const ticket = issued.body?.ticket;
  if ((issued.status === 200 || issued.status === 201) && typeof ticket === "string") {
    const origin = new URL(request.url).origin.replace(/^http/, "ws");
    const path = `/api${runsApi(params.owner, params.repo)}/runs/${encodeURIComponent(params.run_id)}/jobs/${params.job_id}/logs/live`;
    return answer({ url: `${origin}${path}?ticket=${encodeURIComponent(ticket)}&from=${from}` });
  }
  const code = (issued.body as { code?: unknown } | null)?.code;
  return answer({ refused: typeof code === "string" ? code : `status_${issued.status}` });
}
