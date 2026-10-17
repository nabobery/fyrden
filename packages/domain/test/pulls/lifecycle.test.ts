import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { atLeast, REPO_ROLES } from "../../src/authz/roles.js";
import {
  decidePullAction,
  PULL_ACTION_RULES,
  PULL_ACTIONS,
  type PullAction,
} from "../../src/pulls/lifecycle.js";
import { PULL_STATES } from "../../src/pulls/pull.js";

const open = { state: "open", headRefDeleted: false } as const;

describe("decidePullAction", () => {
  it.each([
    // [action, isAuthor, role, allowed]
    ["close", true, "read", true],
    ["close", false, "read", false],
    ["close", false, "triage", true],
    ["reopen", false, "triage", false], // open already
    ["edit", true, "read", true],
    ["edit", false, "triage", false],
    ["edit", false, "write", true],
    ["retarget", true, "read", true],
    ["retarget", false, "triage", false],
    ["retarget", false, "write", true],
    ["convert_to_draft", false, "triage", false],
    ["ready_for_review", false, "maintain", true],
    ["merge", true, "triage", false],
    ["merge", false, "write", true],
  ] as const)("%s by author=%s with %s: %s", (action, isAuthor, role, allowed) => {
    expect(decidePullAction(action, { ...open, isAuthor, role }).ok).toBe(allowed);
  });

  it("never lets anyone without a role act, the author included", () => {
    for (const action of PULL_ACTIONS)
      expect(decidePullAction(action, { ...open, isAuthor: true, role: null })).toEqual({
        ok: false,
        refusal: "forbidden",
      });
  });

  it("reopens a closed pull request only while its head branch exists", () => {
    const closed = { state: "closed", isAuthor: true, role: "read" } as const;
    expect(decidePullAction("reopen", { ...closed, headRefDeleted: false }).ok).toBe(true);
    expect(decidePullAction("reopen", { ...closed, headRefDeleted: true })).toEqual({
      ok: false,
      refusal: "head_ref_deleted",
    });
  });

  it("leaves a merged pull request alone except for its title and body", () => {
    for (const action of PULL_ACTIONS) {
      const decision = decidePullAction(action, {
        state: "merged",
        headRefDeleted: false,
        isAuthor: true,
        role: "admin",
      });
      expect(decision.ok).toBe(action === "edit");
    }
  });

  it("allows exactly what the matrix says, for any input", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PULL_ACTIONS),
        fc.constantFrom(...PULL_STATES),
        fc.boolean(),
        fc.boolean(),
        fc.constantFrom(null, ...REPO_ROLES),
        (action: PullAction, state, headRefDeleted, isAuthor, role) => {
          const rule = PULL_ACTION_RULES[action];
          const expected =
            role !== null &&
            ((rule.author && isAuthor) || (rule.minRole !== null && atLeast(role, rule.minRole))) &&
            rule.from.includes(state) &&
            !(action === "reopen" && headRefDeleted);
          const decision = decidePullAction(action, { state, headRefDeleted, isAuthor, role });
          expect(decision.ok).toBe(expected);
          // Stronger roles never lose a permission a weaker one has.
          if (decision.ok && role !== null)
            for (const stronger of REPO_ROLES.slice(REPO_ROLES.indexOf(role)))
              expect(
                decidePullAction(action, { state, headRefDeleted, isAuthor, role: stronger }).ok,
              ).toBe(true);
        },
      ),
    );
  });
});
