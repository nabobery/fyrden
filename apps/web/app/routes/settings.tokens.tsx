import { Form, redirect, useActionData } from "react-router";
import { apiCall, apiGet, assertSameOrigin, signedInUser, signInUrl } from "../lib/api.server.js";
import type { Route } from "./+types/settings.tokens";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Tokens · Fyrden" }];
}

interface Token {
  id: string;
  type: "pat" | "git";
  scopes: string[];
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
  revoked: boolean;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  if (!(await signedInUser(context, request))) throw redirect(signInUrl(request));
  const { tokens } = await apiGet<{ tokens: Token[] }>(
    context,
    request,
    "/user/tokens?per_page=100",
  );
  return { tokens, host: new URL(request.url).host };
}

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const form = await request.formData();
  if (form.get("intent") === "revoke") {
    await apiCall(
      context,
      request,
      "DELETE",
      `/user/tokens/${encodeURIComponent(String(form.get("id")))}`,
    );
    return { revoked: true };
  }
  const scopes = form.getAll("scopes").map(String);
  const made = await apiCall<{ token: string; type: string; detail?: string }>(
    context,
    request,
    "POST",
    "/user/tokens",
    {
      type: String(form.get("type") ?? "git"),
      scopes,
      expires_in_days: Number(form.get("days") ?? 30),
    },
  );
  if (made.status !== 201) return { error: made.body.detail ?? "The token was not created." };
  return { created: made.body.token, type: made.body.type };
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export default function Tokens({ loaderData }: Route.ComponentProps) {
  const result = useActionData<typeof action>();
  const { tokens, host } = loaderData;
  return (
    <main>
      <h1>Tokens</h1>
      {result && "created" in result && (
        <section className="panel" role="status">
          <h2>Your new {result.type} token</h2>
          <p>Copy it now: it is not shown again.</p>
          <pre className="secret">{result.created}</pre>
          {result.type === "git" && (
            <p className="muted">
              Use it as git's password, for example in{" "}
              <code>https://x-access-token:TOKEN@{host}/OWNER/REPO.git</code>.
            </p>
          )}
        </section>
      )}
      <section className="panel" aria-labelledby="new-token">
        <h2 id="new-token">New token</h2>
        <Form method="post">
          <label htmlFor="type">Kind</label>
          <select id="type" name="type" defaultValue="git">
            <option value="git">git (clone, fetch, push)</option>
            <option value="pat">personal access token (the API)</option>
          </select>
          <fieldset>
            <legend>Limited to (none: all your rights)</legend>
            {["contents:read", "contents:write", "metadata:read", "administration:write"].map(
              (s) => (
                <div key={s}>
                  <input id={`scope-${s}`} type="checkbox" name="scopes" value={s} />{" "}
                  <label htmlFor={`scope-${s}`} style={{ display: "inline", fontWeight: "normal" }}>
                    <code>{s}</code>
                  </label>
                </div>
              ),
            )}
          </fieldset>
          <label htmlFor="days">Expires in (days)</label>
          <input id="days" name="days" type="number" min={1} max={365} defaultValue={30} />
          <p>
            <button className="primary" type="submit" name="intent" value="create">
              Create token
            </button>
          </p>
        </Form>
        {result && "error" in result && (
          <p className="error" role="alert">
            {result.error}
          </p>
        )}
      </section>
      <h2>Your tokens</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Id</th>
            <th scope="col">Kind</th>
            <th scope="col">Scopes</th>
            <th scope="col">Expires</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {tokens.map((t) => (
            <tr key={t.id}>
              <td>
                <code>{t.id}</code>
              </td>
              <td>{t.type}</td>
              <td>{t.scopes.length ? t.scopes.join(", ") : "all"}</td>
              <td>{t.revoked ? "revoked" : day(t.expires_at)}</td>
              <td>
                {!t.revoked && (
                  <Form method="post">
                    <input type="hidden" name="id" value={t.id} />
                    <button className="danger" type="submit" name="intent" value="revoke">
                      Revoke
                    </button>
                  </Form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
