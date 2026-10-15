import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type MergeContext,
  protectsBranch,
  type RuleActor,
  ruleViolations,
} from "../../src/rulesets/evaluate.js";
import {
  pullRequestParameters,
  type Rule,
  type Ruleset,
  refPatternMatches,
} from "../../src/rulesets/ruleset.js";

const ruleset = (over: Partial<Ruleset>): Ruleset => ({
  id: 1,
  name: "protect main",
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  rules: [],
  bypass_actors: [],
  ...over,
});

const human: RuleActor = { principalType: "user", role: "write" };
const admin: RuleActor = { principalType: "user", role: "admin" };
const agent: RuleActor = { principalType: "agent", role: "write" };

describe("ref patterns", () => {
  it("match full names, segments with *, anything with **, and the special names", () => {
    const m = (p: string, ref: string, target: Ruleset["target"] = "branch") =>
      refPatternMatches(p, ref, target, "main");
    expect(m("refs/heads/release/*", "refs/heads/release/1.0")).toBe(true);
    expect(m("refs/heads/release/*", "refs/heads/release/1.0/hotfix")).toBe(false);
    expect(m("refs/heads/release/**", "refs/heads/release/1.0/hotfix")).toBe(true);
    expect(m("refs/heads/v?", "refs/heads/v1")).toBe(true);
    expect(m("refs/heads/a.b", "refs/heads/axb")).toBe(false);
    expect(m("~DEFAULT_BRANCH", "refs/heads/main")).toBe(true);
    expect(m("~DEFAULT_BRANCH", "refs/heads/dev")).toBe(false);
    expect(m("~ALL", "refs/tags/v1")).toBe(false);
    expect(m("~ALL", "refs/tags/v1", "tag")).toBe(true);
    expect(refPatternMatches("~DEFAULT_BRANCH", "refs/heads/main", "branch", null)).toBe(false);
  });
});

describe("branch protection", () => {
  it("is whether an active branch ruleset with a rule covers the branch, whoever asks", () => {
    const deletion = { type: "deletion" as const };
    const on = (over: Partial<Ruleset>) =>
      protectsBranch([ruleset({ rules: [deletion], ...over })], "main", "main");
    expect(on({})).toBe(true);
    // A bypass or an actor type changes who it stops, not that the branch is protected.
    expect(
      on({
        bypass_actors: [{ actor_type: "RepositoryRole", actor_id: "admin", bypass_mode: "always" }],
      }),
    ).toBe(true);
    expect(on({ actor_types: ["agent"] })).toBe(true);
    // Not enforced, or nothing to enforce, or another branch or a tag ruleset: not protected.
    expect(on({ enforcement: "evaluate" })).toBe(false);
    expect(on({ enforcement: "disabled" })).toBe(false);
    expect(protectsBranch([ruleset({ rules: [] })], "main", "main")).toBe(false);
    expect(protectsBranch([ruleset({ rules: [deletion] })], "dev", "main")).toBe(false);
    expect(
      protectsBranch(
        [
          ruleset({
            target: "tag",
            rules: [deletion],
            conditions: { ref_name: { include: ["~ALL"], exclude: [] } },
          }),
        ],
        "main",
        "main",
      ),
    ).toBe(false);
    // Excluded by name.
    expect(
      protectsBranch(
        [
          ruleset({
            rules: [deletion],
            conditions: { ref_name: { include: ["~ALL"], exclude: ["refs/heads/main"] } },
          }),
        ],
        "main",
        "main",
      ),
    ).toBe(false);
    expect(protectsBranch([], "main", "main")).toBe(false);
  });
});

