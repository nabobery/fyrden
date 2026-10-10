import { api } from "../lib/cloudflare.server.js";
import type { Route } from "./+types/healthz";

/**
 * GET /healthz on fyrden-web: the API's deep health check reached through the
 * service binding, so it fails if the binding or the API is broken. The API
 * applies its health rate limit to this path too.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const requestId = request.headers.get("X-Request-Id") ?? crypto.randomUUID();
  try {
    const result = await api(context).healthz({ requestId });
    if (result.rateLimited)
      return Response.json({ ok: false, error: "rate_limited" }, { status: 429 });
    return Response.json(
      { ...result.report, binding: "ok", requestId },
      { status: result.report.ok ? 200 : 503 },
    );
  } catch (error) {
    return Response.json(
      {
        ok: false,
        binding: "failed",
        error: error instanceof Error ? error.name : "unknown",
        requestId,
      },
      { status: 503 },
    );
  }
}
