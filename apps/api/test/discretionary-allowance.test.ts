import { describe, expect, it } from "vitest";
import {
  DISCRETIONARY_RESOURCES,
  discretionaryAllowance,
  FREE_DAILY,
} from "../src/effects/discretionary.js";

describe("the discretionary allowance", () => {
  it("is a fifth of each of Free's daily limits on Free when nothing is set", () => {
    const allowance = discretionaryAllowance({});
    expect(allowance).toEqual({
      do_requests: 20_000,
      do_rows_read: 1_000_000,
      do_rows_written: 20_000,
      do_duration_ms: 20_312_500,
      d1_rows_read: 1_000_000,
      d1_rows_written: 20_000,
      queue_ops: 2_000,
    });
    for (const resource of DISCRETIONARY_RESOURCES)
      expect(allowance?.[resource]).toBe(FREE_DAILY[resource] / 5);
  });

  it("takes set values on Free, each clamped to Free's limit, the others at their default", () => {
    expect(
      discretionaryAllowance({
        FYRDEN_DISCRETIONARY_DAILY: "do_rows_written=5000, queue_ops=50000,do_requests=0",
      }),
    ).toMatchObject({
      do_rows_written: 5_000,
      queue_ops: FREE_DAILY.queue_ops,
      do_requests: 0,
      d1_rows_written: 20_000,
    });
  });

  it("caps nothing on Paid unless set, and only what is set", () => {
    expect(discretionaryAllowance({ FYRDEN_PLAN: "paid" })).toBeNull();
    expect(
      discretionaryAllowance({
        FYRDEN_PLAN: "paid",
        FYRDEN_DISCRETIONARY_DAILY: "do_rows_written=2000000",
      }),
    ).toEqual({
      do_requests: null,
      do_rows_read: null,
      do_rows_written: 2_000_000,
      do_duration_ms: null,
      d1_rows_read: null,
      d1_rows_written: null,
      queue_ops: null,
    });
  });

  it("ignores a variable it cannot read whole, as unset (the deploy command checks it)", () => {
    for (const bad of [
      "do_rows_written=",
      "do_rows_written=1e4",
      "do_rows_written=-1",
      "rows=5",
      "do_rows_written=5;queue_ops=1",
      "do_rows_written=5,do_rows_written=6",
    ]) {
      expect(discretionaryAllowance({ FYRDEN_DISCRETIONARY_DAILY: bad }), bad).toEqual(
        discretionaryAllowance({}),
      );
      expect(
        discretionaryAllowance({ FYRDEN_PLAN: "paid", FYRDEN_DISCRETIONARY_DAILY: bad }),
        bad,
      ).toBeNull();
    }
  });
});
