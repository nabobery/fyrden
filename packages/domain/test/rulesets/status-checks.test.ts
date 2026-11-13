import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CHECK_CONCLUSIONS,
  type CheckConclusion,
  type CheckSummary,
} from "../../src/checks/checks.js";
import {
  candidateFacts,
  MAX_CHECKS_NAMED,
  type RequiredStatusCheck,
  requiredCheckOutcomes,
  requiredChecksRefusal,
  requiredStatusChecksParameters,
  type StatusCheckFacts,
} from "../../src/rulesets/status-checks.js";

const SHA = "a".repeat(40);

/** A status, as the check summaries hold one: that source's latest for the context. */
const status = (
  name: string,
  source: string,
  state: "pending" | "success" | "failure" | "error",
  statusId: number,
): CheckSummary => ({
  name,
  source,
  kind: "status",
  attempt: null,
  statusId,
  status: state === "pending" ? "in_progress" : "completed",
  conclusion: state === "pending" ? null : state,
  detailsUrl: null,
  updatedAt: 0,
});

/** A check's current attempt. */
const check = (
  name: string,
  status: CheckSummary["status"],
  conclusion: CheckConclusion | null = null,
  attempt = 1,
  source = "ci",
): CheckSummary => ({
  name,
  source,
  kind: "check",
  attempt,
  statusId: null,
  status,
  conclusion,
  detailsUrl: null,
  updatedAt: 0,
});

const facts = (...checks: CheckSummary[]): StatusCheckFacts => ({ sha: SHA, checks });
const req = (context: string, integration_id?: string): RequiredStatusCheck =>
  integration_id === undefined ? { context } : { context, integration_id };
const states = (required: RequiredStatusCheck[], f: StatusCheckFacts | undefined) =>
  requiredCheckOutcomes(required, f).map((o) => o.state);

describe("required status checks parameters", () => {
  it("are strict by default, as GitHub's rule is, and enforced on creation", () => {
    const p = requiredStatusChecksParameters({ required_status_checks: [req("build")] });
    expect(p).toEqual({
      required_status_checks: [{ context: "build" }],
      strict_required_status_checks_policy: true,
      do_not_enforce_on_create: false,
    });
  });

  it("keep loose and creation settings given explicitly", () => {
    const p = requiredStatusChecksParameters({
      required_status_checks: [req("build", "ci")],
      strict_required_status_checks_policy: false,
      do_not_enforce_on_create: true,
    });
    expect(p.strict_required_status_checks_policy).toBe(false);
    expect(p.do_not_enforce_on_create).toBe(true);
  });
});

describe("a required check's outcome", () => {
  it("passes on success, skipped and neutral", () => {
    expect(states([req("a")], facts(status("a", "usr_1", "success", 1)))).toEqual(["passed"]);
    expect(states([req("b")], facts(check("b", "completed", "skipped")))).toEqual(["passed"]);
    expect(states([req("c")], facts(check("c", "completed", "neutral")))).toEqual(["passed"]);
  });

  it("is pending while a status is pending or a check is queued or in progress", () => {
    expect(states([req("a")], facts(status("a", "usr_1", "pending", 1)))).toEqual(["pending"]);
    expect(states([req("b")], facts(check("b", "queued")))).toEqual(["pending"]);
    expect(states([req("c")], facts(check("c", "in_progress")))).toEqual(["pending"]);
  });

  it("fails on every other conclusion, a status error included", () => {
    const others = CHECK_CONCLUSIONS.filter((c) => !["success", "skipped", "neutral"].includes(c));
    expect(others).toEqual(["failure", "cancelled", "timed_out", "action_required", "error"]);
    for (const conclusion of others)
      expect(states([req("b")], facts(check("b", "completed", conclusion)))).toEqual(["failing"]);
    expect(states([req("a")], facts(status("a", "usr_1", "error", 1)))).toEqual(["failing"]);
  });

  it("is expected when nothing reported it", () => {
    expect(states([req("build")], facts(status("lint", "usr_1", "success", 1)))).toEqual([
      "expected",
    ]);
  });

  it("is expected for every requirement when the facts could not be read", () => {
    expect(states([req("build"), req("lint")], undefined)).toEqual(["expected", "expected"]);
  });

  it("compares names case-insensitively", () => {
    expect(states([req("CI/Build")], facts(status("ci/build", "usr_1", "success", 1)))).toEqual([
      "passed",
    ]);
  });

  it("compares names as the summaries key them, one Unicode form for one name", () => {
    const composed = "caf\u00e9";
    const decomposed = "cafe\u0301";
    expect(states([req(decomposed)], facts(status(composed, "usr_1", "success", 1)))).toEqual([
      "passed",
    ]);
  });

  it("is decided by the current attempt: a re-run that started blocks again", () => {
    expect(states([req("test")], facts(check("test", "queued", null, 2)))).toEqual(["pending"]);
  });

  it("needs a check and a status of one name both to pass", () => {
    const both = (s: "success" | "failure", c: CheckConclusion) =>
      states([req("build")], facts(status("build", "usr_1", s, 1), check("build", "completed", c)));
    expect(both("success", "success")).toEqual(["passed"]);
    expect(both("success", "failure")).toEqual(["failing"]);
    expect(both("failure", "success")).toEqual(["failing"]);
  });

  it("prefers failing to pending when the deciding facts disagree", () => {
    expect(
      states(
        [req("build")],
        facts(status("build", "usr_1", "pending", 1), check("build", "completed", "failure")),
      ),
    ).toEqual(["failing"]);
  });
});

