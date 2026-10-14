import { describe, expect, it } from "vitest";
import { type RuleActor, ruleViolations } from "../../src/rulesets/evaluate.js";
import { type Ruleset, refPatternMatches } from "../../src/rulesets/ruleset.js";

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

describe("glob matching", () => {
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
