import { Form, Link, useActionData } from "react-router";
import { describedBy, ErrorSummary, FieldError } from "../components/ci-settings-ui.js";
import { AccessFields } from "../components/runner-ui.js";
import { SettingsShell } from "../components/settings-shell.js";
import { apiCall, apiGet, assertSameOrigin, type Problem, readForm } from "../lib/api.server.js";
import { problemOf } from "../lib/ci-settings.server.js";
import {
  accessOf,
  namesOf,
  type RunnerAccess,
  type RunnerErrors,
  runnerErrors,
  runnersApi,
  runnersPath,
  TOKEN_FORM_REPOS,
} from "../lib/runners.js";
import { repositoryId } from "../lib/runners.server.js";
import type { Route } from "./+types/org.runner-new";

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `New runner · ${params.org} · Fyrden` }];
}

const DEFAULT: RunnerAccess = {
  repository_access: "all",
  allows_public: false,
  allows_forks: false,
};

export async function loader({ request, context, params }: Route.LoaderArgs) {
  // The page reads before it offers a form, so the API's refusal is the page's.
  await apiGet(context, request, `${runnersApi(params.org)}?status=serving&per_page=1`);
  return { org: params.org, origin: new URL(request.url).origin };
}

type Result =
  | { readonly token: string; readonly forks: boolean }
  | { readonly errors: RunnerErrors; readonly access: RunnerAccess; readonly repositories: string };

export async function action({ request, context, params }: Route.ActionArgs): Promise<Result> {
  assertSameOrigin(request);
  const form = await readForm(request);
  const sent = accessOf(form);
  const repositories = String(form.get("repositories") ?? "");
  const access = { ...DEFAULT, ...sent };
  const refused = (errors: RunnerErrors): Result => ({ errors, access, repositories });
  if (!sent.repository_access)
    return refused({ access: "Choose which repositories it takes jobs of." });

  const names = namesOf(repositories);
  const ids: string[] = [];
  if (sent.repository_access === "selected") {
    if (names.length > TOKEN_FORM_REPOS)
      return refused({
        repositories: `At most ${TOKEN_FORM_REPOS} here. Add more on the runner's page.`,
      });
    for (const name of names) {
      const found = await repositoryId(context, request, params.org, name);
      if ("error" in found)
        return refused(
          found.error.repository ? { repositories: found.error.repository } : found.error,
        );
      ids.push(found.id);
    }
  } else if (names.length > 0)
    return refused({ repositories: 'Choose "Selected repositories" to name them.' });

  const made = await apiCall<{ token: string } & Problem>(
    context,
    request,
    "POST",
    `${runnersApi(params.org)}/registration-token`,
    { ...access, ...(sent.repository_access === "selected" && { selected_repository_ids: ids }) },
  );
  const problem = problemOf(
    { status: made.status, problem: made.status === 201 ? null : made.body },
    request,
  );
  if (made.status !== 201) return refused(runnerErrors(problem ?? { status: made.status }));
  return { token: made.body.token, forks: access.allows_forks };
}

export default function NewRunner({ loaderData }: Route.ComponentProps) {
  const result: Result | undefined = useActionData<typeof action>();
  const { org, origin } = loaderData;
  const made = result && "token" in result ? result : null;
  const refused = result && "errors" in result ? result : null;
  const errors = refused?.errors ?? {};
  const command = (ephemeral: boolean) =>
    `gitea-runner register --no-interactive --instance ${origin} --token ${made?.token}${
      ephemeral ? " --ephemeral" : ""
    }`;
  return (
    <SettingsShell scope={{ kind: "organization", org }} active="runners">
      <p>
        <Link to={runnersPath(org)}>All runners</Link>
      </p>
      {made && (
        <section className="panel" role="status" aria-labelledby="token">
          <h2 id="token">Register the runner</h2>
          <p>
            Run this on the machine within the hour. The token registers one runner and is not shown
            again.
          </p>
          <h3>{made.forks ? "An ephemeral runner" : "An ephemeral runner (one job)"}</h3>
          <pre className="secret">
            <code>{command(true)}</code>
          </pre>
          {made.forks ? (
            <p className="muted">
              This token allows fork pull requests, so it registers only an ephemeral runner.
            </p>
          ) : (
            <>
              <h3>A long-lived runner</h3>
              <pre className="secret">
                <code>{command(false)}</code>
              </pre>
            </>
          )}
          <p className="muted">
            Then start it with <code>gitea-runner daemon</code>.
          </p>
        </section>
      )}
      <section className="panel" aria-labelledby="new-runner">
        <h2 id="new-runner">{made ? "Make another token" : "New runner"}</h2>
        <p className="muted">
          Choose which jobs the runner takes before it registers: an ephemeral runner takes the
          first job it can. Labels narrow this further, and never widen it.
        </p>
        <ErrorSummary errors={{ ...errors }} />
        <Form method="post">
          <AccessFields access={refused?.access ?? DEFAULT} errors={errors} forks={true} />
          <p className="muted">A fork of a public repository needs both boxes.</p>
          <label htmlFor="repositories">Repository names, if selected</label>
          <textarea
            id="repositories"
            name="repositories"
            rows={4}
            spellCheck={false}
            autoComplete="off"
            defaultValue={refused?.repositories ?? ""}
            {...describedBy("repositories", errors.repositories)}
          />
          <p id="repositories-hint" className="muted">
            Names of this organization's repositories, one a line, {TOKEN_FORM_REPOS} at most here.
          </p>
          <FieldError id="repositories-error" message={errors.repositories} />
          <p>
            <button className="primary" type="submit">
              Create registration token
            </button>
          </p>
        </Form>
      </section>
    </SettingsShell>
  );
}
