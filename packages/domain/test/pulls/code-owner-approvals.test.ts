import { describe, expect, it } from "vitest";
import type { ApprovalInput, ApprovalSettings, ReviewFact } from "../../src/pulls/approvals.js";
import {
  type CodeOwnerFact,
  type CodeOwnersInput,
  codeOwnerClaims,
  codeOwnerRefusal,
  codeOwnersWithout,
  membershipKey,
  ownershipCandidates,
} from "../../src/pulls/code-owner-approvals.js";

const HEAD = "h".repeat(40);
const OLD = "o".repeat(40);
const settings = (over: Partial<ApprovalSettings> = {}): ApprovalSettings => ({
  required: 0,
  dismissStale: false,
  requireLastPushApproval: false,
  allowAgentApprovals: false,
  ...over,
});
const everyone = ["author", "alice", "bob", "carol", "agt_a", "agt_b", "agt_org"];
const input = (reviews: ReviewFact[], over: Partial<ApprovalInput> = {}): ApprovalInput => ({
  reviews,
  headSha: HEAD,
  authorRoot: "author",
  lastPush: null,
  eligibleRoots: new Set(everyone),
  eligiblePrincipals: new Set(everyone),
  ...over,
});
let clock = 0;
const review = (
  reviewerId: string,
  state: ReviewFact["state"],
  over: Partial<ReviewFact> = {},
): ReviewFact => ({
  reviewerId,
  reviewerRoot: reviewerId,
  active: true,
  byAgent: reviewerId.startsWith("agt_"),
  commitSha: HEAD,
  state,
  submittedAt: ++clock,
  seq: clock,
  dismissed: false,
  ...over,
});
/** An agent of alice's: rooted in her. */
const alicesAgent = (id: string, state: ReviewFact["state"] = "APPROVED") =>
  review(id, state, { reviewerRoot: "alice", byAgent: true });

const user = (principal: string): CodeOwnerFact => ({
  kind: "user",
  token: `@${principal}`,
  principal,
  qualified: true,
});
const agent = (principal: string): CodeOwnerFact => ({
  kind: "agent",
  token: `@${principal}`,
  principal,
  qualified: true,
});
const team = (teamId: string): CodeOwnerFact => ({
  kind: "team",
  token: `@acme/${teamId}`,
  teamId,
  qualified: true,
});
const owners = (
  requirements: { line: number; owners: CodeOwnerFact[] }[],
  memberships: [string, string][] = [],
): CodeOwnersInput => ({
  state: "complete",
  requirements: requirements.map((r) => ({ ...r, example: `path/${r.line}` })),
  memberships: new Set(memberships.map(([t, p]) => membershipKey(t, p))),
  asked: new Set(everyone),
});

describe("ownershipCandidates", () => {
  it("takes each reviewer's own latest approval, not one per root", () => {
    const candidates = ownershipCandidates(
      input([alicesAgent("agt_a"), alicesAgent("agt_b"), review("alice", "COMMENTED")]),
      settings({ allowAgentApprovals: true }),
    );
    expect(candidates.map((c) => c.principal).sort()).toEqual(["agt_a", "agt_b"]);
  });

  it("drops the author's, stale ones when they are dismissed, disabled reviewers, and those without write", () => {
    const candidates = ownershipCandidates(
      input(
        [
          review("author", "APPROVED"),
          review("bob", "APPROVED", { commitSha: OLD }),
          review("carol", "APPROVED", { active: false }),
          review("alice", "APPROVED"),
          alicesAgent("agt_a"),
        ],
        { eligiblePrincipals: new Set(["author", "alice", "bob", "carol"]) },
      ),
      settings({ dismissStale: true, allowAgentApprovals: true }),
    );
    // The agent lacks write access of its own; the rest are dropped for their own reasons.
    expect(candidates.map((c) => c.principal)).toEqual(["alice"]);
  });

  it("drops agents' reviews unless agents' approvals count, and a reviewer whose latest asks for changes", () => {
    const reviews = [
      alicesAgent("agt_a"),
      review("bob", "APPROVED"),
      review("bob", "CHANGES_REQUESTED"),
    ];
    expect(ownershipCandidates(input(reviews), settings())).toEqual([]);
    expect(
      ownershipCandidates(input(reviews), settings({ allowAgentApprovals: true })).map(
        (c) => c.principal,
      ),
    ).toEqual(["agt_a"]);
  });
});

