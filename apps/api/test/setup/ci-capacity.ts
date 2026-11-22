// Runs and accounts read CI's configuration from their own env, which a
// request's overrides never reach, so the test env (Free) runs as on Paid
// unless a test sets `ciVariableOverrides`.
import { beforeEach } from "vitest";
import { ciVariableOverrides } from "../../src/ci/budget.js";

beforeEach(() => {
  for (const name of Object.keys(ciVariableOverrides) as (keyof typeof ciVariableOverrides)[])
    delete ciVariableOverrides[name];
  ciVariableOverrides.FYRDEN_PLAN = "paid";
});
