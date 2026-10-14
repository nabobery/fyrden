import { Form, redirect, useActionData } from "react-router";
import { apiCall, apiGet, assertSameOrigin, signedInUser, signInUrl } from "../lib/api.server.js";
import type { Route } from "./+types/settings.agents";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Agents · Fyrden" }];
}

interface Agent {
  id: string;
  handle: string;
  owner: string;
  disabled: boolean;
}
interface Grant {
  id: string;
  agent: string;
  scopes: string[];
  expires_at: number;
  revoked_at: number | null;
  depth: number;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  if (!(await signedInUser(context, request))) throw redirect(signInUrl(request));
  const [{ agents }, { grants }] = await Promise.all([
    apiGet<{ agents: Agent[] }>(context, request, "/agents?per_page=100"),
    apiGet<{ grants: Grant[] }>(context, request, "/grants?per_page=100"),
  ]);
  return { agents, grants };
}

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  const fail = (body: unknown, fallback: string) => ({
    error: (body as { detail?: string } | null)?.detail ?? fallback,
  });
  if (intent === "create-agent") {
    const made = await apiCall(context, request, "POST", "/agents", {
      handle: String(form.get("handle") ?? ""),
    });
    return made.status === 201
      ? { done: "Agent created." }
      : fail(made.body, "The agent was not created.");
  }
  if (intent === "disable-agent") {
    await apiCall(
      context,
      request,
      "DELETE",
      `/agents/${encodeURIComponent(String(form.get("agent")))}`,
    );
    return { done: "Agent disabled." };
  }
  if (intent === "agent-token") {
    const made = await apiCall<{ token: string }>(
      context,
      request,
      "POST",
      `/agents/${encodeURIComponent(String(form.get("agent")))}/tokens`,
      { type: "pat" },
    );
    return made.status === 201
      ? { token: made.body.token }
      : fail(made.body, "The token was not created.");
  }
  if (intent === "grant") {
    const made = await apiCall(context, request, "POST", "/grants", {
      agent: String(form.get("agent") ?? ""),
      scopes: form.getAll("scopes").map(String),
      expires_in_days: Number(form.get("days") ?? 30),
    });
    return made.status === 201
      ? { done: "Grant created." }
      : fail(made.body, "The grant was not created.");
  }
  if (intent === "revoke-grant") {
    await apiCall(
      context,
      request,
      "DELETE",
      `/grants/${encodeURIComponent(String(form.get("grant")))}`,
    );
    return { done: "Grant revoked." };
  }
  return { error: "Unknown request." };
}

export default function Agents({ loaderData }: Route.ComponentProps) {
  const result = useActionData<typeof action>();
  const { agents, grants } = loaderData;
  return (
    <main>
      <h1>Agents</h1>
      {result && "token" in result && (
        <section className="panel" role="status">
          <h2>The agent's new token</h2>
          <p>
            Copy it now: it is not shown again. The agent trades it for delegated tokens at{" "}
            <code>/oauth/token</code>.
          </p>
          <pre className="secret">{result.token}</pre>
        </section>
      )}
      {result && "done" in result && <p role="status">{result.done}</p>}
      {result && "error" in result && (
        <p className="error" role="alert">
          {result.error}
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th scope="col">Agent</th>
            <th scope="col">State</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.id}>
              <td>{a.handle}</td>
              <td>{a.disabled ? "disabled" : "active"}</td>
              <td>
                {!a.disabled && (
                  <Form method="post" className="row">
                    <input type="hidden" name="agent" value={a.handle} />
                    <button type="submit" name="intent" value="agent-token">
                      New token
                    </button>
                    <button className="danger" type="submit" name="intent" value="disable-agent">
                      Disable
                    </button>
                  </Form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <section className="panel" aria-labelledby="new-agent">
        <h2 id="new-agent">New agent</h2>
        <Form method="post" className="row">
          <label htmlFor="handle" className="visually-hidden">
            Handle
          </label>
          <input id="handle" name="handle" required placeholder="handle" />
          <button className="primary" type="submit" name="intent" value="create-agent">
            Create agent
          </button>
        </Form>
      </section>
      <h2>Delegation grants</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Agent</th>
            <th scope="col">Scopes</th>
            <th scope="col">Expires</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {grants.map((g) => (
            <tr key={g.id}>
              <td>{g.agent}</td>
              <td>{g.scopes.join(", ")}</td>
              <td>
                {g.revoked_at ? "revoked" : new Date(g.expires_at).toISOString().slice(0, 10)}
              </td>
              <td>
                {!g.revoked_at && (
                  <Form method="post">
                    <input type="hidden" name="grant" value={g.id} />
                    <button className="danger" type="submit" name="intent" value="revoke-grant">
                      Revoke
                    </button>
                  </Form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <section className="panel" aria-labelledby="new-grant">
        <h2 id="new-grant">Let an agent act for you</h2>
        <Form method="post">
          <label htmlFor="grant-agent">Agent handle</label>
          <input id="grant-agent" name="agent" required />
          <fieldset>
            <legend>With</legend>
            {["metadata:read", "contents:read", "contents:write"].map((s) => (
              <div key={s}>
                <input id={`grant-${s}`} type="checkbox" name="scopes" value={s} />{" "}
                <label htmlFor={`grant-${s}`} style={{ display: "inline", fontWeight: "normal" }}>
                  <code>{s}</code>
                </label>
              </div>
            ))}
          </fieldset>
          <label htmlFor="grant-days">For (days)</label>
          <input id="grant-days" name="days" type="number" min={1} max={365} defaultValue={30} />
          <p>
            <button className="primary" type="submit" name="intent" value="grant">
              Create grant
            </button>
          </p>
        </Form>
      </section>
    </main>
  );
}
