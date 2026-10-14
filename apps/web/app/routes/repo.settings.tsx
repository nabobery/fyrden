import { Form, redirect, useActionData } from "react-router";
import { RepoHeader } from "../components/repo-header.js";
import { apiCall, apiGet, assertSameOrigin } from "../lib/api.server.js";
import type { Repo } from "../lib/types.js";
import type { Route } from "./+types/repo.settings";

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `Settings · ${params.owner}/${params.repo} · Fyrden` }];
}

const repoPath = (owner: string, repo: string) =>
  `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const repo = await apiGet<Repo>(context, request, repoPath(params.owner, params.repo));
  const rulesets = await apiCall<{ rulesets: { id: number; name: string; enforcement: string }[] }>(
    context,
    request,
    "GET",
    `${repoPath(params.owner, params.repo)}/rulesets`,
  );
  return {
    repo,
    origin: new URL(request.url).origin,
    rulesets: rulesets.status === 200 ? rulesets.body.rulesets : [],
  };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  assertSameOrigin(request);
  const form = await request.formData();
  const path = repoPath(params.owner, params.repo);
  if (form.get("intent") === "delete") {
    if (form.get("confirm") !== params.repo)
      return { error: "Type the repository's name to delete it." };
    const removed = await apiCall<{ detail?: string }>(context, request, "DELETE", path);
    if (removed.status >= 400)
      return { error: removed.body?.detail ?? "The repository was not deleted." };
    return redirect("/");
  }
  const expires = String(form.get("expires_at") ?? "");
  const updated = await apiCall<Repo & { detail?: string }>(context, request, "PATCH", path, {
    description: String(form.get("description") ?? ""),
    default_branch: String(form.get("default_branch") ?? ""),
    is_template: form.get("is_template") === "on",
    expires_at: expires ? Date.parse(`${expires}T00:00:00Z`) : null,
  });
  if (updated.status !== 200)
    return { error: updated.body.detail ?? "The settings were not saved." };
  return { saved: true };
}

export default function Settings({ loaderData }: Route.ComponentProps) {
  const result = useActionData<typeof action>();
  const { repo, origin, rulesets } = loaderData;
  const expires = repo.expires_at ? new Date(repo.expires_at).toISOString().slice(0, 10) : "";
  return (
    <main>
      <RepoHeader repo={repo} origin={origin} active="settings" />
      <section className="panel" aria-labelledby="general">
        <h2 id="general">General</h2>
        <Form method="post">
          <label htmlFor="description">Description</label>
          <input
            id="description"
            name="description"
            defaultValue={repo.description ?? ""}
            size={60}
          />
          <label htmlFor="default_branch">Default branch</label>
          <input
            id="default_branch"
            name="default_branch"
            defaultValue={repo.default_branch}
            required
          />
          <label htmlFor="expires_at">Delete on (optional)</label>
          <input id="expires_at" name="expires_at" type="date" defaultValue={expires} />
          <p>
            <input
              id="is_template"
              name="is_template"
              type="checkbox"
              defaultChecked={repo.is_template}
            />{" "}
            <label htmlFor="is_template" style={{ display: "inline" }}>
              Template repository
            </label>
          </p>
          <p>
            <button className="primary" type="submit" name="intent" value="save">
              Save
            </button>
          </p>
        </Form>
        {result && "saved" in result && <p role="status">Saved.</p>}
      </section>
      <section className="panel" aria-labelledby="rulesets">
        <h2 id="rulesets">Rulesets</h2>
        {rulesets.length === 0 ? (
          <p className="muted">None. Rulesets are managed through the API for now.</p>
        ) : (
          <ul>
            {rulesets.map((r) => (
              <li key={r.id}>
                {r.name} <span className="badge">{r.enforcement}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="panel" aria-labelledby="danger">
        <h2 id="danger">Delete this repository</h2>
        <Form method="post">
          <label htmlFor="confirm">Type {repo.name} to confirm</label>
          <input id="confirm" name="confirm" autoComplete="off" />
          <p>
            <button className="danger" type="submit" name="intent" value="delete">
              Delete repository
            </button>
          </p>
        </Form>
      </section>
      {result && "error" in result && (
        <p className="error" role="alert">
          {result.error}
        </p>
      )}
    </main>
  );
}
