import { Form, Link, redirect, useActionData, useNavigation } from "react-router";
import { Markdown } from "../components/markdown.js";
import { RepoHeader } from "../components/repo-header.js";
import { apiGet, assertSameOrigin, checkSession, readForm } from "../lib/api.server.js";
import type { EditResult, Scope } from "../lib/edits.js";
import { editSender } from "../lib/edits.server.js";
import { positiveId } from "../lib/pages.js";
import { field, repoApiPath } from "../lib/pulls.js";
import {
  type Release,
  releaseByTagApi,
  releaseEditor,
  releaseKind,
  sourceArchive,
  tagNotice,
} from "../lib/releases.js";
import { tagOfPage } from "../lib/target.js";
import type { Repo } from "../lib/types.js";
import type { Route } from "./+types/repo.release";

type ReleaseScope = Scope & { owner: string; repo: string; page: "release" };

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `${params["*"]} · Releases · ${params.owner}/${params.repo} · Fyrden` }];
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const base = repoApiPath(params.owner, params.repo);
  const [repo, release, session] = await Promise.all([
    apiGet<Repo>(context, request, base),
    apiGet<Release>(context, request, releaseByTagApi(base, tagOfPage(request))),
    checkSession(context, request),
  ]);
  return {
    repo,
    release,
    origin: new URL(request.url).origin,
    viewer: session.state === "signed-in" ? session.user.id : null,
  };
}

export async function action({
  request,
  context,
  params,
}: Route.ActionArgs): Promise<EditResult<ReleaseScope>> {
  assertSameOrigin(request);
  const form = await readForm(request, 16 * 1024);
  const sender = await editSender(
    context,
    request,
    form,
    (viewer): ReleaseScope => ({
      viewer,
      owner: params.owner,
      repo: params.repo,
      page: "release",
    }),
    () => undefined,
  );
  if (sender.refused) return sender.refused;
  const id = positiveId(field(form, "id"));
  if (id === null) return sender.refuse("No such release.");
  const result = await sender.send(
    "DELETE",
    `${repoApiPath(params.owner, params.repo)}/releases/${id}`,
    undefined,
    "delete",
    "The release was not deleted.",
  );
  if (result.ok) throw redirect(`/${params.owner}/${params.repo}/releases`);
  return result;
}

export default function ReleasePage({ loaderData }: Route.ComponentProps) {
  const { repo, release, origin, viewer } = loaderData;
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const manage = viewer !== null && repo.permissions?.push === true;
  const notice = tagNotice(release);
  return (
    <main>
      <RepoHeader repo={repo} origin={origin} active="releases" />
      <h2>
        {release.name || release.tag_name} <span className="badge">{releaseKind(release)}</span>
      </h2>
      <p className="muted">{release.tag_name}</p>
      {notice && <p role="note">{notice}</p>}
      {result?.error && (
        <p className="error" role="alert">
          {result.error}
        </p>
      )}
      <section className="panel" aria-label="Release notes">
        {release.body ? <Markdown source={release.body} /> : <p className="muted">No notes.</p>}
      </section>
      {release.commit_sha && (
        <section aria-label="Source code">
          <h3>Source code</h3>
          <p className="row">
            <a
              className="button"
              href={sourceArchive(repo.owner, repo.name, "tar.gz", release.commit_sha)}
            >
              Source (tar.gz)
            </a>
            <a
              className="button"
              href={sourceArchive(repo.owner, repo.name, "zip", release.commit_sha)}
            >
              Source (zip)
            </a>
          </p>
        </section>
      )}
      {manage && (
        <>
          <p className="row">
            <Link to={releaseEditor(repo.owner, repo.name, release.tag_name)}>Edit release</Link>
          </p>
          <details>
            <summary>Delete</summary>
            <Form method="post">
              <input type="hidden" name="id" value={release.id} />
              <input type="hidden" name="viewer" value={viewer} />
              <p className="muted">The tag stays. Only the release goes.</p>
              <button type="submit" disabled={busy}>
                {`Delete release ${release.tag_name}`}
              </button>
            </Form>
          </details>
        </>
      )}
    </main>
  );
}
