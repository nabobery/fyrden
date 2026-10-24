import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type ApprovalInput,
  type ApprovalSettings,
  evaluateApprovals,
  REVIEW_STATES,
  type ReviewFact,
} from "../../src/pulls/approvals.js";

const HEAD = "h".repeat(40);
const OLD = "o".repeat(40);
const settings = (over: Partial<ApprovalSettings> = {}): ApprovalSettings => ({
  required: 1,
  dismissStale: false,
  requireLastPushApproval: false,
  allowAgentApprovals: false,
  ...over,
});
const input = (reviews: ReviewFact[], over: Partial<ApprovalInput> = {}): ApprovalInput => ({
  reviews,
  headSha: HEAD,
  authorRoot: "author",
  lastPush: { pusherRoot: "author", at: 0 },
  eligibleRoots: new Set(["author", "alice", "bob", "carol"]),
  eligiblePrincipals: new Set(["author", "alice", "bob", "carol"]),
  ...over,
});
let clock = 0;
const review = (
  reviewerRoot: string,
  state: ReviewFact["state"],
  over: Partial<ReviewFact> = {},
) => ({
  reviewerRoot,
  reviewerId: reviewerRoot,
  active: true,
  byAgent: false,
  commitSha: HEAD,
  state,
  submittedAt: ++clock,
  // Submitted in the order made here, whatever time a test gives it.
  seq: clock,
  dismissed: false,
  ...over,
});

