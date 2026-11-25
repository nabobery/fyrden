import { Form, Link, redirect, useActionData, useSearchParams } from "react-router";
import { ErrorSummary, SavedNotice } from "../components/ci-settings-ui.js";
import { Pager } from "../components/pager.js";
import { At } from "../components/runner-ui.js";
import { SettingsShell } from "../components/settings-shell.js";
import { apiCall, apiGet, assertSameOrigin, type Problem, readForm } from "../lib/api.server.js";
import { problemOf } from "../lib/ci-settings.server.js";
import { pageLinks, pageQuery } from "../lib/pages.js";
import {
  accessText,
  type Runner,
  type RunnerErrors,
  runnerErrors,
  runnerState,
  runnersApi,
  runnersPath,
} from "../lib/runners.js";
import type { Route } from "./+types/org.runners";

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `Runners · ${params.org} · Fyrden` }];
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const revoked = url.searchParams.get("show") === "revoked";
  const list = await apiGet<{ runners: Runner[]; next_cursor: string | null }>(
    context,
    request,
    `${runnersApi(params.org)}?status=${revoked ? "revoked" : "serving"}&${pageQuery(url, "cursor", 50)}`,
  );
  return {
    org: params.org,
    revoked,
    runners: list.runners,
    pages: pageLinks(url, "cursor", list.next_cursor),
  };
}

export async function action({
  request,
  context,
  params,
}: Route.ActionArgs): Promise<Response | { errors: RunnerErrors }> {
  assertSameOrigin(request);
  const form = await readForm(request);
  if (form.get("intent") !== "cancel-tokens") return { errors: { form: "Nothing was changed." } };
  const result = await apiCall<{ cancelled: number } & Problem>(
    context,
    request,
    "DELETE",
    `${runnersApi(params.org)}/registration-token`,
  );
  const problem = problemOf(
    { status: result.status, problem: result.status === 200 ? null : result.body },
    request,
  );
  if (result.status !== 200) return { errors: runnerErrors(problem ?? { status: result.status }) };
  return redirect(`${runnersPath(params.org)}?cancelled=${result.body.cancelled}`);
}

function CancelledNotice() {
  const [search] = useSearchParams();
  const cancelled = search.get("cancelled");
  if (cancelled === null || !/^[0-9]{1,9}$/.test(cancelled)) return null;
  return (
    <p role="status">
      {cancelled === "0"
        ? "There was no unused token."
        : cancelled === "1"
          ? "Cancelled 1 unused token."
          : `Cancelled ${cancelled} unused tokens.`}
    </p>
  );
}

export default function Runners({ loaderData }: Route.ComponentProps) {
  const result = useActionData<typeof action>();
  const { org, revoked, runners, pages } = loaderData;
  const base = runnersPath(org);
  return (
    <SettingsShell scope={{ kind: "organization", org }} active="runners">
      <section className="panel" aria-labelledby="runners">
        <h2 id="runners">{revoked ? "Past runners" : "Self-hosted runners"}</h2>
        <p className="muted">
          Machines of yours that run this organization's Actions jobs. Whether one is connected now
          is not shown: the server does not record it.
        </p>
        <SavedNotice noun="runner" />
        <CancelledNotice />
        <ErrorSummary errors={{ ...result?.errors }} />
        <p>
          <Link className="button" to={`${base}/new`}>
            New runner
          </Link>{" "}
          {revoked ? (
            <Link to={base}>Runners in use</Link>
          ) : (
            <Link to={`${base}?show=revoked`}>Past runners</Link>
          )}
        </p>
        {runners.length === 0 ? (
          <p className="muted">{revoked ? "No past runners." : "No runners."}</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Labels</th>
                  <th scope="col">Kind</th>
                  {!revoked && <th scope="col">Takes jobs of</th>}
                  <th scope="col">State</th>
                  <th scope="col">Registered</th>
                </tr>
              </thead>
              <tbody>
                {runners.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={`${base}/${r.id}`}>{r.name}</Link>
                    </td>
                    <td>{r.labels.join(", ")}</td>
                    <td>{r.ephemeral ? "Ephemeral" : "Long-lived"}</td>
                    {!revoked && <td>{accessText(r)}</td>}
                    <td>{runnerState(r)}</td>
                    <td>
                      <At ms={r.created_at} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager links={pages} label="Runners" />
      </section>
      {!revoked && (
        <section className="panel" aria-labelledby="tokens">
          <h2 id="tokens">Unused registration tokens</h2>
          <p className="muted">
            A token works for an hour, once. If one may have leaked, cancel every token that has
            registered no runner yet. Runners already registered stay.
          </p>
          <Form method="post">
            <button className="danger" type="submit" name="intent" value="cancel-tokens">
              Cancel unused tokens
            </button>
          </Form>
        </section>
      )}
    </SettingsShell>
  );
}
