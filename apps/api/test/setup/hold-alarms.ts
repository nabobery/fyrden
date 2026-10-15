// Every test file runs the isolate's clock a day ahead, from before its
// `beforeAll` (so what it sets up there shares the clock), so no Durable
// Object alarm (an outbox drain a second after a change, a job's next slice)
// fires on its own while it runs: whatever a test reads stays as its own steps
// left it, however slowly the run goes, and a test that wants an alarm runs it
// (`runDurableObjectAlarm`, or the object's `alarm()`). Only `Date` is faked;
// timers still run in real time. A test may set the clock itself; the next one
// starts on the held clock again, whatever it was left as.
import { beforeEach, vi } from "vitest";

/** How far ahead of real time every test's clock runs. */
export const CLOCK_AHEAD_MS = 24 * 60 * 60 * 1000;

/** Installs the held clock: a day ahead of real time, advancing a millisecond at a time. */
export function holdAlarms(): void {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true, advanceTimeDelta: 1 });
  vi.setSystemTime(vi.getRealSystemTime() + CLOCK_AHEAD_MS);
}

holdAlarms();
beforeEach(holdAlarms);