describe("evaluateApprovals", () => {
  it("counts one approval per person and never the author's", () => {
    const outcome = evaluateApprovals(
      input([
        review("author", "APPROVED"),
        review("alice", "APPROVED"),
        review("alice", "APPROVED"),
      ]),
      settings({ required: 2 }),
    );
    expect(outcome).toMatchObject({ approvals: 1, satisfied: false });
    expect(outcome.reasons).toEqual(["2 approving reviews are required (1 given)"]);
  });

  it("names the people whose approvals it counts, sorted, and only them", () => {
    const outcome = evaluateApprovals(
      input(
        [
          review("author", "APPROVED"),
          review("carol", "APPROVED", { commitSha: OLD }),
          review("dave", "APPROVED"),
          review("bob", "APPROVED", { byAgent: true }),
          review("eve", "APPROVED"),
          review("eve", "CHANGES_REQUESTED"),
          review("alice", "APPROVED"),
          review("frank", "APPROVED"),
        ],
        { eligibleRoots: new Set(["author", "alice", "bob", "carol", "eve", "frank"]) },
      ),
      settings({ dismissStale: true }),
    );
    // Not the author's, a stale one, one without write access, an agent's, nor one replaced.
    expect(outcome.approvers).toEqual(["alice", "frank"]);
    expect(outcome.approvals).toBe(2);
  });

  it("counts no root whose standing review is by a reviewer since disabled, not even its earlier one", () => {
    const outcome = evaluateApprovals(
      input([
        review("alice", "APPROVED"),
        // Alice's agent approves later, then is disabled: her earlier approval does not stand in.
        review("alice", "APPROVED", { reviewerId: "agt_a", byAgent: true, active: false }),
        review("bob", "APPROVED"),
      ]),
      settings({ allowAgentApprovals: true }),
    );
    expect(outcome.approvers).toEqual(["bob"]);
    // Agents' approvals not counted: the agent's review is passed over, alice's own stands.
    const people = evaluateApprovals(
      input([
        review("alice", "APPROVED"),
        review("alice", "APPROVED", { reviewerId: "agt_a", byAgent: true, active: false }),
      ]),
      settings(),
    );
    expect(people.approvers).toEqual(["alice"]);
  });

  it("takes each person's latest review: approve then request changes blocks, and back again", () => {
    const blocked = evaluateApprovals(
      input([
        review("alice", "APPROVED"),
        review("bob", "APPROVED"),
        review("alice", "CHANGES_REQUESTED"),
      ]),
      settings(),
    );
    expect(blocked).toMatchObject({ approvals: 1, changesRequested: ["alice"], satisfied: false });
    const cleared = evaluateApprovals(
      input([
        review("alice", "CHANGES_REQUESTED"),
        review("alice", "COMMENTED"),
        review("alice", "APPROVED"),
      ]),
      settings(),
    );
    expect(cleared).toMatchObject({ approvals: 1, changesRequested: [], satisfied: true });
  });

  it("drops dismissed reviews, and reviews of an earlier head when stale reviews are dismissed", () => {
    const reviews = [
      review("alice", "CHANGES_REQUESTED", { dismissed: true }),
      review("bob", "APPROVED", { commitSha: OLD }),
      review("carol", "CHANGES_REQUESTED", { commitSha: OLD }),
    ];
    expect(evaluateApprovals(input(reviews), settings())).toMatchObject({
      approvals: 1,
      changesRequested: ["carol"],
    });
    expect(evaluateApprovals(input(reviews), settings({ dismissStale: true }))).toMatchObject({
      approvals: 0,
      changesRequested: [],
    });
  });

  it("ignores reviewers who lost write access", () => {
    const reviews = [review("alice", "APPROVED"), review("bob", "CHANGES_REQUESTED")];
    const outcome = evaluateApprovals(
      input(reviews, { eligibleRoots: new Set(["carol"]) }),
      settings(),
    );
    expect(outcome).toMatchObject({ approvals: 0, changesRequested: [] });
  });

  it("counts agents only when the ruleset allows it, and a person's agents as that person", () => {
    const reviews = [
      review("alice", "APPROVED", { byAgent: true }),
      review("alice", "APPROVED", { byAgent: true }),
      review("bob", "APPROVED"),
    ];
    expect(evaluateApprovals(input(reviews), settings({ required: 2 })).approvals).toBe(1);
    expect(
      evaluateApprovals(input(reviews), settings({ required: 2, allowAgentApprovals: true })),
    ).toMatchObject({ approvals: 2, satisfied: true });
    // The author's own agent approving is still the author.
    const own = [review("author", "APPROVED", { byAgent: true })];
    expect(evaluateApprovals(input(own), settings({ allowAgentApprovals: true })).approvals).toBe(
      0,
    );
  });

  it("needs an approval after the last push, from someone other than its pusher", () => {
    const at = ++clock;
    const before = review("alice", "APPROVED");
    const lastPush = { pusherRoot: "bob", at: at + 1 };
    clock = at + 1;
    const byPusher = review("bob", "APPROVED");
    const on = settings({ requireLastPushApproval: true });
    expect(evaluateApprovals(input([before, byPusher], { lastPush }), on)).toMatchObject({
      approvals: 2,
      lastPushApproved: false,
      satisfied: false,
    });
    expect(
      evaluateApprovals(input([before, byPusher, review("carol", "APPROVED")], { lastPush }), on)
        .satisfied,
    ).toBe(true);
    // Separate from the count: with none required, it still needs that approval.
    expect(
      evaluateApprovals(
        input([], { lastPush }),
        settings({ required: 0, requireLastPushApproval: true }),
      ).satisfied,
    ).toBe(false);
    expect(evaluateApprovals(input([], { lastPush }), settings({ required: 0 })).satisfied).toBe(
      true,
    );
  });

  it("never takes an approval of an earlier head as approving the last push, though it still counts", () => {
    const lastPush = { pusherRoot: "bob", at: ++clock };
    // Submitted after the push, from a page that still showed the earlier head.
    const ofEarlier = review("alice", "APPROVED", { commitSha: OLD });
    for (const required of [0, 1])
      expect(
        evaluateApprovals(
          input([ofEarlier], { lastPush }),
          settings({ required, requireLastPushApproval: true }),
        ),
      ).toMatchObject({ approvals: 1, lastPushApproved: false, satisfied: false });
    expect(
      evaluateApprovals(
        input([ofEarlier, review("carol", "APPROVED")], { lastPush }),
        settings({ requireLastPushApproval: true }),
      ),
    ).toMatchObject({ approvals: 2, lastPushApproved: true, satisfied: true });
  });

  it("takes the one submitted last of a person's reviews at the same moment, however listed", () => {
    const at = ++clock;
    const listings = (reviews: ReviewFact[]) => [reviews, [...reviews].reverse()];
    const approveThenRequest = [
      review("alice", "APPROVED", { submittedAt: at }),
      review("alice", "CHANGES_REQUESTED", { submittedAt: at }),
    ];
    for (const reviews of listings(approveThenRequest))
      expect(evaluateApprovals(input(reviews), settings())).toMatchObject({
        approvals: 0,
        changesRequested: ["alice"],
      });
    const requestThenApprove = [
      review("alice", "CHANGES_REQUESTED", { submittedAt: at }),
      review("alice", "APPROVED", { submittedAt: at }),
    ];
    for (const reviews of listings(requestThenApprove))
      expect(evaluateApprovals(input(reviews), settings())).toMatchObject({
        approvals: 1,
        changesRequested: [],
      });
  });

  it("approves the last push only when a person's last review at the same moment is of the head", () => {
    const lastPush = { pusherRoot: "bob", at: ++clock };
    const at = ++clock;
    const on = (over: Partial<ApprovalSettings> = {}) =>
      settings({ requireLastPushApproval: true, ...over });
    const judged = (reviews: ReviewFact[], s: ApprovalSettings) =>
      [reviews, [...reviews].reverse()].map(
        (listed) => evaluateApprovals(input(listed, { lastPush }), s).lastPushApproved,
      );
    const headThenEarlier = [
      review("alice", "APPROVED", { submittedAt: at }),
      review("alice", "APPROVED", { submittedAt: at, commitSha: OLD }),
    ];
    expect(judged(headThenEarlier, on())).toEqual([false, false]);
    // Stale reviews dismissed: the earlier head's is not hers any more.
    expect(judged(headThenEarlier, on({ dismissStale: true }))).toEqual([true, true]);
    const earlierThenHead = [
      review("alice", "APPROVED", { submittedAt: at, commitSha: OLD }),
      review("alice", "APPROVED", { submittedAt: at }),
    ];
    expect(judged(earlierThenHead, on())).toEqual([true, true]);
    // Her agent approving the earlier head after her counts only where agents do.
    const agentAfter = [
      review("alice", "APPROVED", { submittedAt: at }),
      review("alice", "APPROVED", { submittedAt: at, commitSha: OLD, byAgent: true }),
    ];
    expect(judged(agentAfter, on())).toEqual([true, true]);
    expect(judged(agentAfter, on({ allowAgentApprovals: true }))).toEqual([false, false]);
  });

  it("never takes an approval as coming after a push it does not know of", () => {
    const required = settings({ required: 0, requireLastPushApproval: true });
    expect(evaluateApprovals(input([], { lastPush: null }), required).satisfied).toBe(false);
    expect(
      evaluateApprovals(input([review("alice", "APPROVED")], { lastPush: null }), required),
    ).toMatchObject({ approvals: 1, lastPushApproved: false, satisfied: false });
  });

  const reviewArb = fc
    .record({
      reviewerRoot: fc.constantFrom("author", "alice", "bob", "carol", "dave"),
      byAgent: fc.boolean(),
      active: fc.boolean(),
      commitSha: fc.constantFrom(HEAD, OLD),
      state: fc.constantFrom(...REVIEW_STATES),
      submittedAt: fc.nat(1_000),
      seq: fc.nat(1_000),
      dismissed: fc.boolean(),
    })
    .map((r) => ({ ...r, reviewerId: r.byAgent ? `agt_${r.reviewerRoot}` : r.reviewerRoot }));
  const settingsArb = fc.record({
    required: fc.integer({ min: 0, max: 10 }),
    dismissStale: fc.boolean(),
    requireLastPushApproval: fc.boolean(),
    allowAgentApprovals: fc.boolean(),
  });

  it("does not depend on the order reviews are listed in, ties included", () => {
    fc.assert(
      // Equal times are common; submission order never repeats.
      fc.property(
        fc.uniqueArray(reviewArb, { selector: (r) => r.seq, maxLength: 12 }),
        settingsArb,
        (reviews, s) => {
          const forward = evaluateApprovals(input(reviews), s);
          const backward = evaluateApprovals(input([...reviews].reverse()), s);
          expect(backward).toEqual(forward);
        },
      ),
    );
  });

  it("never counts more approvals than eligible people other than the author, nor less after a new approval", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(reviewArb, { selector: (r) => r.seq, maxLength: 12 }),
        settingsArb,
        (reviews, s) => {
          const outcome = evaluateApprovals(input(reviews), s);
          expect(outcome.approvals).toBeLessThanOrEqual(3);
          expect(outcome.satisfied).toBe(outcome.reasons.length === 0);
          // A person approving the head last, as themselves, never lowers the count.
          const later = review("carol", "APPROVED", { submittedAt: 2_000, seq: 2_000 });
          expect(evaluateApprovals(input([...reviews, later]), s).approvals).toBeGreaterThanOrEqual(
            outcome.approvals,
          );
        },
      ),
    );
  });
});
