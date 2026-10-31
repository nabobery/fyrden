/**
 * Whether a pull request's approvals satisfy its code owners, as GitHub's
 * "require review from Code Owners" asks: every CODEOWNERS rule that
 * decides a changed path and names owners needs an approval from one of
 * them. Ownership is judged per reviewer (two agents of one person are
 * told apart), apart from counting, which stays one vote per person.
 */
import type { ApprovalInput, ApprovalSettings, ReviewFact } from "./approvals.js";

/** An owner a rule names, as the merge found it: qualified (resolved, with write access) or why not. */
export type CodeOwnerFact =
  | {
      readonly kind: "user" | "agent";
      readonly token: string;
      readonly principal: string;
      readonly qualified: true;
    }
  | {
      readonly kind: "team";
      readonly token: string;
      readonly teamId: string;
      readonly qualified: true;
    }
  | {
      readonly kind: "user" | "agent" | "team" | "unknown";
      readonly token: string;
      readonly qualified: false;
      readonly reason: string;
    };

/** A rule that decides at least one changed path and names owners. */
export interface CodeOwnerRequirement {
  /** Its line in the CODEOWNERS file. */
  readonly line: number;
  /** One path it decides, for the refusal. */
  readonly example: string;
  readonly owners: readonly CodeOwnerFact[];
}

/** What a merge knows of its code owners. */
export type CodeOwnersInput =
  /** No CODEOWNERS file at the base tip: nothing is required. */
  | { readonly state: "none" }
  | {
      readonly state: "complete";
      readonly requirements: readonly CodeOwnerRequirement[];
      /** Team memberships of candidates and their root users, as `membershipKey` gives them. */
      readonly memberships: ReadonlySet<string>;
      /**
       * Whose memberships were read: a candidate (or the user an agent is
       * rooted in) outside it may be a member, so a rule that would need
       * it cannot be judged.
       */
      readonly asked: ReadonlySet<string>;
    }
  /** Not worked out (pending, too large, unreadable, file errors, unmatchable paths): the reason. */
  | { readonly state: "refused"; readonly reason: string };

/** A reviewer whose own latest review approves under a rule's settings. */
export interface OwnershipCandidate {
  readonly principal: string;
  readonly root: string;
  readonly byAgent: boolean;
}

/** The facts a code-owner decision rested on, for the merge's confirmation. */
export interface CodeOwnerClaims {
  readonly principals: ReadonlySet<string>;
  readonly teams: ReadonlySet<string>;
  /** As `membershipKey` gives them. */
  readonly pairs: ReadonlySet<string>;
}

/** Rules a refusal names at most. */
const RULES_SHOWN = 10;

export function membershipKey(teamId: string, principal: string): string {
  return `${teamId} ${principal}`;
}

/**
 * Each reviewer's own latest review that counts under `settings` (not a
 * comment nor dismissed, not stale when stale ones are dismissed, not the
 * author's, an agent's only when agents' approvals count), when it
 * approves and its reviewer is active with write access itself.
 */
export function ownershipCandidates(
  input: ApprovalInput,
  settings: ApprovalSettings,
): OwnershipCandidate[] {
  const latest = new Map<string, ReviewFact>();
  for (const review of input.reviews) {
    if (review.dismissed || review.state === "COMMENTED") continue;
    if (settings.dismissStale && review.commitSha !== input.headSha) continue;
    if (review.reviewerRoot === input.authorRoot) continue;
    if (review.byAgent && !settings.allowAgentApprovals) continue;
    const current = latest.get(review.reviewerId);
    if (!current || review.seq > current.seq) latest.set(review.reviewerId, review);
  }
  return [...latest.values()]
    .filter((r) => r.state === "APPROVED" && r.active && input.eligiblePrincipals.has(r.reviewerId))
    .map((r) => ({ principal: r.reviewerId, root: r.reviewerRoot, byAgent: r.byAgent }));
}

/** The owners of a rule that can approve under `settings`, and why the others cannot. */
function qualifiedOwners(requirement: CodeOwnerRequirement, settings: ApprovalSettings) {
  const qualified: Exclude<CodeOwnerFact, { qualified: false }>[] = [];
  const reasons: string[] = [];
  for (const owner of requirement.owners)
    if (!owner.qualified) reasons.push(`${owner.token}: ${owner.reason}`);
    else if (owner.kind === "agent" && !settings.allowAgentApprovals)
      reasons.push(`${owner.token}: agents' approvals do not count`);
    else qualified.push(owner);
  return { qualified, reasons };
}

/**
 * Every way `candidate` satisfies `owner`, each with the facts it rests on
 * (none when it does not): for a team, the candidate's own membership and,
 * for an agent, its user's, each its own claim, so a confirmation asks
 * about every membership a recheck could fall back on.
 */
