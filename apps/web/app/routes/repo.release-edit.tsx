import { Form, redirect, useActionData, useNavigation } from "react-router";
import { AssetsTable, AssetUploader } from "../components/release-assets.js";
import { ReleaseFields } from "../components/release-fields.js";
import { RepoHeader } from "../components/repo-header.js";
import { apiGet, assertSameOrigin, checkSession, readForm } from "../lib/api.server.js";
import { type EditResult, type Scope, sameScope, type Written } from "../lib/edits.js";
import { editSender, NO_VERSION } from "../lib/edits.server.js";
import { positiveId } from "../lib/pages.js";
import { field, rawField, repoApiPath } from "../lib/pulls.js";
import {
  RELEASE_FORM_MAX_BYTES,
  type Release,
  releaseByTagApi,
  releasePage,
} from "../lib/releases.js";
import { tagOfPage } from "../lib/target.js";
import type { Repo } from "../lib/types.js";
import type { Route } from "./+types/repo.release-edit";

type EditScope = Scope & { owner: string; repo: string; page: "edit-release"; release: string };

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `Edit ${params["*"]} · ${params.owner}/${params.repo} · Fyrden` }];
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
    at: { owner: params.owner, repo: params.repo },
    release,
    origin: new URL(request.url).origin,
    viewer: session.state === "signed-in" ? session.user.id : null,
  };
}

const draftOf = (form: FormData): Written => ({
  fields: {
    // Exactly as written: git takes names `field` would trim, and a trimmed one is another tag.
    tag_name: rawField(form, "tag_name"),
    name: field(form, "name"),
    body: rawField(form, "body"),
    prerelease: field(form, "prerelease"),
  },
});

export async function action({
  request,
  context,
  params,
}: Route.ActionArgs): Promise<EditResult<EditScope>> {
  assertSameOrigin(request);
  const form = await readForm(request, RELEASE_FORM_MAX_BYTES);
  const sender = await editSender(
    context,
    request,
    form,
    (viewer): EditScope => ({
      viewer,
      owner: params.owner,
      repo: params.repo,
      page: "edit-release",
      // A draft is of this release: another under the same tag since mustn't take its text.
      release: field(form, "id"),
    }),
    draftOf,
  );
  if (sender.refused) return sender.refused;
  const draft = draftOf(form);
  if (!sender.expected) return sender.refuse(NO_VERSION, draft);
  const id = positiveId(field(form, "id"));
  if (id === null) return sender.refuse("No such release.", draft);
  const tag = draft.fields.tag_name as string;
  if (!tag) return sender.refuse("Give it a tag.", draft);
  const publishing = field(form, "intent") === "publish";
  const published = field(form, "published") === "1";
  const result = await sender.send(
    "PATCH",
    `${repoApiPath(params.owner, params.repo)}/releases/${id}`,
    {
      ...(!published && { tag_name: tag }),
      name: draft.fields.name || null,
      body: draft.fields.body || null,
      prerelease: draft.fields.prerelease === "on",
      ...(publishing && { draft: false }),
      ...sender.expected,
    },
    publishing ? "publish" : "edit",
    publishing ? "The release was not published." : "The release was not changed.",
    draft,
  );
  if (result.ok) throw redirect(releasePage(params.owner, params.repo, tag));
  return result;
}

export default function EditRelease({ loaderData }: Route.ComponentProps) {
  const { repo, at, release, origin, viewer } = loaderData;
  const answer = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  // An answer is this page's only in its scope: a draft never shows under another viewer.
  const scope: EditScope | undefined =
    viewer === null
      ? undefined
      : {
          viewer,
          owner: at.owner,
          repo: at.repo,
          page: "edit-release",
          release: String(release.id),
        };
  const result =
    answer?.scope === undefined || (scope && sameScope(answer.scope, scope)) ? answer : undefined;
  const kept = result?.draft?.fields;
  return (
    // Keyed by whose page and which release: uncontrolled fields carry nothing to another.
    <main key={`${at.owner}/${at.repo}:${release.id}:${viewer ?? "anonymous"}`}>
      <RepoHeader repo={repo} origin={origin} active="releases" />
      <h2>Edit {release.name || release.tag_name}</h2>
      {result?.error && (
        <p className="error" role="alert">
          {result.error}
        </p>
      )}
      <Form method="post" className="panel">
        <input type="hidden" name="viewer" value={viewer ?? ""} />
        <input type="hidden" name="id" value={release.id} />
        <input type="hidden" name="version" value={result?.draft?.version ?? release.version} />
        <input type="hidden" name="published" value={release.draft ? "0" : "1"} />
        <ReleaseFields
          tagFixed={!release.draft}
          shown={{
            tag_name: kept?.tag_name ?? release.tag_name,
            name: kept?.name ?? release.name ?? "",
            body: kept?.body ?? release.body ?? "",
            prerelease: kept ? kept.prerelease === "on" : release.prerelease,
          }}
        />
        <p className="row">
          {release.draft && (
            <button type="submit" name="intent" value="publish" className="primary" disabled={busy}>
              Publish release
            </button>
          )}
          <button type="submit" name="intent" value="edit" disabled={busy}>
            {release.draft ? "Save draft" : "Save release"}
          </button>
        </p>
      </Form>
      <section aria-labelledby="assets-heading">
        <h3 id="assets-heading">Assets</h3>
        <AssetsTable owner={repo.owner} repo={repo.name} release={release} />
        {viewer !== null && repo.permissions?.push === true && (
          <AssetUploader owner={repo.owner} repo={repo.name} release={release} />
        )}
      </section>
    </main>
  );
}
