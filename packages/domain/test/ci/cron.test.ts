// Five-field cron in UTC, the next occurrence after a time, and schedule
// spacing. Times are numbers built with Date.UTC; nothing reads the clock.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Cron, cronMatches, cronNext, nextTick, parseCron } from "../../src/ci/cron.js";

const MINUTE = 60_000;
const utc = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function cronOf(text: string): Cron {
  const parsed = parseCron(text);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.cron;
}

function messageOf(text: string): string {
  const parsed = parseCron(text);
  if (parsed.ok) throw new Error(`${text} parsed`);
  return parsed.message;
}

/** The next `n` occurrences after `from`. */
function sequence(text: string, from: number, n: number): (string | null)[] {
  const cron = cronOf(text);
  const out: (string | null)[] = [];
  let t: number | null = from;
  for (let i = 0; i < n && t !== null; i++) {
    t = cronNext(cron, t);
    out.push(iso(t));
  }
  return out;
}

describe("parseCron: fields", () => {
  it("reads values, lists, ranges and steps", () => {
    expect(sequence("5,10 1-2 * * *", utc(2026, 1, 1), 5)).toEqual([
      "2026-01-01T01:05:00.000Z",
      "2026-01-01T01:10:00.000Z",
      "2026-01-01T02:05:00.000Z",
      "2026-01-01T02:10:00.000Z",
      "2026-01-02T01:05:00.000Z",
    ]);
    expect(sequence("*/20 0 * * *", utc(2026, 1, 1), 3)).toEqual([
      "2026-01-01T00:20:00.000Z",
      "2026-01-01T00:40:00.000Z",
      "2026-01-02T00:00:00.000Z",
    ]);
    expect(sequence("10-30/10 3 * * *", utc(2026, 1, 1), 4)).toEqual([
      "2026-01-01T03:10:00.000Z",
      "2026-01-01T03:20:00.000Z",
      "2026-01-01T03:30:00.000Z",
      "2026-01-02T03:10:00.000Z",
    ]);
  });

  it("reads month and day names in any case", () => {
    // 2026-03-02 is a Monday.
    expect(sequence("0 0 * mar mon-Wed", utc(2026, 3, 1), 4)).toEqual([
      "2026-03-02T00:00:00.000Z",
      "2026-03-03T00:00:00.000Z",
      "2026-03-04T00:00:00.000Z",
      "2026-03-09T00:00:00.000Z",
    ]);
    expect(sequence("0 0 1 JAN,jul *", utc(2026, 2, 1), 2)).toEqual([
      "2026-07-01T00:00:00.000Z",
      "2027-01-01T00:00:00.000Z",
    ]);
  });

  it("reads 0 and 7 as Sunday", () => {
    // 2026-01-04 is a Sunday.
    const sundays = ["2026-01-04T00:00:00.000Z", "2026-01-11T00:00:00.000Z"];
    expect(sequence("0 0 * * 7", utc(2026, 1, 1), 2)).toEqual(sundays);
    expect(sequence("0 0 * * 0", utc(2026, 1, 1), 2)).toEqual(sundays);
    expect(sequence("0 0 * * 5-7", utc(2026, 1, 1), 3)).toEqual([
      "2026-01-02T00:00:00.000Z",
      "2026-01-03T00:00:00.000Z",
      "2026-01-04T00:00:00.000Z",
    ]);
  });

  it("matches either day field when both are restricted", () => {
    // The 13th, or any Friday: 2026-02-06 and 2026-02-13 (a Friday too), 2026-02-20.
    expect(sequence("0 0 13 * 5", utc(2026, 2, 1), 4)).toEqual([
      "2026-02-06T00:00:00.000Z",
      "2026-02-13T00:00:00.000Z",
      "2026-02-20T00:00:00.000Z",
      "2026-02-27T00:00:00.000Z",
    ]);
    // Day of month only, when day of week is `*`.
    expect(sequence("0 0 13 * *", utc(2026, 2, 1), 2)).toEqual([
      "2026-02-13T00:00:00.000Z",
      "2026-03-13T00:00:00.000Z",
    ]);
  });

  it("finds a 29 February", () => {
    expect(sequence("0 0 29 2 *", utc(2026, 1, 1), 2)).toEqual([
      "2028-02-29T00:00:00.000Z",
      "2032-02-29T00:00:00.000Z",
    ]);
  });

  it("steps from a single value through the field's maximum (GitHub's 20/15)", () => {
    const parsed = parseCron("20/15 * * * *");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const hour = Date.UTC(2026, 0, 1, 5, 0);
    const minutes = [];
    for (let m = 0; m < 60; m++) if (cronMatches(parsed.cron, hour + m * 60_000)) minutes.push(m);
    expect(minutes).toEqual([20, 35, 50]);
  });

  it("accepts surrounding and repeated spaces", () => {
    expect(parseCron("  0   5 * * 1-5 ").ok).toBe(true);
  });

  it.each([
    ["61 * * * *", /minute/],
    ["* 24 * * *", /hour/],
    ["* * 0 * *", /day of month/],
    ["* * 32 * *", /day of month/],
    ["* * * 13 *", /month/],
    ["* * * * 8", /day of week/],
    ["* * * * * *", /five fields/],
    ["* * * *", /five fields/],
    ["*/0 * * * *", /step/],
    ["30-10 * * * *", /range/],
    ["* * * mon *", /month/],
    ["* * * * jan", /day of week/],
    ["a * * * *", /minute/],
    ["1,,2 * * * *", /minute/],
    ["@daily", /five fields/],
    ["", /five fields/],
  ])("refuses %j", (text, message) => {
    expect(messageOf(text)).toMatch(message);
  });

  it.each(["0 0 30 2 *", "0 0 31 4,6,9,11 *", "0 0 30,31 feb *"])(
    "refuses %j, which never matches",
    (text) => {
      expect(messageOf(text)).toMatch(/never/);
    },
  );

  it("accepts an impossible day of month when day of week can match", () => {
    expect(parseCron("0 0 30 2 1").ok).toBe(true);
  });
});

