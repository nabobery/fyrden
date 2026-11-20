// The test env is Free, and runs and accounts read CI's configuration from
// their own env, which a request's overrides never reach. So every test's
// runs pay for their jobs as on Paid (minutes recorded in the account, no
// quota; no daily ledger, no timeout clamp) unless it sets Free's variables
// in `ciVariableOverrides`, as the reservation tests do.
import { beforeEach } from "vitest";
import { ciVariableOverrides } from "../../src/ci/budget.js";

beforeEach(() => {
  for (const name of Object.keys(ciVariableOverrides) as (keyof typeof ciVariableOverrides)[])
    delete ciVariableOverrides[name];
  ciVariableOverrides.FYRDEN_PLAN = "paid";
});