function satisfactions(
  owner: Exclude<CodeOwnerFact, { qualified: false }>,
  candidate: OwnershipCandidate,
  memberships: ReadonlySet<string>,
): { principals: string[]; team?: string; pair?: string }[] {
  switch (owner.kind) {
    case "user":
      if (candidate.principal === owner.principal) return [{ principals: [candidate.principal] }];
      // One of the user's agents (rooted in them): only agents' approvals that count are candidates.
      if (candidate.byAgent && candidate.root === owner.principal)
        return [{ principals: [candidate.principal, owner.principal] }];
      return [];
    case "agent":
      return candidate.principal === owner.principal ? [{ principals: [candidate.principal] }] : [];
    case "team": {
      const found: { principals: string[]; team: string; pair: string }[] = [];
      const own = membershipKey(owner.teamId, candidate.principal);
      if (memberships.has(own))
        found.push({ principals: [candidate.principal], team: owner.teamId, pair: own });
      const rooted = membershipKey(owner.teamId, candidate.root);
      if (candidate.byAgent && candidate.root !== candidate.principal && memberships.has(rooted))
        found.push({
          principals: [candidate.principal, candidate.root],
          team: owner.teamId,
          pair: rooted,
        });
      return found;
    }
  }
}

/** Each requirement's outcome under `settings`: satisfied (and by what), or why not. */
function judge(
  input: ApprovalInput,
  owners: CodeOwnersInput & { state: "complete" },
  settings: ApprovalSettings,
) {
  const candidates = ownershipCandidates(input, settings);
  // Candidates whose memberships were not read: a team owner may be theirs.
  const unread = candidates.some(
    (c) => !owners.asked.has(c.principal) || (c.byAgent && !owners.asked.has(c.root)),
  );
  return owners.requirements.map((requirement) => {
    const { qualified, reasons } = qualifiedOwners(requirement, settings);
    const by = qualified.flatMap((owner) =>
      candidates.flatMap((candidate) => satisfactions(owner, candidate, owners.memberships)),
    );
    const unknown = unread && qualified.some((o) => o.kind === "team");
    return { requirement, qualified, reasons, by, unknown };
  });
}

/** Why the approvals do not satisfy the code owners under `settings`; undefined when they do. */
export function codeOwnerRefusal(
  input: ApprovalInput,
  owners: CodeOwnersInput | undefined,
  settings: ApprovalSettings,
): string | undefined {
  if (!owners) return "code owners could not be worked out for this merge";
  if (owners.state === "refused") return owners.reason;
  if (owners.state === "none") return undefined;
  const unqualified: string[] = [];
  const waiting: string[] = [];
  for (const { requirement, qualified, reasons, by, unknown } of judge(input, owners, settings)) {
    const where = `line ${requirement.line} (${requirement.example}`;
    if (qualified.length === 0)
      unqualified.push(`${where}): no qualifying owner (${reasons.join("; ")})`);
    else if (by.length === 0) {
      if (unknown) return "code owners could not be worked out for this merge";
      waiting.push(`${where}: ${qualified.map((o) => o.token).join(", ")})`);
    }
  }
  const shown = (items: string[]) =>
    items.slice(0, RULES_SHOWN).join(", ") +
    (items.length > RULES_SHOWN ? ` and ${items.length - RULES_SHOWN} more` : "");
  const parts = [
    ...(unqualified.length > 0 ? [shown(unqualified)] : []),
    ...(waiting.length > 0 ? [`code owners must approve: ${shown(waiting)}`] : []),
  ];
  return parts.length === 0 ? undefined : parts.join("; ");
}

/** The principals, teams and memberships by which the requirements are satisfied under `settings`. */
export function codeOwnerClaims(
  input: ApprovalInput,
  owners: CodeOwnersInput | undefined,
  settings: ApprovalSettings,
): CodeOwnerClaims {
  const principals = new Set<string>();
  const teams = new Set<string>();
  const pairs = new Set<string>();
  if (owners?.state === "complete")
    for (const { by } of judge(input, owners, settings))
      for (const claim of by) {
        for (const p of claim.principals) principals.add(p);
        if (claim.team) teams.add(claim.team);
        if (claim.pair) pairs.add(claim.pair);
      }
  return { principals, teams, pairs };
}

/**
 * `owners` as they are once `lost` no longer holds: an owner principal or
 * team without write access is no longer qualified, a membership gone no
 * longer satisfies.
 */
export function codeOwnersWithout(
  owners: CodeOwnersInput | undefined,
  lost: CodeOwnerClaims,
): CodeOwnersInput | undefined {
  if (owners?.state !== "complete") return owners;
  const unqualified = (owner: CodeOwnerFact): CodeOwnerFact =>
    owner.qualified &&
    (owner.kind === "team" ? lost.teams.has(owner.teamId) : lost.principals.has(owner.principal))
      ? { kind: owner.kind, token: owner.token, qualified: false, reason: "no write access" }
      : owner;
  return {
    state: "complete",
    requirements: owners.requirements.map((r) => ({ ...r, owners: r.owners.map(unqualified) })),
    memberships: new Set([...owners.memberships].filter((m) => !lost.pairs.has(m))),
    asked: owners.asked,
  };
}