describe("cronNext", () => {
  it("is strictly after the given time", () => {
    const cron = cronOf("0 12 * * *");
    expect(iso(cronNext(cron, utc(2026, 1, 1, 12)))).toBe("2026-01-02T12:00:00.000Z");
    expect(iso(cronNext(cron, utc(2026, 1, 1, 11, 59) + 59_999))).toBe("2026-01-01T12:00:00.000Z");
  });

  it("gives up after five years", () => {
    // 2096-03-01 to the next 29 February (2104: 2100 is not a leap year) is over five years.
    expect(cronNext(cronOf("0 0 29 2 *"), utc(2096, 3, 1))).toBeNull();
  });
});

describe("nextTick: spacing", () => {
  const FIVE = 5 * MINUTE;

  it("runs */5 at 12:00, 12:05 and 12:10 exactly", () => {
    const cron = cronOf("*/5 * * * *");
    let last: number | null = null;
    let now = utc(2026, 1, 1, 11, 58);
    const fired: (string | null)[] = [];
    for (let i = 0; i < 3; i++) {
      const tick = nextTick(cron, now, last, FIVE);
      fired.push(iso(tick));
      if (tick === null) break;
      last = tick;
      now = tick;
    }
    expect(fired).toEqual([
      "2026-01-01T12:00:00.000Z",
      "2026-01-01T12:05:00.000Z",
      "2026-01-01T12:10:00.000Z",
    ]);
  });

  it("runs * * * * * every five minutes", () => {
    const cron = cronOf("* * * * *");
    let last: number | null = null;
    let now = utc(2026, 1, 1, 12);
    const fired: (string | null)[] = [];
    for (let i = 0; i < 3; i++) {
      const tick = nextTick(cron, now, last);
      fired.push(iso(tick));
      if (tick === null) break;
      last = tick;
      now = tick;
    }
    expect(fired).toEqual([
      "2026-01-01T12:01:00.000Z",
      "2026-01-01T12:06:00.000Z",
      "2026-01-01T12:11:00.000Z",
    ]);
  });

  it("takes the first occurrence after now when the spacing has passed", () => {
    const cron = cronOf("*/5 * * * *");
    // Fired at 12:00, woken late at 12:31: the next tick is 12:35, nothing is replayed.
    expect(iso(nextTick(cron, utc(2026, 1, 1, 12, 31), utc(2026, 1, 1, 12), FIVE))).toBe(
      "2026-01-01T12:35:00.000Z",
    );
  });
});

