// A feed alarm's admission of whole units of work: each counter on its own,
// what the invocation made plus the full ceilings of what still runs plus
// the unit asked for, within the alarm's ceilings; a refused unit changes
// nothing; a reservation holds until its physical work ends.

import { SubrequestTally } from "@fyrden/adapters-cloudflare/obs";
import { describe, expect, it } from "vitest";
import { ALARM_LIMITS, ALARM_UNITS, AlarmBudget } from "../src/do/user/alarm-budget.js";

describe("a feed alarm's budget", () => {
  it("admits a unit only whole, every counter within its ceiling, and refuses without a change", () => {
    const tally = new SubrequestTally();
    const budget = new AlarmBudget(tally);
    // Its D1 statements nearly spent: an email candidate (16) no longer fits, a renewal (3) does.
    tally.d1 = ALARM_LIMITS.d1 - 4;
    expect(budget.reserve("email")).toBeNull();
    const renewal = budget.reserve("renewal");
    expect(renewal).not.toBeNull();
    // The renewal holds 3 of the 4 left: a mandatory step (4) waits for it.
    expect(budget.reserve("mandatory")).toBeNull();
    renewal?.physicalComplete();
    expect(budget.reserve("mandatory")).not.toBeNull();
  });

  it("admits a unit with the grant it needs together, or neither", () => {
    const tally = new SubrequestTally();
    const budget = new AlarmBudget(tally);
    tally.d1 = ALARM_LIMITS.d1 - ALARM_UNITS.renewal.d1 - ALARM_UNITS.grant.d1 + 1;
    expect(budget.reserve("renewal", "grant")).toBeNull();
    // Nothing was held by the refusal: the renewal alone still fits.
    expect(budget.reserve("renewal")).not.toBeNull();
  });

  it("refuses by external fetches alone", () => {
    const tally = new SubrequestTally();
    const budget = new AlarmBudget(tally);
    tally.external = ALARM_LIMITS.external;
    expect(budget.reserve("email")).toBeNull();
    expect(budget.reserve("pump")).not.toBeNull();
  });

  it("holds a reservation until its physical work ends, once, the work made still counted", () => {
    const tally = new SubrequestTally();
    const budget = new AlarmBudget(tally, { d1: 20, internal: 20, external: 1 });
    const email = budget.reserve("email");
    expect(email).not.toBeNull();
    // Its result given up on, its work still running: the next candidate does not fit.
    expect(budget.reserve("email")).toBeNull();
    // The work ends having made 10 statements: its reservation goes, what it made stays.
    tally.d1 += 10;
    email?.physicalComplete();
    email?.physicalComplete();
    expect(budget.reserve("pump")).not.toBeNull();
    expect(budget.reserve("pump")).toBeNull();
  });

  it("keeps every unit within the alarm's ceilings on its own", () => {
    for (const [unit, cost] of Object.entries(ALARM_UNITS))
      for (const counter of ["d1", "internal", "external"] as const)
        expect(cost[counter], `${unit} ${counter}`).toBeLessThanOrEqual(ALARM_LIMITS[counter]);
  });
});