describe("codeOwnerRefusal", () => {
  it("needs nothing without a CODEOWNERS file, nor for a rule with no required owners", () => {
    expect(codeOwnerRefusal(input([]), { state: "none" }, settings())).toBeUndefined();
    expect(codeOwnerRefusal(input([]), owners([]), settings())).toBeUndefined();
  });

  it("refuses what is not worked out, and says why", () => {
    expect(
      codeOwnerRefusal(
        input([]),
        { state: "refused", reason: "code owners are still being worked out" },
        settings(),
      ),
    ).toBe("code owners are still being worked out");
    expect(codeOwnerRefusal(input([]), undefined, settings())).toBe(
      "code owners could not be worked out for this merge",
    );
  });

  it("is satisfied by a user owner's own approval, or one of their agents' when agents' count", () => {
    const required = owners([{ line: 3, owners: [user("alice")] }]);
    expect(codeOwnerRefusal(input([review("alice", "APPROVED")]), required, settings())).toBe(
      undefined,
    );
    expect(codeOwnerRefusal(input([alicesAgent("agt_a")]), required, settings())).toBe(
      "code owners must approve: line 3 (path/3: @alice)",
    );
    expect(
      codeOwnerRefusal(
        input([alicesAgent("agt_a")]),
        required,
        settings({ allowAgentApprovals: true }),
      ),
    ).toBeUndefined();
  });

  it("tells two agents of one user apart: each satisfies the rule naming it", () => {
    const required = owners([
      { line: 1, owners: [agent("agt_a")] },
      { line: 2, owners: [agent("agt_b")] },
    ]);
    const both = input([alicesAgent("agt_a"), alicesAgent("agt_b")]);
    expect(codeOwnerRefusal(both, required, settings({ allowAgentApprovals: true }))).toBe(
      undefined,
    );
    expect(
      codeOwnerRefusal(
        input([alicesAgent("agt_b")]),
        required,
        settings({ allowAgentApprovals: true }),
      ),
    ).toBe("code owners must approve: line 1 (path/1: @agt_a)");
  });

  it("takes no agent as an owner when agents' approvals do not count", () => {
    const required = owners([{ line: 4, owners: [agent("agt_org")] }]);
    expect(codeOwnerRefusal(input([review("agt_org", "APPROVED")]), required, settings())).toBe(
      "line 4 (path/4): no qualifying owner (@agt_org: agents' approvals do not count)",
    );
  });

  it("is satisfied by a team member's approval, or by an agent of a member when agents' count", () => {
    const required = owners([{ line: 9, owners: [team("t_core")] }], [["t_core", "alice"]]);
    expect(codeOwnerRefusal(input([review("alice", "APPROVED")]), required, settings())).toBe(
      undefined,
    );
    expect(codeOwnerRefusal(input([review("bob", "APPROVED")]), required, settings())).toBe(
      "code owners must approve: line 9 (path/9: @acme/t_core)",
    );
    expect(
      codeOwnerRefusal(
        input([alicesAgent("agt_a")]),
        required,
        settings({ allowAgentApprovals: true }),
      ),
    ).toBeUndefined();
  });

  it("refuses a rule whose owners all fail to qualify, naming each reason", () => {
    const required = owners([
      {
        line: 7,
        owners: [
          { kind: "unknown", token: "@carol", qualified: false, reason: "no such user" },
          { kind: "team", token: "@acme/ops", qualified: false, reason: "no write access" },
        ],
      },
    ]);
    expect(codeOwnerRefusal(input([review("alice", "APPROVED")]), required, settings())).toBe(
      "line 7 (path/7): no qualifying owner (@carol: no such user; @acme/ops: no write access)",
    );
  });

  it("names at most ten rules, then how many more", () => {
    const required = owners(
      Array.from({ length: 12 }, (_, i) => ({ line: i + 1, owners: [user("bob")] })),
    );
    expect(codeOwnerRefusal(input([]), required, settings())).toMatch(
      /^code owners must approve: line 1 .* line 10 \(path\/10: @bob\) and 2 more$/,
    );
  });
});

