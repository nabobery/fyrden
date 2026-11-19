/*
 * What a run's origin allows: whether it is a fork job, whether its code is
 * trusted, whether it waits for a maintainer's approval, what that approval
 * binds, and the token scope each job gets.
 */
import { atLeast, type RepoRole } from "../authz/roles.js";
import {
  PERMISSION_SCOPES,
  type PermissionScope,
  type Permissions,
  type Trigger,
} from "./workflow-schema.js";

type TriggerKind = Trigger["event"];
export type RunTrust = "trusted" | "untrusted";

/**
 * Whether a pull request's head lives in another repository, private forks
 * included. A same-repository pull request stores no head repository.
 */
export function isForkJob(baseRepoId: string, headRepoId: string | null): boolean {
  return headRepoId !== null && headRepoId !== baseRepoId;
}

/**
 * Only a `pull_request` from a fork runs untrusted code. A
 * `pull_request_target` runs the default branch's workflow with the base's
 * privileges, so it is trusted even from a fork (and is still a fork job).
 */
export function runTrust(kind: TriggerKind, fork: boolean): RunTrust {
  return kind === "pull_request" && fork ? "untrusted" : "trusted";
}

/** A principal's standing in the repository; the caller resolves an agent to its owner. */
export interface ContributorStanding {
  readonly role: RepoRole | null;
  /** Whether a pull request they authored was merged into this repository. */
  readonly hasMergedPull: boolean;
}

/**
 * GitHub's "Require approval for first-time contributors" (verified
 * 2026-11-15, https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository):
 * a pull request run from a fork waits when its author or the event's actor
 * has neither write access nor a merged pull request here. Commits merged
 * outside a pull request do not count.
 */
export function needsApproval(input: {
  readonly kind: TriggerKind;
  readonly fork: boolean;
  readonly author: ContributorStanding;
  readonly actor: ContributorStanding;
}): boolean {
  if (input.kind !== "pull_request" && input.kind !== "pull_request_target") return false;
  return input.fork && (!trustedHere(input.author) || !trustedHere(input.actor));
}

function trustedHere(s: ContributorStanding): boolean {
  return atLeast(s.role, "write") || s.hasMergedPull;
}

/** Everything an approval covers; a run's attempts all share it. */
export interface ApprovalBinding {
  readonly runId: string;
  readonly workflowPath: string;
  /** The workflow file's blob id; with `trust` it fixes every job's token scope. */
  readonly workflowBlob: string;
  readonly checkoutSha: string;
  readonly event: string;
  readonly action: string;
  readonly kind: TriggerKind;
  readonly trust: RunTrust;
  readonly fork: boolean;
}

/**
 * The canonical text of a binding, which both sides hash. A JSON array in
 * a fixed order: JSON's string escaping keeps every field's boundaries, so
 * no two bindings share a text. The attempt is always 1, as an approval
 * covers the run's re-runs too.
 */
export function approvalBindingText(b: ApprovalBinding): string {
  return JSON.stringify([
    "fyrden.approval.v1",
    b.runId,
    1,
    b.workflowPath,
    b.workflowBlob,
    b.checkoutSha,
    b.event,
    b.action,
    b.kind,
    b.trust,
    b.fork,
  ]);
}

/** A scope a job token is issued with. */
export type TokenScope = "contents:read" | "metadata:read";

type Access = "none" | "read" | "write";
const RANK: Record<Access, number> = { none: 0, read: 1, write: 2 };

/** What Fyrden can issue today, per scope: git read only. */
const CAPABILITY: Readonly<Record<PermissionScope, Access>> = {
  actions: "none",
  checks: "none",
  contents: "read",
  issues: "none",
  "pull-requests": "none",
  statuses: "none",
};

/** Fyrden's scopes when neither the workflow nor the job declares `permissions:`. */
const DEFAULT_PERMISSIONS: Readonly<Partial<Record<PermissionScope, Access>>> = {
  contents: "read",
};

/**
 * The token scopes of one job. The job's `permissions:` replace the
 * workflow's, which replace the default (GitHub, verified 2026-11-15,
 * https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#how-permissions-are-calculated-for-a-workflow-job);
 * an unlisted scope is none. Each scope is then capped at read for an
 * untrusted run (GitHub: read-only in pull requests from forks, events page)
 * and at what Fyrden can issue. `metadata:read` comes with any issued scope,
 * as GitHub grants metadata read to every repository token (unverified for
 * `GITHUB_TOKEN`); `permissions: {}` issues nothing at all.
 */
export function effectiveScope(input: {
  readonly workflowPermissions?: Permissions | undefined;
  readonly jobPermissions?: Permissions | undefined;
  readonly trust: RunTrust;
}): TokenScope[] {
  const declared = input.jobPermissions ?? input.workflowPermissions;
  const ceiling: Access = input.trust === "untrusted" ? "read" : "write";
  const issued: TokenScope[] = [];
  for (const scope of PERMISSION_SCOPES) {
    const access = min(min(requested(declared, scope), ceiling), CAPABILITY[scope]);
    if (access !== "none") issued.push(`${scope}:${access}` as TokenScope);
  }
  if (issued.length > 0) issued.push("metadata:read");
  return issued;
}

function requested(p: Permissions | undefined, scope: PermissionScope): Access {
  if (p === undefined) return DEFAULT_PERMISSIONS[scope] ?? "none";
  if (p.kind === "all") return p.access;
  return p.scopes.find((s) => s.scope === scope)?.access ?? "none";
}

function min(a: Access, b: Access): Access {
  return RANK[a] <= RANK[b] ? a : b;
}
