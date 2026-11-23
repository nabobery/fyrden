/*
 * The settings pages for Actions secrets and variables: which scope a page
 * manages, where its pages are, and the messages a failed write shows.
 */
import { MAX_CI_VALUE_BYTES } from "@fyrden/domain";

export type CiScope =
  | { readonly kind: "repository"; readonly owner: string; readonly repo: string }
  | { readonly kind: "organization"; readonly org: string };

export type CiKind = "secret" | "variable";

/** The scope a route's params name: `:org` for an organization's pages, else `:owner/:repo`. */
export function scopeOf(params: Readonly<Record<string, string | undefined>>): CiScope {
  if (params.org !== undefined) return { kind: "organization", org: params.org };
  return { kind: "repository", owner: params.owner ?? "", repo: params.repo ?? "" };
}

/** The scope's settings pages (`…/settings` for a repository, `/settings/orgs/:org` for an organization). */
export function settingsPath(scope: CiScope): string {
  return scope.kind === "repository"
    ? `/${scope.owner}/${scope.repo}/settings`
    : `/settings/orgs/${scope.org}`;
}

/** The list page of `kind` in `scope`. */
export const listPath = (scope: CiScope, kind: CiKind): string =>
  `${settingsPath(scope)}/${kind === "secret" ? "secrets" : "variables"}/actions`;

/** The edit page of the entry `name`. */
export const editPath = (scope: CiScope, kind: CiKind, name: string): string =>
  `${listPath(scope, kind)}/${encodeURIComponent(name)}/edit`;

/** A form's errors: a message per field, and the form's own. */
export interface FormErrors {
  readonly name?: string;
  readonly value?: string;
  readonly repository?: string;
  readonly confirm?: string;
  readonly form?: string;
}

export const VALUE_TOO_LARGE = `At most 48 KiB (${MAX_CI_VALUE_BYTES.toLocaleString("en")} bytes of UTF-8).`;

const NAME_RULES = {
  secret:
    "Use letters, digits and _, not starting with a digit or GITHUB_; GITEA_TOKEN is reserved.",
  variable: "Use letters, digits and _, not starting with a digit or GITHUB_.",
} as const;

/** What the problem a write answered means for the form. */
export function errorsFor(
  kind: CiKind,
  scope: CiScope,
  problem: { readonly status: number; readonly code?: string; readonly detail?: string },
): FormErrors {
  switch (problem.code) {
    case "invalid_secret_name":
    case "invalid_variable_name":
      return { name: NAME_RULES[kind] };
    case "secret_too_large":
    case "variable_too_large":
      return { value: VALUE_TOO_LARGE };
    case "variable_exists":
      return { name: "A variable of that name exists: edit it instead." };
    case "undecryptable_value":
      return { form: "The value could not be saved. Send it again." };
    case "bad_key_id":
      return { form: "The key for secrets changed while saving. Send it again." };
    case "too_many_secrets":
      return {
        form:
          scope.kind === "repository"
            ? "A repository has at most 100 secrets."
            : "An organization has at most 1,000 secrets.",
      };
    case "too_many_variables":
      return {
        form:
          scope.kind === "repository"
            ? "A repository has at most 500 variables."
            : "An organization has at most 1,000 variables.",
      };
    case "ci_key_unavailable":
      return {
        form: "Secrets cannot be saved until this deployment's CI key is set (an operator task). Lists keep working.",
      };
    case "repo_transferring":
      return { form: "The repository is being transferred. Try again when it ends." };
    case "repository_changed":
      return { form: "A repository moved meanwhile. Send it again." };
    case "unknown_repository":
      return { repository: "Not a repository of this organization." };
    case "too_many_repositories":
      return { repository: "At most 1,000 repositories." };
    case "visibility_not_selected":
      return { form: 'Choose "Selected repositories" first.' };
    case "rate_limited":
    case "busy":
      return { form: "Too many requests. Try again shortly." };
  }
  if (problem.status === 403 || problem.status === 404)
    return { form: "You can no longer change this, or it no longer exists." };
  if (problem.status === 429) return { form: "Too many requests. Try again shortly." };
  return { form: problem.detail ?? "It was not saved." };
}
