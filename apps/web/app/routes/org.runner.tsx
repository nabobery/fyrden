import { Form, Link, redirect, useActionData, useSearchParams } from "react-router";
import {
  describedBy,
  ErrorSummary,
  FieldError,
  RepositoryAccess,
} from "../components/ci-settings-ui.js";
import { AccessFields, At } from "../components/runner-ui.js";
import { SettingsShell } from "../components/settings-shell.js";
import { apiGet, assertSameOrigin, readForm } from "../lib/api.server.js";
import { problemOf, write } from "../lib/ci-settings.server.js";
import {
  accessText,
  changesOf,
  type RunnerAccess,
  type RunnerDetail,
  type RunnerErrors,
  runnerErrors,
  runnerState,
  runnersApi,
  runnersPath,
  widens,
} from "../lib/runners.js";
import { repositoryId } from "../lib/runners.server.js";
import type { Route } from "./+types/org.runner";

export function meta({ loaderData }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `${loaderData ? `Runner ${loaderData.runner.name}` : "Runner"} · Fyrden` }];
}

const runnerApi = (org: string, id: string) => `${runnersApi(org)}/${encodeURIComponent(id)}`;

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const runner = await apiGet<RunnerDetail>(context, request, runnerApi(params.org, params.id));
  return { org: params.org, runner };
}

type Result = { readonly errors: RunnerErrors; readonly change?: Partial<RunnerAccess> };

export async function action({
  request,
  context,
  params,
}: Route.ActionArgs): Promise<Result | Response> {
  assertSameOrigin(request);
  const form = await readForm(request);
  const { org, id } = params;
  const api = runnerApi(org, id);
  const page = `${runnersPath(org)}/${id}`;
  const intent = form.get("intent");

  if (intent === "delete") {
    const runner = await apiGet<RunnerDetail>(context, request, api);
    if (form.get("confirm") !== runner.name)
      return { errors: { confirm: `Type ${runner.name} to delete it.` } };
    const problem = problemOf(await write(context, request, "DELETE", api), request);
    if (problem) return { errors: runnerErrors(problem) };
    return redirect(`${runnersPath(org)}?deleted=${encodeURIComponent(runner.name)}`);
  }

  if (intent === "add-repository" || intent === "remove-repository") {
    const name = String(form.get("repository") ?? "").trim();
    let repository = String(form.get("repository_id") ?? "");
    if (intent === "add-repository") {
      const found = await repositoryId(context, request, org, name);
      if ("error" in found) return { errors: found.error };
      repository = found.id;
    } else if (!repository) return { errors: { form: "Choose a repository to remove." } };
    const problem = problemOf(
      await write(
        context,
        request,
        intent === "add-repository" ? "PUT" : "DELETE",
        `${api}/repositories/${encodeURIComponent(repository)}`,
      ),
      request,
    );
    if (problem) return { errors: runnerErrors(problem) };
    const notice = intent === "add-repository" ? "added" : "removed";
    return redirect(
      `${page}?${notice}=${encodeURIComponent(name)}&changed=${notice === "added" ? "wider" : "narrower"}`,
    );
  }

  const change = changesOf(form);
  if (Object.keys(change).length === 0) return { errors: { form: "Nothing was changed." } };
  const problem = problemOf(
    await write(context, request, "PATCH", `${api}/access`, change),
    request,
  );
  if (problem) return { errors: runnerErrors(problem), change };
  return redirect(`${page}?changed=${widens(change) ? "wider" : "narrower"}`);
}

function ChangedNotice() {
  const [search] = useSearchParams();
  const changed = search.get("changed");
  if (changed !== "wider" && changed !== "narrower") return null;
  return (
    <p role="status">
      Access changed.{" "}
      {changed === "wider"
        ? "A job that was waiting because no runner could take it is checked again within five minutes, and offered once CI minutes and capacity allow it."
        : "It counts from the next job; a job already running goes on."}
    </p>
  );
}

