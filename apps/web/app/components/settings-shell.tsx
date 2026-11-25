import type { ReactNode } from "react";
import { Link } from "react-router";
import type { Repo } from "../lib/types.js";
import { RepoHeader } from "./repo-header.js";

export type SettingsScope =
  | { readonly kind: "repository"; readonly repo: Repo; readonly origin: string }
  | { readonly kind: "organization"; readonly org: string };

interface SettingsEntry<S> {
  readonly key: string;
  readonly label: string;
  readonly path: (scope: S) => string;
  readonly visible: (scope: S) => boolean;
}

type RepositoryScope = Extract<SettingsScope, { kind: "repository" }>;
type OrganizationScope = Extract<SettingsScope, { kind: "organization" }>;

const repoBase = (s: RepositoryScope) => `/${s.repo.owner}/${s.repo.name}/settings`;
const orgBase = (s: OrganizationScope) => `/settings/orgs/${s.org}`;
const isAdmin = (s: RepositoryScope) => s.repo.permissions?.admin === true;

/** A repository's settings pages; the API decides who may use each (secrets and variables: admins). */
export const REPO_SETTINGS: readonly SettingsEntry<RepositoryScope>[] = [
  { key: "general", label: "General", path: repoBase, visible: () => true },
  {
    key: "secrets",
    label: "Secrets",
    path: (s) => `${repoBase(s)}/secrets/actions`,
    visible: isAdmin,
  },
  {
    key: "variables",
    label: "Variables",
    path: (s) => `${repoBase(s)}/variables/actions`,
    visible: isAdmin,
  },
];

/** An organization's settings pages; only its owners reach them (the API answers 403 otherwise). */
export const ORG_SETTINGS: readonly SettingsEntry<OrganizationScope>[] = [
  {
    key: "secrets",
    label: "Secrets",
    path: (s) => `${orgBase(s)}/secrets/actions`,
    visible: () => true,
  },
  {
    key: "variables",
    label: "Variables",
    path: (s) => `${orgBase(s)}/variables/actions`,
    visible: () => true,
  },
  {
    key: "runners",
    label: "Runners",
    path: (s) => `${orgBase(s)}/runners`,
    visible: () => true,
  },
];

function SettingsNav<S>({
  label,
  entries,
  scope,
  active,
}: {
  label: string;
  entries: readonly SettingsEntry<S>[];
  scope: S;
  active: string;
}) {
  return (
    <nav aria-label={label} className="row">
      {entries
        .filter((e) => e.visible(scope))
        .map((e) => (
          <Link key={e.key} to={e.path(scope)} aria-current={active === e.key ? "page" : undefined}>
            {e.label}
          </Link>
        ))}
    </nav>
  );
}

/** A settings page of a repository or an organization: its header, the settings pages, then the page. */
export function SettingsShell({
  scope,
  active,
  children,
}: {
  scope: SettingsScope;
  active: string;
  children: ReactNode;
}) {
  return (
    <main>
      {scope.kind === "repository" ? (
        <>
          <RepoHeader repo={scope.repo} origin={scope.origin} active="settings" />
          <SettingsNav
            label="Repository settings"
            entries={REPO_SETTINGS}
            scope={scope}
            active={active}
          />
        </>
      ) : (
        <>
          <h1>{scope.org}</h1>
          <p className="muted">Organization settings</p>
          <SettingsNav
            label="Organization settings"
            entries={ORG_SETTINGS}
            scope={scope}
            active={active}
          />
        </>
      )}
      {children}
    </main>
  );
}
