import { DEFAULT_JOB_POLICY } from "@fyrden/adapters-cloudflare/git";
import { describe, expect, it } from "vitest";
import { EFFECT_POLICY, effectPolicy } from "../src/effects/journal.js";
import {
  CONSUMER_MARGIN,
  consumerCalls,
  FREE_INTERNAL_CALLS,
  internalCallLimit,
  jobPolicy,
  MAX_INTERNAL_CALLS,
  SLICE_CALLS,
} from "../src/invocation-calls.js";
import { INVOCATION_CALLS } from "../src/queues/events-consumer.js";

describe("the internal calls an invocation may make", () => {
  it("are Free's 1,000 on Free, whatever the variable says", () => {
    expect(internalCallLimit({})).toBe(FREE_INTERNAL_CALLS);
    expect(internalCallLimit({ FYRDEN_PLAN: "free" })).toBe(1_000);
    expect(internalCallLimit({ FYRDEN_PLAN: "free", FYRDEN_INTERNAL_CALLS: "5000" })).toBe(1_000);
    expect(internalCallLimit({ FYRDEN_INTERNAL_CALLS: "5000" })).toBe(1_000);
  });

  it("are 1,000 on Paid until the deployment sets more", () => {
    expect(internalCallLimit({ FYRDEN_PLAN: "paid" })).toBe(1_000);
    expect(internalCallLimit({ FYRDEN_PLAN: "paid", FYRDEN_INTERNAL_CALLS: "10000" })).toBe(10_000);
    expect(internalCallLimit({ FYRDEN_PLAN: "paid", FYRDEN_INTERNAL_CALLS: 2_500 })).toBe(2_500);
    expect(
      internalCallLimit({ FYRDEN_PLAN: "paid", FYRDEN_INTERNAL_CALLS: String(MAX_INTERNAL_CALLS) }),
    ).toBe(MAX_INTERNAL_CALLS);
  });

  it("ignore a Paid value that is not a whole number from 1,000 to 10,000,000", () => {
    for (const bad of [
      "999",
      "0",
      "-5000",
      "1e4",
      "2500.5",
      "",
      " 5000",
      "lots",
      "10000001",
      null,
    ]) {
      expect(internalCallLimit({ FYRDEN_PLAN: "paid", FYRDEN_INTERNAL_CALLS: bad })).toBe(1_000);
    }
  });

  it("leave a job slice its calls: the queue starts none past the limit less a slice's", () => {
    expect(jobPolicy({})).toEqual({ ...DEFAULT_JOB_POLICY, maxInternalCalls: 1_000 - SLICE_CALLS });
    expect(DEFAULT_JOB_POLICY.maxInternalCalls).toBe(1_000 - SLICE_CALLS);
    const paid = { FYRDEN_PLAN: "paid", FYRDEN_INTERNAL_CALLS: "10000" };
    expect(jobPolicy(paid).maxInternalCalls).toBe(10_000 - SLICE_CALLS);
  });

  it("size the queue consumers' share by the limit", () => {
    expect(consumerCalls({})).toBe(1_000 - CONSUMER_MARGIN);
    expect(INVOCATION_CALLS).toBe(consumerCalls({}));
    expect(EFFECT_POLICY.invocation.calls).toBe(consumerCalls({}));
    expect(consumerCalls({ FYRDEN_PLAN: "paid", FYRDEN_INTERNAL_CALLS: "10000" })).toBe(
      10_000 - CONSUMER_MARGIN,
    );
  });
});

describe("the effects consumer's policy", () => {
  it("takes its invocation's calls from the deployment", () => {
    expect(effectPolicy({})).toEqual(EFFECT_POLICY);
    const paid = effectPolicy({ FYRDEN_PLAN: "paid", FYRDEN_INTERNAL_CALLS: "4000" });
    expect(paid.invocation).toEqual({
      ...EFFECT_POLICY.invocation,
      calls: 4_000 - CONSUMER_MARGIN,
    });
  });
});
