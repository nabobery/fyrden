import { Link } from "react-router";
import { SavedNotice, When } from "../components/ci-settings-ui.js";
import { Pager } from "../components/pager.js";
import { SettingsShell } from "../components/settings-shell.js";
import { apiCall } from "../lib/api.server.js";
import { editPath, listPath, scopeOf } from "../lib/ci-settings.js";
import {
  apiBase,
  loadShell,
  numberedPages,
  pageNumber,
  readList,
} from "../lib/ci-settings.server.js";
import type { Route } from "./+types/ci.secrets";

interface Secret {
  readonly name: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly unreadable?: boolean;
  readonly visibility?: "all" | "private" | "selected";
}
interface SecretList {
  readonly total_count: number;
  readonly secrets: readonly Secret[];
}

/** Secrets carry no values, so a page holds the API's most. */
const PER_PAGE = 100;

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  const scope = scopeOf(params);
  const where = scope.kind === "repository" ? `${scope.owner}/${scope.repo}` : scope.org;
  return [{ title: `Secrets · ${where} · Fyrden` }];
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const scope = scopeOf(params);
  const shell = await loadShell(context, request, scope);
  const page = pageNumber(request, "page");
  const own = await readList<SecretList>(
    context,
    request,
    `${apiBase(scope)}/actions/secrets`,
    PER_PAGE,
    page,
  );
  let inherited: {
    secrets: readonly Secret[];
    total: number;
    pages: ReturnType<typeof numberedPages>;
  } | null = null;
  let manageOrg = false;
  if (shell.kind === "repository" && shell.repo.owner_type === "Organization") {
    const orgPage = pageNumber(request, "org_page");
    const list = await readList<SecretList>(
      context,
      request,
      `${apiBase(scope)}/actions/organization-secrets`,
      PER_PAGE,
      orgPage,
    );
    inherited = {
      secrets: list.secrets,
      total: list.total_count,
      pages: numberedPages(request, "org_page", orgPage, PER_PAGE, list.total_count),
    };
    // Its owners alone may read the organization's own list: the link shows only for them.
    const probe = await apiCall(
      context,
      request,
      "GET",
      `/orgs/${encodeURIComponent(shell.repo.owner)}/actions/secrets?per_page=1`,
    );
    manageOrg = probe.status === 200;
  }
  return {
    shell,
    scope,
    secrets: own.secrets,
    total: own.total_count,
    pages: numberedPages(request, "page", page, PER_PAGE, own.total_count),
    inherited,
    manageOrg,
  };
}

export default function Secrets({ loaderData }: Route.ComponentProps) {
  const { shell, scope, secrets, total, pages, inherited, manageOrg } = loaderData;
  const org = shell.kind === "repository" ? shell.repo.owner : null;
  const orgScope = org === null ? null : ({ kind: "organization", org } as const);
  return (
    <SettingsShell scope={shell} active="secrets">
      <section className="panel" aria-labelledby="secrets">
        <h2 id="secrets">Actions secrets</h2>
        <p className="muted">
          Workflows read them as <code>secrets.NAME</code>. A value cannot be shown again once
          saved; logs mask it.
        </p>
        <SavedNotice noun="secret" />
        <p>
          <Link className="button" to={`${listPath(scope, "secret")}/new`}>
            New secret
          </Link>
        </p>
        {secrets.length === 0 ? (
          <p className="muted">No secrets.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Updated</th>
                {scope.kind === "organization" && <th scope="col">Repository access</th>}
              </tr>
            </thead>
            <tbody>
              {secrets.map((s) => (
                <tr key={s.name}>
                  <td>
                    <Link to={editPath(scope, "secret", s.name)}>
                      <code>{s.name}</code>
                    </Link>{" "}
                    {s.unreadable && <span className="badge">Unreadable: set it again</span>}
                  </td>
                  <td>
                    <When at={s.updated_at} />
                  </td>
                  {scope.kind === "organization" && <td>{s.visibility}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted">{total === 1 ? "1 secret" : `${total} secrets`}</p>
        <Pager links={pages} label="Secrets" />
      </section>
      {inherited && orgScope && (
        <section className="panel" aria-labelledby="org-secrets">
          <h2 id="org-secrets">Organization secrets</h2>
          <p className="muted">
            The secrets of {orgScope.org} that reach this repository. A repository secret of the
            same name takes their place.
            {!manageOrg && " Only the organization's owners change them."}
          </p>
          {manageOrg && (
            <p>
              <Link to={listPath(orgScope, "secret")}>Manage organization secrets</Link>
            </p>
          )}
          {inherited.secrets.length === 0 ? (
            <p className="muted">None.</p>
          ) : (
            <ul>
              {inherited.secrets.map((s) => (
                <li key={s.name}>
                  <code>{s.name}</code> <When at={s.updated_at} />{" "}
                  {s.unreadable &&
                    (manageOrg ? (
                      <Link className="badge" to={editPath(orgScope, "secret", s.name)}>
                        Unreadable: set it again
                      </Link>
                    ) : (
                      <span className="badge">
                        Unreadable: an organization owner has to set it again
                      </span>
                    ))}
                </li>
              ))}
            </ul>
          )}
          <Pager links={inherited.pages} label="Organization secrets" />
        </section>
      )}
    </SettingsShell>
  );
}
