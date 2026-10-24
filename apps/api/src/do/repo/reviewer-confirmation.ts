import { atLeast, isId, REPO_ROLES, type RepoRole } from "@fyrden/domain";
import {
  type ApprovalConfirmation,
  AUTHORIZATION_UNAVAILABLE,
  type ConfirmationNeeds,
  type PushLogMeta,
} from "../../git/push/repo-push.js";
import { MAX_CONFIRMED_PRINCIPALS, type RoleConfirmation } from "../OrgDO.js";
import type { RepoAccount, RepoAcl } from "./acl.js";
import type { MergeStanding } from "./pull-discussion.js";

/*
 * A merge's confirmation of its reviewers: at every merge finalization of
 * an organization's repository, the roots whose approvals the rules count
 * and the principals, teams and memberships its code owners' approvals
 * rest on (principals with the owners capping them) are confirmed by the
 * organization's object in one linearized read, the commit's last await.
 * The repository's ACL snapshot may be a minute old, its invalidation still
 * on its way; the confirmation is not. In the commit's transaction, the
 * answer must still bind the repository (same ownership, not older than
 * what it has seen), and the rules are judged again without what it found
 * no longer holds.
 */

/** Proposed. */
export const MERGE_CONFIRM_POLICY = {
  /** Reviewers' roots one merge confirms at most; past it the merge is refused. */
  maxReviewers: 512,
  /** Principals one merge's confirmation reads at most (the organization's own limit). */
  maxPrincipals: MAX_CONFIRMED_PRINCIPALS,
};

export type MergeConfirmPolicy = typeof MERGE_CONFIRM_POLICY;

export interface ReviewerConfirmationDeps {
  readonly acl: () => RepoAcl;
  readonly account: () => RepoAccount | undefined;
  readonly confirmRoles: (
    accountId: string,
    principals: readonly string[],
    teams: readonly string[],
    pairs: readonly string[],
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
   * Why a merge judged by `standing` is refused before anything is stored:
   * more than its confirmation could read (its eligible reviewers' roots,
   * which counting may confirm; or, with an enforced code-owner
   * requirement, those and its ownership candidates and their users, with
   * the owners capping each); undefined when it fits. Counted wide, before
   * the rules say which of them they rely on; never from reviewers nothing
   * enforced would ask about.
   */
  tooMany(standing: MergeStanding): { code: string; error: string } | undefined {
    if (!confirmsReviewers(this.deps.account())) return undefined;
    const { approvals } = standing.merge;
    if (approvals.eligibleRoots.size > this.deps.policy().maxReviewers)
      return {
        code: "too_many_reviewers",
        error: "The pull request has more reviewers with write access than a merge here confirms.",
      };
    if (standing.ownerCandidates.length === 0) return undefined;
    const principals = new Set([...approvals.eligibleRoots, ...standing.ownerCandidates]);
    for (const p of [...principals])
      for (const c of standing.ceilings.get(p) ?? []) principals.add(c);
    return principals.size > this.deps.policy().maxPrincipals
      ? {
          code: "code_owners_too_large",
          error:
            "The pull request's reviewers and code owners are more than a merge here confirms.",
        }
      : undefined;
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
    return async (needs) => {
      const account = deps.account();
      if (!sameOwnership(judged, account))
        throw new Error("the repository changed hands while it was merged");
      if (!confirmsReviewers(account))
        return {
          // No teams: its approvals stand on its snapshot, while it stays in the same hands.
          lost: () =>
            sameOwnership(judged, deps.account()) ? NOTHING_LOST : AUTHORIZATION_UNAVAILABLE,
          settle: () => {},
        };
      if (needs.roots.length > deps.policy().maxReviewers)
        throw new Error(`more than ${deps.policy().maxReviewers} reviewers to confirm`);
      const asked = [...needs.roots, ...needs.principals];
      const principals = [...new Set(asked.flatMap((p) => [p, ...(ceilings.get(p) ?? [])]))];
      const answer = await deps.confirmRoles(
        account.accountId,
        principals,
        needs.teams,
        needs.pairs,
      );
      return confirmation(deps, account, needs, ceilings, answer);
    };
  }
}

const NOTHING_LOST = {
  principals: new Set<string>(),
  teams: new Set<string>(),
  pairs: new Set<string>(),
};

/** Whether `a` and `b` are the same ownership (account and owner generation), or both none. */
function sameOwnership(a: RepoAccount | undefined, b: RepoAccount | undefined): boolean {
  return a === undefined || b === undefined
    ? a === b
    : a.accountId === b.accountId && a.ownerGen === b.ownerGen;
}

function confirmation(
  deps: ReviewerConfirmationDeps,
  account: RepoAccount,
  needs: ConfirmationNeeds,
  ceilings: ReadonlyMap<string, readonly string[]>,
  answer: RoleConfirmation,
): ApprovalConfirmation {
  const { accountId } = account;
  const roleOf = (principal: string): RepoRole | null =>
    // The account itself (an agent's owner) administers its repositories.
    principal === accountId ? "admin" : (answer.roles[principal] ?? null);
  // As `RepoAuthority.roleNow`: the weakest of a principal's own role and its ceilings'.
  const effective = (principal: string): RepoRole | null => {
    let role = roleOf(principal);
    for (const id of ceilings.get(principal) ?? []) {
      const cap = roleOf(id);
      if (cap === null || (role !== null && REPO_ROLES.indexOf(cap) < REPO_ROLES.indexOf(role)))
        role = cap;
    }
    return role;
  };
  const members = new Set(answer.members);
  return {
    lost: () => {
      if (
        !sameOwnership(account, deps.account()) ||
        answer.accountId !== accountId ||
        deps.acl().isBelowFloor(accountId, answer.epochGen, answer.version)
      )
        return AUTHORIZATION_UNAVAILABLE;
      return {
        principals: new Set(
          [...needs.roots, ...needs.principals].filter((p) => !atLeast(effective(p), "write")),
        ),
        teams: new Set(needs.teams.filter((t) => !atLeast(answer.teamRoles[t] ?? null, "write"))),
        pairs: new Set(needs.pairs.filter((pair) => !members.has(pair))),
      };
    },
    settle: () => deps.acl().invalidate(accountId, answer.epochGen, answer.version),
  };
}
