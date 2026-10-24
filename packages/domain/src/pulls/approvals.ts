/**
 * Whether a pull request's reviews meet a ruleset's review requirements,
 * as GitHub counts them: one vote per person (root identity), their latest
 * review (in submission order) that is not a comment and not dismissed; the author never counts;
 * an eligible request for changes blocks until that person approves or it
 * is dismissed. Three settings stay separate: how many approvals, whether a
 * push makes earlier reviews stale, and whether someone other than the
 * last pusher must approve the head after the last push.
 */

export const REVIEW_STATES = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/** One submitted review, as the merge check sees it. */
export interface ReviewFact {
  /** Who submitted it: a user, or an agent (its own token, or acting for a person). */
  readonly reviewerId: string;
  /** The root identity of whoever submitted it (a person's own agents share it). */
  readonly reviewerRoot: string;
  /**
   * Whether its reviewer (and, for an agent, the agent's owner) is still
   * active: a review by one disabled since counts for no one.
   */
  readonly active: boolean;
  /** Submitted by an agent (its own token, or acting for a person). */
  readonly byAgent: boolean;
  /** The head commit it reviewed. */
  readonly commitSha: string;
  readonly state: ReviewState;
  /** When it was submitted, on the same clock as `lastPush.at`. */
  readonly submittedAt: number;
  /**
   * Its place in the order reviews were submitted, larger for later (the
   * review's id): a person's latest review is the one with the largest,
   * even at the same moment, however the reviews are listed.
   */
  readonly seq: number;
  readonly dismissed: boolean;
}

export interface ApprovalInput {
  readonly reviews: readonly ReviewFact[];
  /** The head commit that would be merged. */
  readonly headSha: string;
  readonly authorRoot: string;
  /**
   * The latest push to the head (opening counts as one); null when unknown,
   * which no approval can be shown to come after.
   */
  readonly lastPush: { readonly pusherRoot: string; readonly at: number } | null;
  /** Roots whose reviews count: write access or above, checked when merging. */
  readonly eligibleRoots: ReadonlySet<string>;
  /**
   * Reviewers (principals) with write access themselves, an agent capped by
   * its owner: whose reviews can make them code owners' approvers.
   */
  readonly eligiblePrincipals: ReadonlySet<string>;
}

export interface ApprovalSettings {
  /** Approvals needed, 0-10. */
  readonly required: number;
  /** A review of an earlier head no longer counts (approvals and requests for changes alike). */
  readonly dismissStale: boolean;
  /** Someone other than the last pusher must approve the head after the last push. */
  readonly requireLastPushApproval: boolean;
  /** Reviews submitted by agents count; by default only people's do. */
  readonly allowAgentApprovals: boolean;
}

export interface ApprovalOutcome {
  /** Distinct roots whose standing review approves. */
  readonly approvals: number;
  /** Those roots, sorted: whose access a merge's confirmation asks about. */
  readonly approvers: readonly string[];
  /** Roots whose standing review requests changes. */
  readonly changesRequested: readonly string[];
  /**
   * Whether someone other than the last pusher approved the head itself
   * after that push (false when the push is unknown): an approval of an
   * earlier head, however late, never reviewed what the push brought.
   */
  readonly lastPushApproved: boolean;
  readonly satisfied: boolean;
  /** Why it is not satisfied, for the refusal; empty when it is. */
  readonly reasons: readonly string[];
}

export function evaluateApprovals(
  input: ApprovalInput,
  settings: ApprovalSettings,
): ApprovalOutcome {
  // Each root's standing review: the last submitted that counts, so the order
  // reviews are listed in never matters.
  const standing = new Map<string, ReviewFact>();
  for (const review of input.reviews) {
    if (review.dismissed || review.state === "COMMENTED") continue;
    if (settings.dismissStale && review.commitSha !== input.headSha) continue;
    if (review.reviewerRoot === input.authorRoot) continue;
    if (!input.eligibleRoots.has(review.reviewerRoot)) continue;
    if (review.byAgent && !settings.allowAgentApprovals) continue;
    const current = standing.get(review.reviewerRoot);
    if (!current || review.seq > current.seq) standing.set(review.reviewerRoot, review);
  }
  // A root whose standing review is by a reviewer disabled since has none: its earlier review
  // does not stand in.
  for (const [root, review] of standing) if (!review.active) standing.delete(root);
  const approving = [...standing.values()].filter((r) => r.state === "APPROVED");
  const changesRequested = [...standing.values()]
    .filter((r) => r.state === "CHANGES_REQUESTED")
    .map((r) => r.reviewerRoot)
    .sort();
  const push = input.lastPush;
  const lastPushApproved =
    push !== null &&
    approving.some(
      (r) =>
        r.commitSha === input.headSha &&
        r.submittedAt > push.at &&
        r.reviewerRoot !== push.pusherRoot,
    );
  const reasons: string[] = [];
  if (approving.length < settings.required)
    reasons.push(
      `${settings.required} approving review${settings.required === 1 ? " is" : "s are"} required (${approving.length} given)`,
    );
  if (changesRequested.length > 0) reasons.push("changes were requested");
  if (settings.requireLastPushApproval && !lastPushApproved)
    reasons.push("the last push must be approved by someone other than its pusher");
  return {
    approvals: approving.length,
    approvers: approving.map((r) => r.reviewerRoot).sort(),
    changesRequested,
    lastPushApproved,
    satisfied: reasons.length === 0,
    reasons,
  };
}
