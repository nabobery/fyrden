import { MAX_RUNNER_REPOS } from "@fyrden/domain";
import type { AccessRepository } from "./ci-settings.js";

export type RepositoryAccess = "all" | "selected";

export interface RunnerAccess {
  readonly repository_access: RepositoryAccess;
  readonly allows_public: boolean;
  readonly allows_forks: boolean;
}

export interface Runner extends RunnerAccess {
  readonly id: number;
  readonly name: string;
  readonly labels: readonly string[];
  readonly version: string;
  readonly ephemeral: boolean;
  readonly created_at: number;
  readonly declared_at: number | null;
  readonly revoked_at: number | null;
  readonly revoked_reason: "deleted" | "poll_rate" | "fleet_cap" | "spent" | null;
  readonly selected_count: number;
  readonly task_assigned_at: number | null;
}

export interface RunnerDetail extends Runner {
  readonly repositories: readonly AccessRepository[];
}

export const runnersPath = (org: string): string => `/settings/orgs/${org}/runners`;

export const runnersApi = (org: string): string =>
  `/orgs/${encodeURIComponent(org)}/actions/runners`;

/** Repositories one token form names at most: each is one lookup. */
export const TOKEN_FORM_REPOS = 20;

export const ACCESSES: readonly { value: RepositoryAccess; label: string; hint: string }[] = [
  {
    value: "all",
    label: "All repositories",
    hint: "The organization's private and internal repositories, and its public ones if allowed below.",
  },
  {
    value: "selected",
    label: "Selected repositories",
    hint: `Only the repositories listed, ${MAX_RUNNER_REPOS} at most.`,
  },
];

export const PUBLIC_WARNING =
  "A public repository's workflows can run code its maintainers did not write, such as actions, dependencies and text anyone can submit. A long-lived runner keeps what a job leaves behind, and its next job may be a private repository's. Prefer an ephemeral runner on a fresh, disposable machine, or a runner for public repositories alone.";

export const FORKS_WARNING =
  "Lets pull requests from forks run on this runner once approved, pull_request_target included. The runner takes one job, but the server cannot see the machine: register a fresh machine each time, never one that will run other jobs.";

export function accessText(runner: RunnerAccess & { readonly selected_count: number }): string {
  const parts = [
    runner.repository_access === "all"
      ? runner.allows_public
        ? "All repositories"
        : "Private and internal repositories"
      : `${runner.selected_count === 1 ? "1 repository" : `${runner.selected_count} repositories`}${
          runner.allows_public ? ", public ones too" : ""
        }`,
  ];
  if (runner.allows_forks) parts.push("fork pull requests");
  return parts.join(", ");
}

const REVOKED = {
  deleted: "Deleted",
  poll_rate: "Revoked: it asked for work too often",
  fleet_cap: "Revoked: past the deployment's runner limit",
  spent: "Had its one job",
} as const;

/** What is known of a runner: never whether it is connected, which the server does not store. */
export function runnerState(runner: Runner): string {
  if (runner.revoked_at !== null)
    return runner.revoked_reason === null ? "Revoked" : REVOKED[runner.revoked_reason];
  if (runner.task_assigned_at !== null) return "Given its one job";
  return runner.declared_at === null ? "Never started" : "Registered";
}

export interface RunnerErrors {
  readonly access?: string;
  readonly repositories?: string;
  readonly repository?: string;
  readonly public?: string;
  readonly forks?: string;
  readonly confirm?: string;
  readonly form?: string;
}

const NOT_OURS = "Not a repository of this organization.";

export function runnerErrors(problem: {
  readonly status: number;
  readonly code?: string;
  readonly detail?: string;
}): RunnerErrors {
  switch (problem.code) {
    case "forks_need_ephemeral":
      return { forks: "Only an ephemeral runner may take fork pull requests." };
    case "unknown_repository":
      return { repository: NOT_OURS };
    case "too_many_repositories":
      return { repository: `At most ${MAX_RUNNER_REPOS} repositories.` };
    case "access_not_selected":
      return { form: 'Choose "Selected repositories" first.' };
    case "runner_revoked":
      return { form: "This runner no longer serves, so its access cannot change." };
    case "runners_off":
      return { form: "Self-hosted runners are turned off on this deployment (an operator task)." };
    case "runner_fleet_full":
      return {
        form: problem.detail ?? "This deployment's runner fleet is full.",
      };
    case "rate_limited":
    case "busy":
      return { form: "Too many requests. Try again shortly." };
  }
  if (problem.status === 403 || problem.status === 404)
    return { form: "You can no longer change this, or it no longer exists." };
  if (problem.status === 429) return { form: "Too many requests. Try again shortly." };
  return { form: problem.detail ?? "It was not saved." };
}

/** The access a form sends: `undefined` access when none was chosen. */
export function accessOf(form: FormData): Partial<RunnerAccess> {
  const access = ACCESSES.find((a) => a.value === form.get("repository_access"))?.value;
  return {
    ...(access && { repository_access: access }),
    allows_public: form.get("allows_public") === "on",
    allows_forks: form.get("allows_forks") === "on",
  };
}

/**
 * What a runner's form changes: the fields that differ from those the form
 * was shown with, so a page left open widens nothing it did not change.
 */
export function changesOf(form: FormData): Partial<RunnerAccess> {
  const sent = accessOf(form);
  return {
    ...(sent.repository_access &&
      sent.repository_access !== form.get("was_repository_access") && {
        repository_access: sent.repository_access,
      }),
    ...(sent.allows_public !== (form.get("was_allows_public") === "on") && {
      allows_public: sent.allows_public === true,
    }),
    ...(form.has("was_allows_forks") &&
      sent.allows_forks !== (form.get("was_allows_forks") === "on") && {
        allows_forks: sent.allows_forks === true,
      }),
  };
}

/** Whether `change` lets the runner take jobs it did not before. */
export const widens = (change: Partial<RunnerAccess>): boolean =>
  change.repository_access === "all" ||
  change.allows_public === true ||
  change.allows_forks === true;

/** Repository names typed one a line (or by commas), each once. */
export function namesOf(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).filter((name) => name !== ""))];
}