describe("the expected source", () => {
  it("counts only that source: a same-name status from another neither passes nor blocks", () => {
    const pinned = [req("build", "agt_ci")];
    expect(states(pinned, facts(status("build", "usr_mallory", "success", 9)))).toEqual([
      "expected",
    ]);
    expect(
      states(
        pinned,
        facts(
          status("build", "agt_ci", "success", 1),
          status("build", "usr_mallory", "failure", 9),
        ),
      ),
    ).toEqual(["passed"]);
  });

  it("may be Fyrden's own runs", () => {
    expect(states([req("test", "ci")], facts(check("test", "completed", "success")))).toEqual([
      "passed",
    ]);
  });

  it("is any source when left out: the latest status by its id decides, not the earlier ones", () => {
    const any = [req("build")];
    expect(
      states(
        any,
        facts(status("build", "usr_a", "failure", 3), status("build", "usr_b", "success", 7)),
      ),
    ).toEqual(["passed"]);
    expect(
      states(
        any,
        facts(status("build", "usr_a", "failure", 8), status("build", "usr_b", "success", 7)),
      ),
    ).toEqual(["failing"]);
  });

  it("still needs every check of the name to pass when left out", () => {
    expect(
      states(
        [req("build")],
        facts(
          check("build", "completed", "success", 1, "ci"),
          check("build", "completed", "failure", 1, "agt_other"),
        ),
      ),
    ).toEqual(["failing"]);
  });

  it("does not depend on the order the facts arrive in", () => {
    const pool = [
      status("build", "usr_a", "failure", 1),
      status("build", "usr_b", "success", 2),
      status("build", "agt_c", "pending", 3),
      check("build", "completed", "success"),
      check("build", "in_progress", null, 2, "agt_other"),
      status("lint", "usr_a", "success", 4),
    ];
    const required = [req("build"), req("build", "usr_b"), req("lint"), req("docs")];
    const expected = requiredCheckOutcomes(required, facts(...pool));
    fc.assert(
      fc.property(fc.shuffledSubarray(pool, { minLength: pool.length }), (shuffled) => {
        expect(requiredCheckOutcomes(required, facts(...shuffled))).toEqual(expected);
      }),
    );
  });
});

describe("deciding and candidate facts", () => {
  it("name the facts that decided, for display", () => {
    const winner = status("build", "usr_b", "success", 7);
    const ci = check("build", "completed", "success");
    const [outcome] = requiredCheckOutcomes(
      [req("build")],
      facts(status("build", "usr_a", "failure", 3), winner, ci),
    );
    expect(outcome?.deciding).toEqual([winner, ci]);
  });

  it("are every row a requirement could count: all sources unpinned, one source pinned", () => {
    const a = status("build", "usr_a", "failure", 3);
    const b = status("build", "usr_b", "success", 7);
    const other = status("lint", "usr_a", "success", 1);
    expect(candidateFacts(req("BUILD"), facts(a, b, other))).toEqual([a, b]);
    expect(candidateFacts(req("build", "usr_b"), facts(a, b, other))).toEqual([b]);
  });
});

describe("the refusal", () => {
  it("names the blocking checks in GitHub's words", () => {
    const outcomes = requiredCheckOutcomes(
      [req("ci/build"), req("lint"), req("test"), req("docs")],
      facts(
        status("lint", "usr_1", "pending", 1),
        check("test", "completed", "failure"),
        status("docs", "usr_1", "success", 2),
      ),
    );
    expect(requiredChecksRefusal(outcomes)).toBe(
      'required status check "ci/build" is expected; required status check "lint" is pending; required status check "test" is failing',
    );
  });

  it("is undefined when every required check passed", () => {
    const outcomes = requiredCheckOutcomes([req("a")], facts(status("a", "usr_1", "success", 1)));
    expect(requiredChecksRefusal(outcomes)).toBeUndefined();
  });

  it(`names at most ${MAX_CHECKS_NAMED} checks and counts the rest`, () => {
    const required = Array.from({ length: MAX_CHECKS_NAMED + 3 }, (_, i) => req(`job-${i}`));
    const refusal = requiredChecksRefusal(requiredCheckOutcomes(required, facts()));
    expect(refusal?.match(/required status check "/g)).toHaveLength(MAX_CHECKS_NAMED);
    expect(refusal).toMatch(/; and 3 more required status checks are not passing$/);
  });
});
