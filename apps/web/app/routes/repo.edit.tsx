import { Form, Link, redirect, useActionData } from "react-router";
import { apiCall, apiGet, assertSameOrigin } from "../lib/api.server.js";
import { type Contents, decodeText, encodePath, encodeText } from "../lib/types.js";
import type { Route } from "./+types/repo.edit";

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `Edit ${params["*"]} · ${params.owner}/${params.repo} · Fyrden` }];
}

const repoPath = (owner: string, repo: string) =>
  `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

/**
 * Editing a file on a branch (or, with `?new=1`, adding one under the
 * path): one commit through the API's file write, signed by Fyrden.
 */
export async function loader({ request, context, params }: Route.LoaderArgs) {
  const path = params["*"] ?? "";
  const adding = new URL(request.url).searchParams.get("new") === "1";
  if (adding)
    return {
      owner: params.owner,
      repo: params.repo,
      ref: params.ref,
      path,
      adding,
      text: "",
      sha: null,
    };
  const contents = await apiGet<Contents>(
    context,
    request,
    `${repoPath(params.owner, params.repo)}/contents/${encodePath(path)}?ref=${encodeURIComponent(params.ref)}`,
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
    ref: params.ref,
    path,
    adding,
    text,
    sha: contents.sha,
  };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  assertSameOrigin(request);
  const form = await request.formData();
  const dir = params["*"] ?? "";
  const adding = form.get("adding") === "1";
  const name = String(form.get("name") ?? "").trim();
  const path = adding ? [dir.replace(/\/+$/, ""), name].filter(Boolean).join("/") : dir;
  const message =
    String(form.get("message") ?? "").trim() || (adding ? `Add ${path}` : `Update ${path}`);
  const base = `${repoPath(params.owner, params.repo)}/contents/${encodePath(path)}`;
  const sha = String(form.get("sha") ?? "");
  if (form.get("intent") === "delete") {
    const removed = await apiCall<{ detail?: string }>(context, request, "DELETE", base, {
      message: `Delete ${path}`,
      sha,
      branch: params.ref,
    });
    if (removed.status !== 200)
      return { error: removed.body?.detail ?? "The file was not deleted." };
    return redirect(`/${params.owner}/${params.repo}`);
  }
  if (!path) return { error: "Name the file." };
  const written = await apiCall<{ detail?: string }>(context, request, "PUT", base, {
    message,
    content: encodeText(String(form.get("content") ?? "")),
    branch: params.ref,
    ...(sha && { sha }),
  });
  if (written.status !== 200 && written.status !== 201)
    return { error: written.body?.detail ?? "The file was not saved." };
  return redirect(
    `/${params.owner}/${params.repo}/blob/${encodeURIComponent(params.ref)}/${encodePath(path)}`,
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