describe("glob matching", () => {
  it("answers as the plain set-of-positions match does, for any pattern and ref", async () => {
    const { globMatches } = await import("../../src/rulesets/ruleset.js");
    // The matcher before its shortcuts: every position, every token.
    const reference = (pattern: string, ref: string): boolean => {
      const n = ref.length;
      let reach = new Uint8Array(n + 1);
      reach[0] = 1;
      for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i] as string;
        const next = new Uint8Array(n + 1);
        if (c === "*") {
          const crosses = pattern[i + 1] === "*";
          if (crosses) i++;
          let open = false;
          for (let at = 0; at <= n; at++) {
            if (reach[at]) open = true;
            if (open) next[at] = 1;
            if (!crosses && ref[at] === "/") open = false;
          }
        } else {
          for (let at = 0; at < n; at++)
            if (reach[at] && (c === "?" ? ref[at] !== "/" : ref[at] === c)) next[at + 1] = 1;
        }
        reach = next;
      }
      return reach[n] === 1;
    };
    const text = (chars: string[], max: number) =>
      fc.array(fc.constantFrom(...chars), { maxLength: max }).map((a) => a.join(""));
    fc.assert(
      fc.property(text(["a", "b", "/", "*", "?"], 12), text(["a", "b", "/"], 14), (p, r) => {
        expect(globMatches(p, r)).toBe(reference(p, r));
      }),
      { numRuns: 5_000 },
    );
  });

  it("stops as soon as a pattern can no longer match: every pattern against a page of branches", async () => {
    const { globMatches, globWalk } = await import("../../src/rulesets/ruleset.js");
    // Patterns that differ from every branch early: their length past that
    // costs nothing. Counted, not timed: a matcher that walks whole patterns
    // visits about ten times as many positions for patterns ten times as long.
    const refs = Array.from({ length: 20 }, (_, i) => `refs/heads/${"b".repeat(226)}${i}`);
    const work = (length: number) => {
      let steps = 0;
      for (const ref of refs)
        for (let i = 0; i < 1_000; i++) {
          const pattern =
            i % 2 === 0
              ? `refs/heads/f${i}/${"x".repeat(length)}*`
              : `refs/heads/f${i}/${"x".repeat(length)}`;
          const walked = globWalk(pattern, ref);
          expect(walked.matched).toBe(false);
          steps += walked.steps;
        }
      return steps;
    };
    expect(work(2_000)).toBe(work(200));
    // A matching wildcard walks at most the pattern's length times the ref's.
    const ref = `refs/heads/${"b".repeat(240)}`;
    expect(globWalk("refs/heads/b*", ref).steps).toBeLessThanOrEqual(13 * (ref.length + 1));
    // Still exact where it matters.
    expect(globMatches(`refs/heads/${"b".repeat(5)}`, `refs/heads/${"b".repeat(5)}`)).toBe(true);
    expect(globMatches("refs/heads/b*", `refs/heads/${"b".repeat(240)}`)).toBe(true);
    expect(globMatches("refs/heads/*/x", "refs/heads/a/x")).toBe(true);
  });

  it("never backtracks: a pattern built to explode answers at once", async () => {
    const { globMatches } = await import("../../src/rulesets/ruleset.js");
    const pattern = `refs/heads/${"*a".repeat(12)}b`;
    const started = Date.now();
    expect(globMatches(pattern, `refs/heads/${"a".repeat(200)}`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(100);
    expect(globMatches("refs/heads/*", "refs/heads/")).toBe(true);
    expect(globMatches("refs/heads/**/x", "refs/heads/a/b/x")).toBe(true);
    expect(globMatches("refs/heads/**/x", "refs/heads/x")).toBe(false);
    expect(globMatches("**", "refs/tags/v1")).toBe(true);
    expect(globMatches("refs/*/main", "refs/heads/main")).toBe(true);
    expect(globMatches("refs/*/main", "refs/heads/a/main")).toBe(false);
    expect(globMatches("refs/heads/a[b]", "refs/heads/a[b]")).toBe(true);
  });
});

describe("rule violations", () => {
  it("name the ruleset, block only active rulesets, and spare bypassing roles", () => {
    const sets = [
      ruleset({
        rules: [{ type: "deletion" }],
        bypass_actors: [{ actor_type: "RepositoryRole", actor_id: "admin", bypass_mode: "always" }],
      }),
    ];
    const del = { ref: "refs/heads/main", kind: "delete" as const };
    expect(ruleViolations(sets, del, human, "main", "precheck")).toEqual([
      {
        rulesetId: sets[0]?.id,
        ruleset: "protect main",
        rule: "deletion",
        message: 'cannot delete this ref (ruleset "protect main")',
        blocking: true,
      },
    ]);
    expect(ruleViolations(sets, del, admin, "main", "precheck")).toEqual([]);
    expect(
      ruleViolations(sets, { ...del, ref: "refs/heads/dev" }, human, "main", "precheck"),
    ).toEqual([]);
    const evaluating = [ruleset({ enforcement: "evaluate", rules: [{ type: "deletion" }] })];
    expect(ruleViolations(evaluating, del, human, "main", "precheck")[0]?.blocking).toBe(false);
    const disabled = [ruleset({ enforcement: "disabled", rules: [{ type: "deletion" }] })];
    expect(ruleViolations(disabled, del, human, "main", "precheck")).toEqual([]);
  });

  it("make agents use pull requests while their human may push", () => {
    const sets = [ruleset({ actor_types: ["agent"], rules: [{ type: "pull_request" }] })];
    const push = { ref: "refs/heads/main", kind: "update" as const, fastForward: true };
    expect(ruleViolations(sets, push, agent, "main", "precheck").map((v) => v.rule)).toEqual([
      "pull_request",
    ]);
    expect(ruleViolations(sets, push, human, "main", "precheck")).toEqual([]);
  });

  it("check force pushes and signatures at the commit point only", () => {
    const sets = [
      ruleset({ rules: [{ type: "non_fast_forward" }, { type: "required_signatures" }] }),
    ];
    const forced = {
      ref: "refs/heads/main",
      kind: "update" as const,
      fastForward: false,
      unverifiedCommit: { sha: "a".repeat(40), reason: "unsigned" },
    };
    expect(ruleViolations(sets, forced, human, "main", "precheck")).toEqual([]);
    expect(ruleViolations(sets, forced, human, "main", "commit").map((v) => v.message)).toEqual([
      'cannot force-push to this ref (ruleset "protect main")',
      `commits must have verified signatures (${"a".repeat(12)} is unsigned) (ruleset "protect main")`,
    ]);
    expect(
      ruleViolations(
        sets,
        { ref: "refs/heads/main", kind: "update", fastForward: true },
        human,
        "main",
        "commit",
      ),
    ).toEqual([]);
  });

  it("apply exclusions and targets", () => {
    const sets = [
      ruleset({
        target: "tag",
        conditions: { ref_name: { include: ["~ALL"], exclude: ["refs/tags/tmp-*"] } },
        rules: [{ type: "creation" }],
      }),
    ];
    const create = (ref: string) =>
      ruleViolations(sets, { ref, kind: "create" }, human, "main", "precheck");
    expect(create("refs/tags/v1")).toHaveLength(1);
    expect(create("refs/tags/tmp-1")).toHaveLength(0);
    expect(create("refs/heads/v1")).toHaveLength(0);
  });
});

