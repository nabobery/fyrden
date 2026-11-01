import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { atLeast, REPO_ROLES } from "../../src/authz/roles.js";
import { ISSUE_STATE_REASONS, ISSUE_STATES, type IssueState } from "../../src/issues/issue.js";
import {
  decideIssueAction,
  ISSUE_ACTION_RULES,
  ISSUE_ACTIONS,
  type IssueAction,
  type IssueStateFields,
  planIssueState,
} from "../../src/issues/lifecycle.js";

const open: IssueStateFields = {
  state: "open",
  stateReason: null,
  duplicateOf: null,
  closedAt: null,
  closedBy: null,
};
const closed = (reason: "completed" | "not_planned" | "duplicate", dup: number | null = null) =>
  ({
    state: "closed",
    stateReason: reason,
    duplicateOf: dup,
    closedAt: 100,
    closedBy: "usr_closer",
  }) satisfies IssueStateFields;
const at = { number: 7, actor: "usr_actor", now: 500 };

describe("decideIssueAction", () => {
  it.each([
    // [action, isAuthor, role, state, allowed]
    ["edit", true, "read", "open", true],
    ["edit", false, "triage", "open", false],
    ["edit", false, "write", "closed", true],
    ["close", true, "read", "open", true],
    ["close", false, "read", "open", false],
    ["close", false, "triage", "open", true],
    ["close", false, "admin", "closed", false],
    ["reopen", true, "read", "closed", true],
    ["reopen", false, "triage", "closed", true],
    ["reopen", false, "admin", "open", false],
    // Marking a duplicate takes triage, the author's own issue included.
    ["mark_duplicate", true, "read", "open", false],
    ["mark_duplicate", true, "triage", "closed", true],
    ["lock", true, "triage", "open", false],
    ["lock", false, "write", "closed", true],
    ["unlock", false, "write", "open", true],
    ["delete", true, "maintain", "open", false],
    ["delete", false, "admin", "closed", true],
  ] as const)("%s by author=%s with %s on %s: %s", (action, isAuthor, role, state, allowed) => {
    expect(decideIssueAction(action, { state, isAuthor, role }).ok).toBe(allowed);
  });

  it("never lets anyone without a role act, the author included", () => {
    for (const action of ISSUE_ACTIONS)
      for (const state of ISSUE_STATES)
        expect(decideIssueAction(action, { state, isAuthor: true, role: null })).toEqual({
          ok: false,
          refusal: "forbidden",
        });
  });

  it("allows exactly what the matrix says, for any input", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ISSUE_ACTIONS),
        fc.constantFrom(...ISSUE_STATES),
        fc.boolean(),
        fc.constantFrom(null, ...REPO_ROLES),
        (action: IssueAction, state: IssueState, isAuthor, role) => {
          const rule = ISSUE_ACTION_RULES[action];
          const allowedRole =
            role !== null &&
            ((rule.author && isAuthor) || (rule.minRole !== null && atLeast(role, rule.minRole)));
          const decision = decideIssueAction(action, { state, isAuthor, role });
          if (!allowedRole) expect(decision).toEqual({ ok: false, refusal: "forbidden" });
          else if (!rule.from.includes(state))
            expect(decision).toEqual({ ok: false, refusal: "wrong_state" });
          else expect(decision).toEqual({ ok: true });
        },
      ),
    );
  });
});

