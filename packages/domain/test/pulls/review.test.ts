import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { atLeast, REPO_ROLES } from "../../src/authz/roles.js";
import { PULL_STATES } from "../../src/pulls/pull.js";
import {
  decideDismissal,
  decideReview,
  decideReviewRequest,
  REVIEW_EVENTS,
  reviewStateOf,
} from "../../src/pulls/review.js";

describe("decideReview", () => {
  const open = { pullState: "open", isAuthor: false, role: "read", body: "Looks off" } as const;

  it("lets a reader approve or request changes on someone else's pull request", () => {
    for (const event of REVIEW_EVENTS) expect(decideReview({ ...open, event }).ok).toBe(true);
  });

  it("takes reviews of a locked conversation only from write and above", () => {
    for (const event of REVIEW_EVENTS) {
      expect(decideReview({ ...open, event, locked: true })).toEqual({
        ok: false,
        refusal: "locked",
      });
      expect(decideReview({ ...open, event, role: "write", locked: true }).ok).toBe(true);
    }
  });

  it("lets the author only comment", () => {
    expect(decideReview({ ...open, isAuthor: true, event: "COMMENT" }).ok).toBe(true);
    for (const event of ["APPROVE", "REQUEST_CHANGES"] as const)
      expect(decideReview({ ...open, isAuthor: true, event })).toEqual({
        ok: false,
        refusal: "own_pull_request",
      });
  });

  it("needs a body to request changes or comment, not to approve", () => {
    expect(decideReview({ ...open, body: " ", event: "REQUEST_CHANGES" }).ok).toBe(false);
    expect(decideReview({ ...open, body: null, event: "COMMENT" }).ok).toBe(false);
    expect(decideReview({ ...open, body: null, event: "APPROVE" }).ok).toBe(true);
  });

  it("refuses without access, and on a closed or merged pull request", () => {
    expect(decideReview({ ...open, role: null, event: "COMMENT" }).ok).toBe(false);
    for (const pullState of ["closed", "merged"] as const)
      expect(decideReview({ ...open, pullState, event: "APPROVE" })).toEqual({
        ok: false,
        refusal: "wrong_state",
      });
  });

  it("maps events to the states reviews are stored in", () => {
    expect(REVIEW_EVENTS.map(reviewStateOf)).toEqual([
      "APPROVED",
      "CHANGES_REQUESTED",
      "COMMENTED",
    ]);
  });
});

describe("decideDismissal and decideReviewRequest", () => {
  it("dismisses only standing approvals and requests for changes, with write access", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("APPROVED", "CHANGES_REQUESTED", "COMMENTED" as const),
        fc.boolean(),
        fc.constantFrom(...PULL_STATES),
        fc.constantFrom(null, ...REPO_ROLES),
        (reviewState, dismissed, pullState, role) => {
          const ok =
            atLeast(role, "write") &&
            pullState === "open" &&
            !dismissed &&
            reviewState !== "COMMENTED";
          expect(decideDismissal({ reviewState, dismissed, pullState, role }).ok).toBe(ok);
        },
      ),
    );
  });

  it("lets the author or triage and above request reviews on an open pull request", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PULL_STATES),
        fc.boolean(),
        fc.constantFrom(null, ...REPO_ROLES),
        (pullState, isAuthor, role) => {
          const ok =
            atLeast(role, "read") && (isAuthor || atLeast(role, "triage")) && pullState === "open";
          expect(decideReviewRequest({ pullState, isAuthor, role }).ok).toBe(ok);
        },
      ),
    );
  });
});
