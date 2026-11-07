import { Form, redirect, useActionData, useNavigation } from "react-router";
import { ReleaseFields } from "../components/release-fields.js";
import { RepoHeader } from "../components/repo-header.js";
import { apiGet, assertSameOrigin, checkSession, readForm } from "../lib/api.server.js";
import { type EditResult, type Scope, sameScope, type Written } from "../lib/edits.js";
import { editSender } from "../lib/edits.server.js";
import { field, rawField, repoApiPath } from "../lib/pulls.js";
import { RELEASE_FORM_MAX_BYTES, releasePage } from "../lib/releases.js";
import type { Repo } from "../lib/types.js";
import type { Route } from "./+types/repo.release-new";

type NewScope = Scope & { owner: string; repo: string; page: "new-release" };

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `New release · ${params.owner}/${params.repo} · Fyrden` }];
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const [repo, session] = await Promise.all([
    apiGet<Repo>(context, request, repoApiPath(params.owner, params.repo)),
    checkSession(context, request),
  ]);
  return {
    repo,
    at: { owner: params.owner, repo: params.repo },
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
}: Route.ActionArgs): Promise<EditResult<NewScope>> {
  assertSameOrigin(request);
  const form = await readForm(request, RELEASE_FORM_MAX_BYTES);
  const sender = await editSender(
    context,
    request,
    form,
    (viewer): NewScope => ({
      viewer,
      owner: params.owner,
      repo: params.repo,
      page: "new-release",
    }),
    draftOf,
  );
  if (sender.refused) return sender.refused;
  const draft = draftOf(form);
  const tag = draft.fields.tag_name as string;
  if (!tag) return sender.refuse("Give it a tag.", draft);
  const name = draft.fields.name;
  const body = draft.fields.body;
  const result = await sender.send(
    "POST",
    `${repoApiPath(params.owner, params.repo)}/releases`,
    {
      tag_name: tag,
      ...(name && { name }),
      ...(body && { body }),
      prerelease: draft.fields.prerelease === "on",
      draft: field(form, "intent") !== "publish",
    },
    "create",
    "The release was not created.",
    draft,
  );
  if (result.ok) throw redirect(releasePage(params.owner, params.repo, tag));
  return result;
}

export default function NewRelease({ loaderData }: Route.ComponentProps) {
  const { repo, at, origin, viewer } = loaderData;
  const answer = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  // An answer is this page's only in its scope: a draft never shows under another viewer.
  const scope: NewScope | undefined =
    viewer === null ? undefined : { viewer, owner: at.owner, repo: at.repo, page: "new-release" };
  const result =
    answer?.scope === undefined || (scope && sameScope(answer.scope, scope)) ? answer : undefined;
  const kept = result?.draft?.fields;
  return (
    // Keyed by whose page it is: another viewer's or repository's starts with empty fields.
    <main key={`${at.owner}/${at.repo}:${viewer ?? "anonymous"}`}>
      <RepoHeader repo={repo} origin={origin} active="releases" />
      <h2>New release</h2>
      {result?.error && (
        <p className="error" role="alert">
          {result.error}
        </p>
      )}
      <Form method="post" className="panel">
        <input type="hidden" name="viewer" value={viewer ?? ""} />
        <ReleaseFields
          tagFixed={false}
          shown={{
            tag_name: kept?.tag_name ?? "",
            name: kept?.name ?? "",
            body: kept?.body ?? "",
            prerelease: kept?.prerelease === "on",
          }}
        />
        <p className="row">
          <button type="submit" name="intent" value="publish" className="primary" disabled={busy}>
            Publish release
          </button>
          <button type="submit" name="intent" value="draft" disabled={busy}>
            Save draft
          </button>
        </p>
      </Form>
    </main>
  );
}
