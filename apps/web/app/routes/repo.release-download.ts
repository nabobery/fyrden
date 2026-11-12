import { redirect } from "react-router";
import { ASSET_DOWNLOAD, apiDownload, signInUrl } from "../lib/api.server.js";
import { repoApiPath } from "../lib/pulls.js";
import { assetOfPage } from "../lib/target.js";
import { encodePath } from "../lib/types.js";
import type { Route } from "./+types/repo.release-download";

/**
 * A release asset's bytes, by tag and name, as the API answers them: ranges, conditions and
 * HEAD passed on, and the file always an attachment that never renders on this origin.
 * Signed out, it sends to sign in and back here, since every asset needs a session.
 */
export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { tag, name } = assetOfPage(request);
  const res = await apiDownload(
    context,
    request,
    `${repoApiPath(params.owner, params.repo)}/releases/download/${encodePath(tag)}/${encodeURIComponent(name)}`,
    ASSET_DOWNLOAD,
  );
  if (res.status === 401) throw redirect(signInUrl(request));
  return res;
}