export default function RunnerPage({ loaderData }: Route.ComponentProps) {
  const result: Result | undefined = useActionData<typeof action>();
  const errors: RunnerErrors = result?.errors ?? {};
  const { org, runner } = loaderData;
  const serving = runner.revoked_at === null;
  // An ephemeral runner that has its one job is given no other, so its access decides nothing.
  const editable = serving && runner.task_assigned_at === null;
  return (
    <SettingsShell scope={{ kind: "organization", org }} active="runners">
      <p>
        <Link to={runnersPath(org)}>All runners</Link>
      </p>
      <section className="panel" aria-labelledby="runner">
        <h2 id="runner">Runner {runner.name}</h2>
        <dl>
          <dt>State</dt>
          <dd>{runnerState(runner)}</dd>
          <dt>Kind</dt>
          <dd>{runner.ephemeral ? "Ephemeral: takes one job" : "Long-lived"}</dd>
          <dt>Labels</dt>
          <dd>{runner.labels.join(", ") || "None"}</dd>
          <dt>Version</dt>
          <dd>{runner.version || "Unknown"}</dd>
          <dt>Registered</dt>
          <dd>
            <At ms={runner.created_at} />
          </dd>
          {runner.declared_at !== null && (
            <>
              <dt>Last started</dt>
              <dd>
                <At ms={runner.declared_at} />
              </dd>
            </>
          )}
          {runner.revoked_at !== null && (
            <>
              <dt>Ended</dt>
              <dd>
                <At ms={runner.revoked_at} />
              </dd>
            </>
          )}
          {editable && (
            <>
              <dt>Takes jobs of</dt>
              <dd>{accessText(runner)}</dd>
            </>
          )}
        </dl>
        <ChangedNotice />
        <ErrorSummary errors={{ ...errors }} />
      </section>
      {editable && (
        <section className="panel" aria-labelledby="runner-access">
          <h2 id="runner-access">Which jobs it takes</h2>
          {/* Keyed by what is stored: a saved change shows, and what the form is compared with moves. */}
          <Form
            method="post"
            key={`${runner.repository_access}-${runner.allows_public}-${runner.allows_forks}`}
          >
            <input type="hidden" name="was_repository_access" value={runner.repository_access} />
            <input
              type="hidden"
              name="was_allows_public"
              value={runner.allows_public ? "on" : "off"}
            />
            {runner.ephemeral && (
              <input
                type="hidden"
                name="was_allows_forks"
                value={runner.allows_forks ? "on" : "off"}
              />
            )}
            <AccessFields
              access={{ ...runner, ...result?.change }}
              errors={errors}
              forks={
                runner.ephemeral ||
                "Pull requests from forks need an ephemeral runner: register one with --ephemeral. This runner is long-lived."
              }
            />
            <p className="muted">
              Choosing all repositories clears the list of selected ones. A job the runner already
              has runs on; to end it, force-cancel its run or stop the machine.
            </p>
            <p>
              <button className="primary" type="submit" name="intent" value="access">
                Save access
              </button>
            </p>
          </Form>
        </section>
      )}
      {editable && runner.repository_access === "selected" && (
        <RepositoryAccess
          noun="runner"
          repositories={runner.repositories}
          total={runner.selected_count}
          pages={{ next: null, first: null }}
          error={errors.repository}
        />
      )}
      {serving && (
        <section className="panel" aria-labelledby="delete-runner">
          <h2 id="delete-runner">Delete this runner</h2>
          <p className="muted">
            Its credential stops working at once, but a job it is running goes on on its machine. To
            end it, force-cancel its run and see that it has stopped first, or stop the machine.
          </p>
          <Form method="post">
            <label htmlFor="confirm">Type {runner.name} to confirm</label>
            <input
              id="confirm"
              name="confirm"
              autoComplete="off"
              spellCheck={false}
              {...describedBy("confirm", errors.confirm, false)}
            />
            <FieldError id="confirm-error" message={errors.confirm} />
            <p>
              <button className="danger" type="submit" name="intent" value="delete">
                Delete runner
              </button>
            </p>
          </Form>
        </section>
      )}
    </SettingsShell>
  );
}
