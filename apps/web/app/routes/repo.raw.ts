import { apiDownload } from "../lib/api.server.js";
import { refAndPath } from "../lib/target.js";
import { encodePath } from "../lib/types.js";
import type { Route } from "./+types/repo.raw";

/** A file's bytes, as a download (never rendered on this origin). */
export function loader({ request, context, params }: Route.LoaderArgs) {
  const { ref, path } = refAndPath(request);
  const base = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`;
  return apiDownload(
    context,
    request,
    `${base}/raw/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
  );
}