describe("planIssueState", () => {
  it("closes as completed unless a reason is given", () => {
    expect(planIssueState(open, { state: "closed" }, at)).toEqual({
      ok: true,
      action: "close",
      event: "closed",
      next: {
        state: "closed",
        stateReason: "completed",
        duplicateOf: null,
        closedAt: 500,
        closedBy: "usr_actor",
      },
    });
    expect(planIssueState(open, { state: "closed", stateReason: "not_planned" }, at)).toMatchObject(
      {
        action: "close",
        next: { stateReason: "not_planned" },
      },
    );
  });

  it("closes as a duplicate only with a target that is not the issue itself", () => {
    expect(
      planIssueState(open, { state: "closed", stateReason: "duplicate", duplicateOf: 3 }, at),
    ).toMatchObject({
      action: "mark_duplicate",
      event: "closed",
      next: { state: "closed", stateReason: "duplicate", duplicateOf: 3 },
    });
    expect(planIssueState(open, { state: "closed", stateReason: "duplicate" }, at)).toEqual({
      ok: false,
      refusal: "duplicate_target_required",
    });
    expect(
      planIssueState(open, { state: "closed", stateReason: "duplicate", duplicateOf: 7 }, at),
    ).toEqual({ ok: false, refusal: "duplicate_of_itself" });
    // A target without the duplicate reason says nothing coherent.
    expect(planIssueState(open, { state: "closed", duplicateOf: 3 }, at)).toEqual({
      ok: false,
      refusal: "duplicate_target_without_reason",
    });
  });

  it("reopens with the reopened reason and clears what the close set", () => {
    expect(planIssueState(closed("duplicate", 3), { state: "open" }, at)).toEqual({
      ok: true,
      action: "reopen",
      event: "reopened",
      next: {
        state: "open",
        stateReason: "reopened",
        duplicateOf: null,
        closedAt: null,
        closedBy: null,
      },
    });
    expect(planIssueState(open, { state: "open", stateReason: "reopened" }, at)).toEqual({
      ok: true,
      action: null,
      event: null,
      next: open,
    });
    expect(
      planIssueState(closed("completed"), { state: "open", stateReason: "not_planned" }, at),
    ).toEqual({
      ok: false,
      refusal: "reason_not_for_state",
    });
  });

  it("ignores a reason alone, as GitHub, except moving a closed issue to or from duplicate", () => {
    expect(planIssueState(closed("completed"), { stateReason: "not_planned" }, at)).toEqual({
      ok: true,
      action: null,
      event: null,
      next: closed("completed"),
    });
    expect(planIssueState(open, { stateReason: "not_planned" }, at)).toMatchObject({
      action: null,
    });
    // To duplicate: the target is set, the close (who, when) kept.
    expect(
      planIssueState(closed("completed"), { stateReason: "duplicate", duplicateOf: 4 }, at),
    ).toEqual({
      ok: true,
      action: "mark_duplicate",
      event: "edited",
      next: { ...closed("completed"), stateReason: "duplicate", duplicateOf: 4 },
    });
    // From duplicate: the target goes.
    expect(planIssueState(closed("duplicate", 4), { stateReason: "not_planned" }, at)).toEqual({
      ok: true,
      action: "mark_duplicate",
      event: "edited",
      next: { ...closed("not_planned"), duplicateOf: null },
    });
    // Another target.
    expect(planIssueState(closed("duplicate", 4), { duplicateOf: 5 }, at)).toMatchObject({
      action: "mark_duplicate",
      next: { duplicateOf: 5 },
    });
    // The same target: nothing to do.
    expect(planIssueState(closed("duplicate", 4), { duplicateOf: 4 }, at)).toMatchObject({
      action: null,
    });
  });

  it("closing a closed issue or reopening an open one changes nothing", () => {
    expect(planIssueState(closed("completed"), { state: "closed" }, at)).toMatchObject({
      action: null,
      next: closed("completed"),
    });
    expect(planIssueState(open, { state: "open" }, at)).toMatchObject({ action: null, next: open });
  });

  it("keeps the invariants for any change: a target exactly when closed as a duplicate", () => {
    const fields = fc.oneof(
      fc.constant(open),
      fc.constant({ ...open, stateReason: "reopened" as const }),
      fc.constantFrom(closed("completed"), closed("not_planned"), closed("duplicate", 2)),
    );
    const patch = fc.record(
      {
        state: fc.constantFrom(...ISSUE_STATES),
        stateReason: fc.constantFrom(...ISSUE_STATE_REASONS),
        duplicateOf: fc.integer({ min: 1, max: 9 }),
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(fields, patch, (current, change) => {
        const plan = planIssueState(current, change, at);
        if (!plan.ok) return;
        const next = plan.next;
        expect(next.duplicateOf !== null).toBe(
          next.state === "closed" && next.stateReason === "duplicate",
        );
        if (next.duplicateOf !== null) expect(next.duplicateOf).not.toBe(at.number);
        if (next.state === "open") {
          expect([null, "reopened"]).toContain(next.stateReason);
          expect(next.closedAt).toBeNull();
          expect(next.closedBy).toBeNull();
        } else {
          expect(["completed", "not_planned", "duplicate"]).toContain(next.stateReason);
          expect(next.closedAt).not.toBeNull();
        }
        if (plan.action === null) expect(next).toEqual(current);
      }),
    );
  });
});
