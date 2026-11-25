import { type RouterContextProvider, redirect } from "react-router";
import { apiCall, type Problem, signInUrl } from "./api.server.js";
import { type RunnerErrors, runnerErrors } from "./runners.js";

const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;

/** The id of the organization's repository `name`, or the error its field shows. */
export async function repositoryId(
  context: Readonly<RouterContextProvider>,
  request: Request,
  org: string,
  name: string,
): Promise<{ readonly id: string } | { readonly error: RunnerErrors }> {
  const missing = { error: { repository: `${name}: not a repository of this organization.` } };
  if (!REPOSITORY.test(name)) return missing;
  const found = await apiCall<{ id: string } & Problem>(
    context,
    request,
    "GET",
    `/repos/${encodeURIComponent(org)}/${encodeURIComponent(name)}`,
  );
  if (found.status === 401) throw redirect(signInUrl(request));
  if (found.status === 404) return missing;
  if (found.status !== 200) return { error: runnerErrors(found.body ?? { status: found.status }) };
  return { id: found.body.id };
}
