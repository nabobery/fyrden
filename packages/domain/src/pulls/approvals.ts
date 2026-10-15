/**
 * Whether a pull request's reviews meet a ruleset's review requirements,
 * as GitHub counts them: one vote per person (root identity), their latest
 * review that is not a comment and not dismissed; the author never counts;
 * an eligible request for changes blocks until that person approves or it
 * is dismissed. Three settings stay separate: how many approvals, whether a
 * push makes earlier reviews stale, and whether someone other than the
 * last pusher must approve after the last push.
 */

export const REVIEW_STATES = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/** One submitted review, as the merge check sees it. */
export interface ReviewFact {
  /** The root identity of whoever submitted it (a person's own agents share it). */
  readonly reviewerRoot: string;
  /** Submitted by an agent (its own token, or acting for a person). */
  readonly byAgent: boolean;
  /** The head commit it reviewed. */
  readonly commitSha: string;
  readonly state: ReviewState;
  /**
   * When it was submitted, on the same clock as `lastPush.at`. Two reviews
   * of one person at the same moment resolve the cautious way: a request
   * for changes stands over an approval.
   */
  readonly submittedAt: number;
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
}

export interface ApprovalSettings {
  /** Approvals needed, 0-10. */
  readonly required: number;
  /** A review of an earlier head no longer counts (approvals and requests for changes alike). */
  readonly dismissStale: boolean;
  /** Someone other than the last pusher must approve after the last push. */
  readonly requireLastPushApproval: boolean;
  /** Reviews submitted by agents count; by default only people's do. */
  readonly allowAgentApprovals: boolean;
}

export interface ApprovalOutcome {
  /** Distinct roots whose standing review approves. */
  readonly approvals: number;
  /** Roots whose standing review requests changes. */
  readonly changesRequested: readonly string[];
  /** Whether an approval after the last push came from someone other than its pusher (false when the push is unknown). */
  readonly lastPushApproved: boolean;
  readonly satisfied: boolean;
  /** Why it is not satisfied, for the refusal; empty when it is. */
  readonly reasons: readonly string[];
}

export function evaluateApprovals(
  input: ApprovalInput,
  settings: ApprovalSettings,
): ApprovalOutcome {
  // Each root's standing review: the latest that counts; at the same moment,
  // a request for changes, so the order reviews are listed in never matters.
  const standing = new Map<string, ReviewFact>();
  for (const review of input.reviews) {
    if (review.dismissed || review.state === "COMMENTED") continue;
    if (settings.dismissStale && review.commitSha !== input.headSha) continue;
    if (review.reviewerRoot === input.authorRoot) continue;
    if (!input.eligibleRoots.has(review.reviewerRoot)) continue;
    if (review.byAgent && !settings.allowAgentApprovals) continue;
    const current = standing.get(review.reviewerRoot);
    if (
      !current ||
      review.submittedAt > current.submittedAt ||
      (review.submittedAt === current.submittedAt && review.state === "CHANGES_REQUESTED")
    )
      standing.set(review.reviewerRoot, review);
  }
  const approving = [...standing.values()].filter((r) => r.state === "APPROVED");
  const changesRequested = [...standing.values()]
    .filter((r) => r.state === "CHANGES_REQUESTED")
    .map((r) => r.reviewerRoot)
    .sort();
  const push = input.lastPush;
  const lastPushApproved =
    push !== null &&
    approving.some((r) => r.submittedAt > push.at && r.reviewerRoot !== push.pusherRoot);
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
    changesRequested,
    lastPushApproved,
    satisfied: reasons.length === 0,
    reasons,
  };
}
