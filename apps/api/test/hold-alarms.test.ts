// The held clock every workerd test starts on: a day ahead of real time,
// whatever the clock was left as (real timers, a frozen Date-only clock, a
// system time set elsewhere).
import { describe, expect, it, vi } from "vitest";
import { CLOCK_AHEAD_MS, holdAlarms } from "./setup/hold-alarms.js";

function expectHeld(): void {
  const ahead = Date.now() - vi.getRealSystemTime();
  expect(ahead).toBeGreaterThan(CLOCK_AHEAD_MS - 60_000);
  expect(ahead).toBeLessThan(CLOCK_AHEAD_MS + 60_000);
}

describe("the held clock", () => {
  it("is in place when a test starts", () => {
    expectHeld();
  });

  it("is put back after real timers", () => {
    vi.useRealTimers();
    holdAlarms();
    expectHeld();
  });

  it("is put back after a frozen clock", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000);
    holdAlarms();
    expectHeld();
  });

  it("is put back after a system time set behind real time", () => {
    vi.setSystemTime(vi.getRealSystemTime() - CLOCK_AHEAD_MS);
    holdAlarms();
    expectHeld();
  });
});
