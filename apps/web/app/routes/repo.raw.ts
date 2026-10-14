import { apiDownload } from "../lib/api.server.js";
import { encodePath } from "../lib/types.js";
import type { Route } from "./+types/repo.raw";

/** A file's bytes, as a download (never rendered on this origin). */
export function loader({ request, context, params }: Route.LoaderArgs) {
  const base = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`;
  return apiDownload(
    context,
    request,
    `${base}/raw/${encodePath(params["*"] ?? "")}?ref=${encodeURIComponent(params.ref)}`,
  );
}
