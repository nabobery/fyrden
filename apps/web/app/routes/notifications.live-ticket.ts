import { apiCall, assertSameOrigin, checkSession, readForm } from "../lib/api.server.js";
import { LIVE_PAUSE_MAX_MS, type LiveTicket, nextUtcDay } from "../lib/live.js";
import type { Route } from "./+types/notifications.live-ticket";

/*
 * A ticket for live hints, asked for by a page's script: the API issues it
 * to the session (which a browser's socket cannot name in a header), and
 * the socket opens on this origin, which forwards it to the API with the
 * session's cookie. Asked for the viewer the page was drawn for: another
 * signed in since gets nothing. Refused for today, the page pauses until
 * the time the API names (the next UTC day when that is malformed);
 * refused for now, it asks again later.
 */

const answer = (ticket: LiveTicket) =>
  Response.json(ticket, { headers: { "Cache-Control": "no-store" } });

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const form = await readForm(request, 1024);
  const session = await checkSession(context, request);
  // Not known (the check failed): asked again later; signed out or another viewer: never.
  if (session.state === "unknown") return answer({ kind: "retry" });
  if (session.state === "signed-out" || session.user.id !== String(form.get("viewer") ?? ""))
    return answer({ kind: "stop" });
  const issued = await apiCall<{ ticket?: unknown }>(
    context,
    request,
    "POST",
    "/notifications/live",
  );
  if (issued.status === 201 || issued.status === 200) {
    const ticket = issued.body?.ticket;
    if (typeof ticket !== "string") return answer({ kind: "retry" });
    const origin = new URL(request.url).origin.replace(/^http/, "ws");
    return answer({
      kind: "ticket",
      url: `${origin}/api/notifications/live?ticket=${encodeURIComponent(ticket)}`,
    });
  }
  const problem = issued.body as { code?: unknown; retry_at?: unknown } | null;
  if (issued.status === 429 && problem?.code === "live_budget") {
    const at = problem.retry_at;
    const now = Date.now();
    return answer({
      kind: "budget",
      retryAt:
        typeof at === "number" && Number.isSafeInteger(at) && at <= now + LIVE_PAUSE_MAX_MS
          ? at
          : nextUtcDay(now),
    });
  }
  if (issued.status === 503 && problem?.code === "live_unavailable") return answer({ kind: "off" });
  if (issued.status === 503 && problem?.code === "live_temporary")
    return answer({ kind: "retry", temporary: true });
  // Signed out, a credential that may not, or not a user's: asking again changes nothing.
  if (issued.status === 401 || issued.status === 403) return answer({ kind: "stop" });
  return answer({ kind: "retry" });
}