// Property suite: generated crons, rendered to text, checked against the
// generated sets directly rather than against the parser's own reading.
interface Spec {
  minutes: number[];
  hours: number[];
  doms: number[] | null;
  months: number[] | null;
  dows: number[] | null;
}

const set = (min: number, max: number, maxLength: number) =>
  fc
    .uniqueArray(fc.integer({ min, max }), { minLength: 1, maxLength })
    .map((a) => a.sort((x, y) => x - y));

const specs: fc.Arbitrary<Spec> = fc.record({
  minutes: set(0, 59, 6),
  hours: set(0, 23, 6),
  doms: fc.option(set(1, 28, 4), { nil: null }),
  months: fc.option(set(1, 12, 4), { nil: null }),
  dows: fc.option(set(0, 6, 3), { nil: null }),
});

const textOf = (s: Spec) =>
  [s.minutes, s.hours, s.doms, s.months, s.dows].map((f) => (f ? f.join(",") : "*")).join(" ");

function specMatches(s: Spec, ms: number): boolean {
  const d = new Date(ms);
  const day =
    s.doms && s.dows
      ? s.doms.includes(d.getUTCDate()) || s.dows.includes(d.getUTCDay())
      : (!s.doms || s.doms.includes(d.getUTCDate())) && (!s.dows || s.dows.includes(d.getUTCDay()));
  return (
    s.minutes.includes(d.getUTCMinutes()) &&
    s.hours.includes(d.getUTCHours()) &&
    (!s.months || s.months.includes(d.getUTCMonth() + 1)) &&
    day
  );
}

/** Any millisecond from 2020 to 2040. */
const times = fc.integer({ min: utc(2020, 1, 1), max: utc(2040, 1, 1) });
/** How far the brute-force check walks, minute by minute. */
const WINDOW = 3 * 24 * 60;

describe("cronNext: properties", () => {
  it("is after t, matches, and nothing matches strictly between", () => {
    fc.assert(
      fc.property(specs, times, (spec, t) => {
        const cron = cronOf(textOf(spec));
        const next = cronNext(cron, t);
        // Day fields drawn from 1-28 match within five years.
        expect(next).not.toBeNull();
        if (next === null) return;
        expect(next).toBeGreaterThan(t);
        expect(next % MINUTE).toBe(0);
        expect(specMatches(spec, next)).toBe(true);
        expect(cronMatches(cron, next)).toBe(true);
        const first = Math.floor(t / MINUTE) * MINUTE + MINUTE;
        const end = Math.min(next, first + WINDOW * MINUTE);
        for (let m = first; m < end; m += MINUTE) expect(specMatches(spec, m)).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it("parses every generated cron", () => {
    fc.assert(fc.property(specs, (spec) => parseCron(textOf(spec)).ok));
  });

  it("spaces ticks at least the spacing apart and after now", () => {
    fc.assert(
      fc.property(specs, times, fc.integer({ min: 0, max: 60 }), (spec, now, back) => {
        const cron = cronOf(textOf(spec));
        const last = Math.floor(now / MINUTE) * MINUTE - back * MINUTE;
        const tick = nextTick(cron, now, last, 5 * MINUTE);
        if (tick === null) return;
        expect(tick).toBeGreaterThan(now);
        expect(tick).toBeGreaterThanOrEqual(last + 5 * MINUTE);
        expect(specMatches(spec, tick)).toBe(true);
      }),
    );
  });
});
