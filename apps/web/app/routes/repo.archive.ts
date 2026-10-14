import { apiDownload } from "../lib/api.server.js";
import type { Route } from "./+types/repo.archive";

/** An archive of a branch, tag or commit (`.tar.gz` or `.zip`). */
export function loader({ request, context, params }: Route.LoaderArgs) {
  if (params.format !== "tar.gz" && params.format !== "zip")
    throw new Response("Not found", { status: 404 });
  const ref = new URL(request.url).searchParams.get("ref");
  const base = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`;
  return apiDownload(
    context,
    request,
    `${base}/archives/${params.format}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`,
  );
}
