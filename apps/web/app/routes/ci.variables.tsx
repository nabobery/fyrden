import { Link } from "react-router";
import { SavedNotice, When } from "../components/ci-settings-ui.js";
import { Pager } from "../components/pager.js";
import { SettingsShell } from "../components/settings-shell.js";
import { editPath, listPath, scopeOf } from "../lib/ci-settings.js";
import {
  apiBase,
  loadShell,
  numberedPages,
  pageNumber,
  readList,
  shortValue,
} from "../lib/ci-settings.server.js";
import type { Route } from "./+types/ci.variables";

interface Variable {
  readonly name: string;
  readonly value: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly visibility?: "all" | "private" | "selected";
}
interface VariableList {
  readonly total_count: number;
  readonly variables: readonly Variable[];
}

/**
 * Variables a page reads, so that what one page parses stays within the list
 * bound (`LIST_MAX_BYTES`, 2 MiB) even at worst: a 48 KiB value of control
 * characters is 294,912 bytes of JSON (each escaped as `\u00XX`), so six such
 * values fit, and a page that reads two lists reads three of each.
 */
const PER_PAGE_ONE_LIST = 6;
const PER_PAGE_TWO_LISTS = 3;

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  const scope = scopeOf(params);
  const where = scope.kind === "repository" ? `${scope.owner}/${scope.repo}` : scope.org;
  return [{ title: `Variables · ${where} · Fyrden` }];
}

const shown = (variables: readonly Variable[]) =>
  variables.map((v) => ({ ...v, value: shortValue(v.value) }));

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const scope = scopeOf(params);
  const shell = await loadShell(context, request, scope);
  const inheritsFromOrg = shell.kind === "repository" && shell.repo.owner_type === "Organization";
  const perPage = inheritsFromOrg ? PER_PAGE_TWO_LISTS : PER_PAGE_ONE_LIST;
  const page = pageNumber(request, "page");
  const own = await readList<VariableList>(
    context,
    request,
    `${apiBase(scope)}/actions/variables`,
    perPage,
    page,
  );
  let inherited: {
    variables: ReturnType<typeof shown>;
    total: number;
    pages: ReturnType<typeof numberedPages>;
  } | null = null;
  if (inheritsFromOrg) {
    const orgPage = pageNumber(request, "org_page");
    const list = await readList<VariableList>(
      context,
      request,
      `${apiBase(scope)}/actions/organization-variables`,
      perPage,
      orgPage,
    );
    inherited = {
      variables: shown(list.variables),
      total: list.total_count,
      pages: numberedPages(request, "org_page", orgPage, perPage, list.total_count),
    };
  }
  return {
    shell,
    scope,
    variables: shown(own.variables),
    total: own.total_count,
    pages: numberedPages(request, "page", page, perPage, own.total_count),
    inherited,
  };
}

function VariableTable({
  variables,
  linkTo,
  visibility,
}: {
  variables: readonly Variable[];
  linkTo: ((name: string) => string) | null;
  visibility: boolean;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Value</th>
          <th scope="col">Updated</th>
          {visibility && <th scope="col">Repository access</th>}
        </tr>
      </thead>
      <tbody>
        {variables.map((v) => (
          <tr key={v.name}>
            <td>
              {linkTo ? (
                <Link to={linkTo(v.name)}>
                  <code>{v.name}</code>
                </Link>
              ) : (
                <code>{v.name}</code>
              )}
            </td>
            <td>
              <code className="ci-value">{v.value}</code>
            </td>
            <td>
              <When at={v.updated_at} />
            </td>
            {visibility && <td>{v.visibility}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function Variables({ loaderData }: Route.ComponentProps) {
  const { shell, scope, variables, total, pages, inherited } = loaderData;
  return (
    <SettingsShell scope={shell} active="variables">
      <section className="panel" aria-labelledby="variables">
        <h2 id="variables">Actions variables</h2>
        <p className="muted">
          Workflows read them as <code>vars.NAME</code>. Values are readable and not masked in logs:
          keep credentials in secrets.
        </p>
        <SavedNotice noun="variable" />
        <p>
          <Link className="button" to={`${listPath(scope, "variable")}/new`}>
            New variable
          </Link>
        </p>
        {variables.length === 0 ? (
          <p className="muted">No variables.</p>
        ) : (
          <VariableTable
            variables={variables}
            linkTo={(name) => editPath(scope, "variable", name)}
            visibility={scope.kind === "organization"}
          />
        )}
        <p className="muted">{total === 1 ? "1 variable" : `${total} variables`}</p>
        <Pager links={pages} label="Variables" />
      </section>
      {inherited && shell.kind === "repository" && (
        <section className="panel" aria-labelledby="org-variables">
          <h2 id="org-variables">Organization variables</h2>
          <p className="muted">
            The variables of {shell.repo.owner} that reach this repository. A repository variable of
            the same name takes their place.
          </p>
          {inherited.variables.length === 0 ? (
            <p className="muted">None.</p>
          ) : (
            <VariableTable variables={inherited.variables} linkTo={null} visibility={false} />
          )}
          <Pager links={inherited.pages} label="Organization variables" />
        </section>
      )}
    </SettingsShell>
  );
}
