import { Form, Link, redirect, useActionData } from "react-router";
import {
  apiCall,
  apiGet,
  assertSameOrigin,
  readForm,
  signedInUser,
  signInUrl,
} from "../lib/api.server.js";
import { refAndPath } from "../lib/target.js";
import {
  type Contents,
  decodeText,
  encodePath,
  encodeText,
  withoutTrailingSlashes,
} from "../lib/types.js";
import type { Route } from "./+types/repo.edit";

export function meta({ params, loaderData }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `Edit ${loaderData?.path} · ${params.owner}/${params.repo} · Fyrden` }];
}

/** Content one write carries at most (the API's limit), in UTF-8 bytes. */
const MAX_CONTENT_BYTES = 4 * 1024 * 1024;
/** The editor's form at most: that content, URL-encoded (up to 3 bytes for each), and the rest. */
const EDIT_FORM_MAX_BYTES = 3 * MAX_CONTENT_BYTES + 64 * 1024;

const repoPath = (owner: string, repo: string) =>
  `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

/**
 * Editing a file on a branch (or, with `?new=1`, adding one under the
 * path): one commit through the API's file write, signed by Fyrden.
 */
export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { ref, path } = refAndPath(request);
  const adding = new URL(request.url).searchParams.get("new") === "1";
  if (adding)
    return {
      owner: params.owner,
      repo: params.repo,
      ref,
      path,
      adding,
      text: "",
      sha: null,
    };
  const contents = await apiGet<Contents>(
    context,
    request,
    `${repoPath(params.owner, params.repo)}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
  );
  const text =
    contents.type === "file" && contents.encoding === "base64"
      ? decodeText(contents.content)
      : undefined;
  if (contents.type !== "file" || text === undefined)
    throw new Response("Only text files are edited here.", { status: 422 });
  return {
    owner: params.owner,
    repo: params.repo,
    ref,
    path,
    adding,
    text,
    sha: contents.sha,
  };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  assertSameOrigin(request);
  // Signed in before a large form is read.
  if (!(await signedInUser(context, request))) throw redirect(signInUrl(request));
  const form = await readForm(request, EDIT_FORM_MAX_BYTES);
  const { ref, path: dir } = refAndPath(request);
  const adding = form.get("adding") === "1";
  const name = String(form.get("name") ?? "").trim();
  const path = adding ? [withoutTrailingSlashes(dir), name].filter(Boolean).join("/") : dir;
  const message =
    String(form.get("message") ?? "").trim() || (adding ? `Add ${path}` : `Update ${path}`);
  const base = `${repoPath(params.owner, params.repo)}/contents/${encodePath(path)}`;
  const sha = String(form.get("sha") ?? "");
  if (form.get("intent") === "delete") {
    const removed = await apiCall<{ detail?: string }>(context, request, "DELETE", base, {
      message: `Delete ${path}`,
      sha,
      branch: ref,
    });
    if (removed.status !== 200)
      return { error: removed.body?.detail ?? "The file was not deleted." };
    return redirect(`/${params.owner}/${params.repo}`);
  }
  if (!path) return { error: "Name the file." };
  const content = String(form.get("content") ?? "");
  // Within the limit before it is encoded: a UTF-16 unit is at most 3 UTF-8 bytes.
  if (
    content.length * 3 > MAX_CONTENT_BYTES &&
    new TextEncoder().encode(content).length > MAX_CONTENT_BYTES
  )
    return { error: "The file is larger than 4 MiB; push it with git instead." };
  const written = await apiCall<{ detail?: string }>(context, request, "PUT", base, {
    message,
    content: encodeText(content),
    branch: ref,
    ...(sha && { sha }),
  });
  if (written.status !== 200 && written.status !== 201)
    return { error: written.body?.detail ?? "The file was not saved." };
  return redirect(
    `/${params.owner}/${params.repo}/blob/${encodeURIComponent(ref)}/${encodePath(path)}`,
  );
}

export default function Edit({ loaderData }: Route.ComponentProps) {
  const failed = useActionData<typeof action>();
  const { owner, repo, ref, path, adding, text, sha } = loaderData;
  return (
    <main>
      <h1>
        <Link to={`/${owner}/${repo}`}>
          {owner}/{repo}
        </Link>{" "}
        <span className="muted">
          {adding ? "new file in" : "editing"} {path || "/"} on {ref}
        </span>
      </h1>
      <Form method="post">
        <input type="hidden" name="adding" value={adding ? "1" : "0"} />
        {sha && <input type="hidden" name="sha" value={sha} />}
        {adding && (
          <>
            <label htmlFor="name">File name</label>
            <input id="name" name="name" required />
          </>
        )}
        <label htmlFor="content">Content</label>
        <textarea id="content" name="content" defaultValue={text} spellCheck={false} />
        <label htmlFor="message">Commit message</label>
        <input
          id="message"
          name="message"
          placeholder={adding ? "Add a file" : `Update ${path}`}
          size={60}
        />
        <p className="row">
          <button className="primary" type="submit" name="intent" value="save">
            Commit
          </button>
          {!adding && (
            <button className="danger" type="submit" name="intent" value="delete">
              Delete file
            </button>
          )}
        </p>
        {failed?.error && (
          <p className="error" role="alert">
            {failed.error}
          </p>
        )}
      </Form>
    </main>
  );
}
