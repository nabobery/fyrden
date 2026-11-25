import { Link } from "react-router";
import { Pager } from "../components/pager.js";
import { ORG_SETTINGS } from "../components/settings-shell.js";
import { apiFetch, bodyOf } from "../lib/api.server.js";
import { pageNumber } from "../lib/ci-settings.server.js";
import { pageUrl } from "../lib/target.js";
import type { Route } from "./+types/settings.organizations";

const PER_PAGE = 100;

interface Organization {
  readonly id: string;
  readonly login: string;
  readonly role: "admin" | "member";
}

const scopeOf = (org: Organization) => ({ kind: "organization" as const, org: org.login });

export function meta(): Route.MetaDescriptors {
  return [{ title: "Organizations · Fyrden" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const page = pageNumber(request, "page");
  const res = await apiFetch(
    context,
    request,
    "GET",
    `/user/orgs?per_page=${PER_PAGE}&page=${page}`,
  );
  const orgs = bodyOf<Organization[]>({ status: res.status, body: await res.json() }, request);
  const more = /;\s*rel="next"/.test(res.headers.get("Link") ?? "");
  const { pathname } = pageUrl(new URL(request.url));
  return {
    orgs: orgs.map(({ id, login, role }) => ({ id, login, role })),
    pages: {
      next: more ? `${pathname}?page=${page + 1}` : null,
      first: page > 1 ? pathname : null,
    },
  };
}

export default function Organizations({ loaderData }: Route.ComponentProps) {
  const { orgs, pages } = loaderData;
  return (
    <main>
      <h1>Your organizations</h1>
      {orgs.length === 0 ? (
        <p className="muted">
          {pages.first ? "No more organizations." : "You are not a member of any organization."}
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Organization</th>
              <th scope="col">Your role</th>
              <th scope="col">Settings</th>
            </tr>
          </thead>
          <tbody>
            {orgs.map((org) => (
              <tr key={org.id}>
                <th scope="row">{org.login}</th>
                <td>{org.role === "admin" ? "Owner" : "Member"}</td>
                <td>
                  {org.role === "admin" ? (
                    <span className="row">
                      {ORG_SETTINGS.filter((entry) => entry.visible(scopeOf(org))).map((entry) => (
                        <Link key={entry.key} to={entry.path(scopeOf(org))}>
                          <span className="visually-hidden">{org.login}: </span>
                          {entry.label}
                        </Link>
                      ))}
                    </span>
                  ) : (
                    <span className="muted">Owners only</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Pager links={pages} label="Organizations" />
    </main>
  );
}