describe("principal types by id", () => {
  it("are read from the id's prefix", async () => {
    const { principalTypeOf } = await import("../../src/principals/principal.js");
    expect(principalTypeOf("usr_01ABC")).toBe("user");
    expect(principalTypeOf("agt_01ABC")).toBe("agent");
    expect(principalTypeOf("ins_01ABC")).toBe("installation");
    expect(principalTypeOf("rep_01ABC")).toBeUndefined();
    expect(principalTypeOf("nonsense")).toBeUndefined();
  });
});

describe("pull request merges", () => {
  const head = "h".repeat(40);
  const merge = (over: Partial<MergeContext> = {}): MergeContext => ({
    number: 7,
    method: "merge",
    approvals: {
      reviews: [],
      headSha: head,
      authorRoot: "author",
      lastPush: null,
      eligibleRoots: new Set(["alice", "bob"]),
    },
    unresolvedThreads: 0,
    upToDate: true,
    ...over,
  });
  const approved = (roots: string[]) =>
    merge({
      approvals: {
        ...merge().approvals,
        reviews: roots.map((reviewerRoot, i) => ({
          reviewerRoot,
          byAgent: false,
          commitSha: head,
          state: "APPROVED" as const,
          submittedAt: i + 1,
          dismissed: false,
        })),
      },
    });
  const protect = (parameters: Rule["parameters"], extra: Rule[] = []) => [
    ruleset({ rules: [{ type: "pull_request", ...(parameters && { parameters }) }, ...extra] }),
  ];
  const violations = (rulesets: Ruleset[], pullRequest?: MergeContext) =>
    ruleViolations(
      rulesets,
      {
        ref: "refs/heads/main",
        kind: "update",
        fastForward: true,
        ...(pullRequest && { pullRequest }),
      },
      human,
      "main",
      "commit",
    ).map((v) => v.message);

  it("refuses a direct update, and lets a merge through with no requirements set (stored before parameters existed)", () => {
    expect(violations(protect(undefined))).toEqual([
      'changes must be made through a pull request (ruleset "protect main")',
    ]);
    expect(violations(protect(undefined), merge())).toEqual([]);
  });

  it("counts approvals against each ruleset's own requirement", () => {
    const rulesets = protect({ required_approving_review_count: 2 });
    expect(violations(rulesets, approved(["alice"]))).toEqual([
      'pull request #7: 2 approving reviews are required (1 given) (ruleset "protect main")',
    ]);
    expect(violations(rulesets, approved(["alice", "bob"]))).toEqual([]);
  });

  it("checks the merge method, unresolved threads and being up to date", () => {
    expect(violations(protect({ allowed_merge_methods: ["squash"] }), merge())).toEqual([
      'pull request #7 cannot be merged by merge (allowed: squash) (ruleset "protect main")',
    ]);
    expect(
      violations(
        protect({ required_review_thread_resolution: true }),
        merge({ unresolvedThreads: 2 }),
      ),
    ).toEqual(['pull request #7: 2 review threads are unresolved (ruleset "protect main")']);
    const upToDate = [ruleset({ rules: [{ type: "require_up_to_date" }] })];
    expect(violations(upToDate, merge({ upToDate: false }))).toEqual([
      'pull request #7 must include the latest commit of the branch it merges into (ruleset "protect main")',
    ]);
    // Not a merge: the rule has nothing to check.
    expect(violations(upToDate)).toEqual([]);
  });

  it("never reads a code-owner requirement from stored parameters", () => {
    const stored = { require_code_owner_review: true } as unknown as NonNullable<
      Rule["parameters"]
    >;
    expect(
      pullRequestParameters({ type: "pull_request", parameters: stored }).require_code_owner_review,
    ).toBe(false);
  });
});