describe("codeOwnerClaims", () => {
  it("names every principal, team and membership the satisfied rules rest on", () => {
    const required = owners(
      [
        { line: 1, owners: [user("alice")] },
        { line: 2, owners: [team("t_core")] },
      ],
      [
        ["t_core", "bob"],
        ["t_core", "carol"],
      ],
    );
    const claims = codeOwnerClaims(
      input([alicesAgent("agt_a"), review("bob", "APPROVED"), review("carol", "APPROVED")]),
      required,
      settings({ allowAgentApprovals: true }),
    );
    expect([...claims.principals].sort()).toEqual(["agt_a", "alice", "bob", "carol"]);
    expect([...claims.teams]).toEqual(["t_core"]);
    expect([...claims.pairs].sort()).toEqual(
      [membershipKey("t_core", "bob"), membershipKey("t_core", "carol")].sort(),
    );
  });
});

describe("codeOwnerClaims, for an agent and its user both in an owner team", () => {
  it("claims both memberships, so losing the agent's leaves nothing unconfirmed to fall back on", () => {
    const required = owners(
      [{ line: 1, owners: [team("t_core")] }],
      [
        ["t_core", "agt_a"],
        ["t_core", "alice"],
      ],
    );
    const reviews = input([alicesAgent("agt_a")]);
    const agents = settings({ allowAgentApprovals: true });
    const claims = codeOwnerClaims(reviews, required, agents);
    expect([...claims.pairs].sort()).toEqual(
      [membershipKey("t_core", "agt_a"), membershipKey("t_core", "alice")].sort(),
    );
    // Both lost (as a confirmation of both would find): nothing satisfies the rule.
    const lost = codeOwnersWithout(required, {
      principals: new Set(),
      teams: new Set(),
      pairs: claims.pairs,
    });
    expect(codeOwnerRefusal(reviews, lost, agents)).toBe(
      "code owners must approve: line 1 (path/1: @acme/t_core)",
    );
  });
});

describe("codeOwnerRefusal, with memberships not read for every candidate", () => {
  it("does not judge a team rule a candidate whose memberships were not read might satisfy", () => {
    const required: CodeOwnersInput = {
      ...owners([{ line: 5, owners: [team("t_core")] }]),
      asked: new Set(["alice"]),
    } as CodeOwnersInput;
    expect(codeOwnerRefusal(input([review("bob", "APPROVED")]), required, settings())).toBe(
      "code owners could not be worked out for this merge",
    );
    // Every candidate's memberships read: judged.
    expect(codeOwnerRefusal(input([review("alice", "APPROVED")]), required, settings())).toBe(
      "code owners must approve: line 5 (path/5: @acme/t_core)",
    );
  });
});

describe("codeOwnersWithout", () => {
  it("unqualifies owners and drops memberships that no longer hold", () => {
    const required = owners(
      [
        { line: 1, owners: [user("alice")] },
        { line: 2, owners: [team("t_core")] },
      ],
      [["t_core", "bob"]],
    );
    const reviews = input([review("alice", "APPROVED"), review("bob", "APPROVED")]);
    expect(codeOwnerRefusal(reviews, required, settings())).toBeUndefined();
    const lostAlice = codeOwnersWithout(required, {
      principals: new Set(["alice"]),
      teams: new Set(),
      pairs: new Set(),
    });
    expect(codeOwnerRefusal(reviews, lostAlice, settings())).toBe(
      "line 1 (path/1): no qualifying owner (@alice: no write access)",
    );
    const lostPair = codeOwnersWithout(required, {
      principals: new Set(),
      teams: new Set(),
      pairs: new Set([membershipKey("t_core", "bob")]),
    });
    expect(codeOwnerRefusal(reviews, lostPair, settings())).toBe(
      "code owners must approve: line 2 (path/2: @acme/t_core)",
    );
    const lostTeam = codeOwnersWithout(required, {
      principals: new Set(),
      teams: new Set(["t_core"]),
      pairs: new Set(),
    });
    expect(codeOwnerRefusal(reviews, lostTeam, settings())).toBe(
      "line 2 (path/2): no qualifying owner (@acme/t_core: no write access)",
    );
  });
});
