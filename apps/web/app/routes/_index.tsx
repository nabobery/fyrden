import { Form, Link, redirect, useActionData } from "react-router";
import { Pager } from "../components/pager.js";
import { apiCall, apiGet, assertSameOrigin, readForm, signedInUser } from "../lib/api.server.js";
import { pageLinks, pageQuery } from "../lib/pages.js";
import type { Repo } from "../lib/types.js";
import type { Route } from "./+types/_index";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Fyrden" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = await signedInUser(context, request);
  const url = new URL(request.url);
  if (!user) return { user: null, repos: [], pages: pageLinks(url, "cursor", null) };
  const page = await apiGet<{ repos: Repo[]; next_cursor: string | null }>(
    context,
    request,
    `/user/repos?${pageQuery(url, "cursor")}`,
  );
  return { user, repos: page.repos, pages: pageLinks(url, "cursor", page.next_cursor) };
}

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const form = await readForm(request);
  const name = String(form.get("name") ?? "").trim();
  const description = String(form.get("description") ?? "").trim();
  const made = await apiCall<Repo & { detail?: string }>(context, request, "POST", "/user/repos", {
    name,
  });
  if (made.status !== 201) return { error: made.body.detail ?? "The repository was not created." };
  if (description)
    await apiCall(context, request, "PATCH", `/repos/${made.body.owner}/${made.body.name}`, {
      description,
    });
  return redirect(`/${made.body.owner}/${made.body.name}`);
}

export default function Index({ loaderData }: Route.ComponentProps) {
  const failed = useActionData<typeof action>();
  if (!loaderData.user)
    return (
      <main>
        <h1>Fyrden</h1>
        <p>Git hosting for people and their agents.</p>
        <p>
          <a className="button" href="/auth/sign-in?return_to=%2F">
            Sign in
          </a>
        </p>
      </main>
    );
  return (
    <main>
      <h1>Your repositories</h1>
      {loaderData.repos.length === 0 ? (
        <p className="muted">No repositories yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Description</th>
            </tr>
          </thead>
          <tbody>
            {loaderData.repos.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link to={`/${r.owner}/${r.name}`}>{r.full_name}</Link>
                </td>
                <td className="muted">{r.description ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Pager links={loaderData.pages} label="Repositories" />
      <section className="panel" aria-labelledby="new-repo">
        <h2 id="new-repo">New repository</h2>
        <Form method="post">
          <label htmlFor="name">Name</label>
          <input id="name" name="name" required pattern="[A-Za-z0-9._\-]{1,100}" />
          <label htmlFor="description">Description (optional)</label>
          <input id="description" name="description" maxLength={350} />
          <p>
            <button className="primary" type="submit">
              Create
            </button>
          </p>
          {failed?.error && (
            <p className="error" role="alert">
              {failed.error}
            </p>
          )}
        </Form>
      </section>
    </main>
  );
}
