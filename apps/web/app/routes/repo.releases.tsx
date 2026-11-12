import { Form, Link, useActionData, useNavigation } from "react-router";
import { Pager } from "../components/pager.js";
import { RepoHeader } from "../components/repo-header.js";
import {
  apiCall,
  apiCallBounded,
  apiFetch,
  apiGet,
  assertSameOrigin,
  bodyOf,
  checkSession,
  readForm,
} from "../lib/api.server.js";
import { viewerRefusal } from "../lib/edits.server.js";
import { pageLinks, pageQuery } from "../lib/pages.js";
import { repoApiPath } from "../lib/pulls.js";
import {
  formatBytes,
  type ReleasesPage,
  type Retained,
  releaseKind,
  releasePage,
  tagNotice,
} from "../lib/releases.js";
import type { Repo } from "../lib/types.js";
import type { Route } from "./+types/repo.releases";

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `Releases · ${params.owner}/${params.repo} · Fyrden` }];
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const base = repoApiPath(params.owner, params.repo);
  const [repo, page] = await Promise.all([
    apiGet<Repo>(context, request, base),
    apiCallBounded<ReleasesPage>(
      context,
      request,
      `${base}/releases?${pageQuery(url, "cursor", 30)}`,
    ),
  ]);
  const listed = bodyOf(page, request);
  // Only an admin may purge, so only an admin is shown what is kept; a missing field means no.
  const admin = repo.permissions?.admin === true;
  const [retained, session] = admin
    ? await Promise.all([
        apiCall<Retained>(context, request, "GET", `${base}/releases/retained`)
          .then((answer) => (answer.status === 200 ? answer.body : null))
          .catch(() => null),
        checkSession(context, request),
      ])
    : [null, null];
  return {
    repo,
    retained,
    // Whose page it is: the purge it offers is sent only by that viewer.
    viewer: session?.state === "signed-in" ? session.user.id : null,
    origin: url.origin,
    releases: listed.releases,
    pages: pageLinks(url, "cursor", listed.next_cursor),
  };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  assertSameOrigin(request);
  const form = await readForm(request);
  if (form.get("intent") !== "purge") return { error: "Nothing to do." };
  // Can't be undone: never for a viewer other than the one the page was drawn for.
  const refusal = await viewerRefusal(context, request, form);
  if (refusal) return { error: refusal };
  const res = await apiFetch(
    context,
    request,
    "POST",
    `${repoApiPath(params.owner, params.repo)}/releases/retained/purge`,
    "{}",
  );
  const body = (await res.json().catch(() => null)) as {
    objects?: number;
    bytes?: number;
    detail?: string;
  } | null;
  if (res.ok) return { purging: { objects: body?.objects ?? 0, bytes: body?.bytes ?? 0 } };
  return { error: body?.detail ?? `The retained files were not purged (${res.status}).` };
}

export default function Releases({ loaderData }: Route.ComponentProps) {
  const { repo, retained, viewer, origin, releases, pages } = loaderData;
  const answer = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const base = `/${repo.owner}/${repo.name}`;
  return (
    <main>
      <RepoHeader repo={repo} origin={origin} active="releases" />
      {repo.permissions?.push === true && (
        <p className="row">
          <Link className="button" to={`${base}/releases/new`}>
            New release
          </Link>
        </p>
      )}
      {releases.length === 0 ? (
        <p className="muted">{pages.first ? "No more releases." : "No releases yet."}</p>
      ) : (
        <ul className="label-list" aria-label="Releases">
          {releases.map((release) => {
            const notice = tagNotice(release);
            return (
              <li key={release.id} className="panel">
                <h2 className="pull-title">
                  <Link to={releasePage(repo.owner, repo.name, release.tag_name)}>
                    {release.name || release.tag_name}
                  </Link>{" "}
                  <span className="badge">{releaseKind(release)}</span>
                </h2>
                <p className="muted">{release.tag_name}</p>
                {notice && <p className="muted">{notice}</p>}
              </li>
            );
          })}
        </ul>
      )}
      <Pager links={pages} label="Release" />
      {retained && (
        <section className="panel" aria-labelledby="retained-heading">
          <h2 id="retained-heading">Replaced and deleted assets</h2>
          <p>
            {retained.objects === 0
              ? "No files of replaced or deleted assets are kept."
              : `${retained.objects} ${retained.objects === 1 ? "file" : "files"} of replaced or deleted assets, ${formatBytes(retained.bytes)}, ${retained.objects === 1 ? "is" : "are"} kept on the account's storage quota for 30 days after the change, so a restore can bring ${retained.objects === 1 ? "it" : "them"} back.`}
          </p>
          {answer && "purging" in answer && (
            <p role="status">
              {`Purging ${answer.purging.objects} ${answer.purging.objects === 1 ? "file" : "files"} (${formatBytes(answer.purging.bytes)}). The quota falls as they go.`}
            </p>
          )}
          {answer && "error" in answer && (
            <p className="error" role="alert">
              {answer.error}
            </p>
          )}
          {retained.objects > 0 && viewer !== null && (
            <details>
              <summary>Purge now</summary>
              <Form method="post">
                <input type="hidden" name="viewer" value={viewer} />
                <p>
                  Purging removes these files now. A restore can't bring them back: a release
                  restored to a state naming one finds its file missing.
                </p>
                <button
                  type="submit"
                  name="intent"
                  value="purge"
                  className="danger"
                  disabled={busy}
                >
                  Purge retained files
                </button>
              </Form>
            </details>
          )}
        </section>
      )}
    </main>
  );
}
