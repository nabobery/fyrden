import { apiDownload } from "../lib/api.server.js";
import type { Route } from "./+types/repo.archive";

/**
 * An archive of a branch, tag or commit (`.tar.gz` or `.zip`): the bytes
 * the API's tarball or zipball route serves. While the API builds it, a
 * short page that asks again when the API says to.
 */
export async function loader({ request, context, params }: Route.LoaderArgs) {
  if (params.format !== "tar.gz" && params.format !== "zip")
    throw new Response("Not found", { status: 404 });
  const ref = new URL(request.url).searchParams.get("ref");
  const route = params.format === "zip" ? "zipball" : "tarball";
  // A ref's slashes stay path separators (the API takes the rest of the path as the ref).
  const at = ref ? `/${ref.split("/").map(encodeURIComponent).join("/")}` : "";
  const res = await apiDownload(
    context,
    request,
    `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/${route}${at}`,
  );
  if (res.status !== 202) return res;
  const wait = res.headers.get("Retry-After") ?? "5";
  // Asks again for the commit being built: the branch may move on meanwhile.
  const building = (await res.json().catch(() => null)) as { commit?: unknown } | null;
  const commit = typeof building?.commit === "string" ? building.commit : ref;
  const again = `/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/archive/${params.format}${commit ? `?ref=${encodeURIComponent(commit)}` : ""}`;
  return new Response("The archive is being prepared; this page asks again in a few seconds.\n", {
    status: 202,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Retry-After": wait,
      Refresh: `${wait}; url=${again}`,
      "Cache-Control": "private, no-store",
    },
  });
}
