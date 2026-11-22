// `fyrden deploy` refuses CI settings a Free deployment cannot hold from its
// own copy of the API's numbers (packages/cli/src/ci-capacity.ts): the copy
// must give the ceiling the API clamps its allowance to.
import { describe, expect, it } from "vitest";
import {
  CI_DAILY_RESOURCES,
  CI_FREE_FLEET,
  ciDailyCeiling,
  fleetReservation as cliFleetReservation,
} from "../../../packages/cli/src/ci-capacity.js";
import {
  CI_FREE_FLEET as API_FREE_FLEET,
  CI_RESOURCES,
  ciAllowance,
  fleetReservation,
} from "../src/ci/budget.js";

/** An allowance asking more than any ceiling, so the API's answer is its ceiling. */
const everything = CI_RESOURCES.map((r) => `${r}=999999999999`).join(",");

describe("the deploy's copy of CI's Free capacity", () => {
  it("names the API's resources and default fleet", () => {
    expect([...CI_DAILY_RESOURCES]).toEqual([...CI_RESOURCES]);
    expect(CI_FREE_FLEET).toBe(API_FREE_FLEET);
  });

  for (const fleet of [0, 1, 2, 4, 7])
    it(`reserves what the API reserves for a fleet of ${fleet}`, () => {
      expect(cliFleetReservation(fleet)).toEqual(fleetReservation(fleet));
    });

  for (const [fleet, discretionary] of [
    [2, undefined],
    [0, undefined],
    [4, "do_requests=10000,d1_rows_read=4000000"],
    [1, "queue_ops=10000,do_duration_ms=999999999999"],
  ] as const)
    it(`gives the API's ceiling for a fleet of ${fleet}, discretionary ${discretionary ?? "unset"}`, () => {
      const api = ciAllowance({
        FYRDEN_CI_FLEET: String(fleet),
        FYRDEN_CI_DAILY: everything,
        ...(discretionary !== undefined && { FYRDEN_DISCRETIONARY_DAILY: discretionary }),
      });
      const cli = ciDailyCeiling(fleet, discretionary);
      expect(
        Object.fromEntries(CI_DAILY_RESOURCES.map((r) => [r, Math.floor(Math.max(0, cli[r]))])),
      ).toEqual(api);
    });
});
