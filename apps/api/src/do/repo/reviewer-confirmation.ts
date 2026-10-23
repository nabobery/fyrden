import { atLeast, isId, REPO_ROLES, type RepoRole } from "@fyrden/domain";
import {
  type ApprovalConfirmation,
  AUTHORIZATION_UNAVAILABLE,
  type PushLogMeta,
} from "../../git/push/repo-push.js";
import type { RoleConfirmation } from "../OrgDO.js";
import type { RepoAccount, RepoAcl } from "./acl.js";

/*
 * A merge's confirmation of its reviewers: at every merge finalization of
 * an organization's repository, the roots whose approvals the rules count
 * (with the owners capping them) are confirmed by the organization's
 * object in one linearized read, the commit's last await. The repository's
 * ACL snapshot may be a minute old, its invalidation still on its way; the
 * confirmation is not. In the commit's transaction, the answer must still
 * bind the repository (same ownership, not older than what it has seen),
 * and the rules are judged again with the roots it confirms.
 */

/** Proposed. */
export const MERGE_CONFIRM_POLICY = {
  /** Reviewers' roots one merge confirms at most; past it the merge is refused. */
  maxReviewers: 512,
};

export type MergeConfirmPolicy = typeof MERGE_CONFIRM_POLICY;

export interface ReviewerConfirmationDeps {
  readonly acl: () => RepoAcl;
  readonly account: () => RepoAccount | undefined;
  readonly confirmRoles: (
    accountId: string,
    principals: readonly string[],
  ) => Promise<RoleConfirmation>;
  readonly policy: () => MergeConfirmPolicy;
}

/** Whether the repository's merges confirm their reviewers: an organization's (a user's has no teams). */
function confirmsReviewers(account: RepoAccount | undefined): account is RepoAccount {
  return account !== undefined && isId(account.accountId, "org");
}

export class ReviewerConfirmations {
  constructor(private readonly deps: ReviewerConfirmationDeps) {}

  /**
   * Whether a merge with `reviewers` eligible reviewers' roots is refused
   * before anything is stored: more than one confirmation reads.
   */
  tooMany(reviewers: number): boolean {
    return confirmsReviewers(this.deps.account()) && reviewers > this.deps.policy().maxReviewers;
  }

  /**
   * The confirmation of a merge whose reviewers' roots are capped by
   * `ceilings` (root → the owners capping it: an agent's owner). Whether
   * the repository is an organization's is decided when it runs, right
   * before the commit: a change of hands since the merge was judged (now)
   * refuses it, and a user's repository asks nothing.
   */
  for(ceilings: ReadonlyMap<string, readonly string[]>): NonNullable<PushLogMeta["confirm"]> {
    const { deps } = this;
    const judged = deps.account();
    return async (approvers) => {
      const account = deps.account();
      if (!sameOwnership(judged, account))
        throw new Error("the repository changed hands while it was merged");
      if (!confirmsReviewers(account))
        return {
          // No teams: its approvals stand on its snapshot, while it stays in the same hands.
          revoked: () =>
            sameOwnership(judged, deps.account()) ? new Set() : AUTHORIZATION_UNAVAILABLE,
          settle: () => {},
        };
      if (approvers.length > deps.policy().maxReviewers)
        throw new Error(`more than ${deps.policy().maxReviewers} reviewers to confirm`);
      const principals = [...new Set(approvers.flatMap((r) => [r, ...(ceilings.get(r) ?? [])]))];
      const answer = await deps.confirmRoles(account.accountId, principals);
      return confirmation(deps, account, approvers, ceilings, answer);
    };
  }
}

/** Whether `a` and `b` are the same ownership (account and owner generation), or both none. */
function sameOwnership(a: RepoAccount | undefined, b: RepoAccount | undefined): boolean {
  return a === undefined || b === undefined
    ? a === b
    : a.accountId === b.accountId && a.ownerGen === b.ownerGen;
}

function confirmation(
  deps: ReviewerConfirmationDeps,
  account: RepoAccount,
  approvers: readonly string[],
  ceilings: ReadonlyMap<string, readonly string[]>,
  answer: RoleConfirmation,
): ApprovalConfirmation {
  const { accountId } = account;
  const roleOf = (principal: string): RepoRole | null =>
    // The account itself (an agent's owner) administers its repositories.
    principal === accountId ? "admin" : (answer.roles[principal] ?? null);
  // As `RepoAuthority.roleNow`: the weakest of a root's own role and its ceilings'.
  const effective = (root: string): RepoRole | null => {
    let role = roleOf(root);
    for (const id of ceilings.get(root) ?? []) {
      const cap = roleOf(id);
      if (cap === null || (role !== null && REPO_ROLES.indexOf(cap) < REPO_ROLES.indexOf(role)))
        role = cap;
    }
    return role;
  };
  return {
    revoked: () => {
      if (
        !sameOwnership(account, deps.account()) ||
        answer.accountId !== accountId ||
        deps.acl().isBelowFloor(accountId, answer.epochGen, answer.version)
      )
        return AUTHORIZATION_UNAVAILABLE;
      return new Set(approvers.filter((root) => !atLeast(effective(root), "write")));
    },
    settle: () => deps.acl().invalidate(accountId, answer.epochGen, answer.version),
  };
}
