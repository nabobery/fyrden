// What a download answers, from its request's conditions and range, worked
// out before anything is read: RFC 9110's order, with the one strict choice
// that `If-Range` takes an ETag only.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { downloadPlan } from "../src/http/range.js";

const ETAG = '"01JAAAAAAAAAAAAAAAAAAAAAAA"';
// With milliseconds, as a stored time has; the `Last-Modified` it answers holds whole seconds.
const LAST_MODIFIED = Date.UTC(2026, 10, 7, 12, 0, 0, 500);
const SAME_SECOND = "Sat, 07 Nov 2026 12:00:00 GMT";
const SECOND_BEFORE = "Sat, 07 Nov 2026 11:59:59 GMT";
const SECOND_AFTER = "Sat, 07 Nov 2026 12:00:01 GMT";
const NOW = Date.UTC(2026, 10, 7, 13);
const SIZE = 1000;

function plan(headers: Record<string, string>, method = "GET", size = SIZE) {
  return downloadPlan({ method, headers: new Headers(headers) }, resource(size), NOW);
}
const resource = (size: number) => ({ etag: ETAG, lastModified: LAST_MODIFIED, size });
const partial = (offset: number, length: number, size = SIZE) => ({
  status: 206,
  offset,
  length,
  contentRange: `bytes ${offset}-${offset + length - 1}/${size}`,
});
const UNSATISFIABLE = { status: 416, contentRange: `bytes */${SIZE}` };

describe("the conditions", () => {
  it("answers the whole file with none", () => {
    expect(plan({})).toEqual({ status: 200 });
    expect(plan({}, "HEAD")).toEqual({ status: 200 });
  });

  it.each([
    ["the ETag", ETAG, 200],
    ["any", "*", 200],
    ["one of a list", `"other", ${ETAG}`, 200],
    ["another", '"other"', 412],
    ["the weak form, which a strong comparison never matches", `W/${ETAG}`, 412],
    ["nothing usable", "", 412],
  ])("If-Match with %s", (_what, value, status) => {
    expect(plan({ "If-Match": value }).status).toBe(status);
  });

  it.each([
    [SECOND_BEFORE, 412],
    [SAME_SECOND, 200],
    [SECOND_AFTER, 200],
    ["not a date", 200],
  ])("If-Unmodified-Since %s", (value, status) => {
    expect(plan({ "If-Unmodified-Since": value }).status).toBe(status);
  });

  it("reads If-Unmodified-Since only without If-Match", () => {
    expect(plan({ "If-Match": ETAG, "If-Unmodified-Since": SECOND_BEFORE }).status).toBe(200);
  });

  it.each([
    ["the ETag", ETAG, 304],
    ["its weak form, which a weak comparison matches", `W/${ETAG}`, 304],
    ["any", "*", 304],
    ["one of a list", `"other", ${ETAG}`, 304],
    ["another", '"other"', 200],
  ])("If-None-Match with %s", (_what, value, status) => {
    expect(plan({ "If-None-Match": value }).status).toBe(status);
    expect(plan({ "If-None-Match": value }, "HEAD").status).toBe(status);
  });

  it.each([
    [SECOND_BEFORE, 200],
    [SAME_SECOND, 304],
    [SECOND_AFTER, 304],
    ["not a date", 200],
    ["2030", 200],
  ])("If-Modified-Since %s", (value, status) => {
    expect(plan({ "If-Modified-Since": value }).status).toBe(status);
  });

  it("reads If-Modified-Since only without If-None-Match", () => {
    expect(plan({ "If-None-Match": '"other"', "If-Modified-Since": SECOND_AFTER }).status).toBe(
      200,
    );
  });

  it("takes the three forms of a date, and refuses a date that doesn't exist", () => {
    for (const form of [
      SAME_SECOND,
      "Saturday, 07-Nov-26 12:00:00 GMT",
      "Sat Nov  7 12:00:00 2026",
    ]) {
      expect(plan({ "If-Modified-Since": form }).status, form).toBe(304);
    }
    expect(plan({ "If-Modified-Since": "Sat, 31 Feb 2030 12:00:00 GMT" }).status).toBe(200);
    expect(plan({ "If-Modified-Since": "Sat, 07 Nov 2030 25:00:00 GMT" }).status).toBe(200);
    expect(plan({ "If-Modified-Since": "Sat, 07 Nov 2030 12:60:00 GMT" }).status).toBe(200);
    expect(plan({ "If-Modified-Since": "Sat, 07 Nov 2030 12:00:60 GMT" }).status).toBe(200);
    expect(plan({ "If-Modified-Since": "Sat, 07 Foo 2030 12:00:00 GMT" }).status).toBe(200);
  });

  it("reads a two-digit year as within 50 years of now", () => {
    // 76 is 2076, exactly 50 years on; 77 would be more, so it is 1977.
    expect(plan({ "If-Modified-Since": "Sunday, 01-Jan-76 00:00:00 GMT" }).status).toBe(304);
    expect(plan({ "If-Modified-Since": "Saturday, 01-Jan-77 00:00:00 GMT" }).status).toBe(200);
  });

  it("cuts a two-digit year off at the moment 50 years on, not at its year", () => {
    // December 2076 is past 7 November 2076, so this is 1976.
    expect(plan({ "If-Unmodified-Since": "Friday, 31-Dec-76 23:59:59 GMT" }).status).toBe(412);
    // January 2076 isn't, so this one is ahead of the file.
    expect(plan({ "If-Unmodified-Since": "Wednesday, 01-Jan-76 00:00:00 GMT" }).status).toBe(200);
  });

  it("takes a leap second, and no other 60", () => {
    expect(plan({ "If-Unmodified-Since": "Sat, 31 Dec 2016 23:59:60 GMT" }).status).toBe(412);
    expect(plan({ "If-Unmodified-Since": "Sat, 31 Dec 2016 22:59:60 GMT" }).status).toBe(200);
    expect(plan({ "If-Unmodified-Since": "Sat, 31 Dec 2016 23:58:60 GMT" }).status).toBe(200);
  });

  it("reads a two-digit year forward over a century's end", () => {
    const later = (date: string) =>
      downloadPlan(
        { method: "GET", headers: new Headers({ "If-Modified-Since": date }) },
        { etag: ETAG, lastModified: Date.UTC(2050, 0, 1), size: SIZE },
        Date.UTC(2099, 0, 1),
      ).status;
    // In 2099, 01 is 2101, not a century and a half ago.
    expect(later("Saturday, 01-Jan-01 00:00:00 GMT")).toBe(304);
  });

  it("finds a two-digit leap day in the last century that had one", () => {
    const answer = downloadPlan(
      {
        method: "GET",
        headers: new Headers({ "If-Unmodified-Since": "Tuesday, 29-Feb-00 00:00:00 GMT" }),
      },
      { etag: ETAG, lastModified: Date.UTC(2001, 0, 1), size: SIZE },
      Date.UTC(2200, 0, 1),
    );
    // 2300, 2200 and 2100 have no 29 February, so this is 2000.
    expect(answer.status).toBe(412);
  });

  it("checks in RFC 9110's order: a failed If-Match beats a matching If-None-Match and a range", () => {
    expect(plan({ "If-Match": '"other"', "If-None-Match": ETAG, Range: "bytes=0-1" }).status).toBe(
      412,
    );
    expect(plan({ "If-None-Match": ETAG, Range: "bytes=0-1" }).status).toBe(304);
    expect(plan({ "If-None-Match": ETAG, Range: "bytes=5000-" }).status).toBe(304);
  });
});

describe("a range", () => {
  it.each([
    ["bytes=0-0", partial(0, 1)],
    ["bytes=10-19", partial(10, 10)],
    ["bytes=990-", partial(990, 10)],
    ["bytes=990-5000", partial(990, 10)],
    ["bytes=0-999", partial(0, 1000)],
    ["bytes=-10", partial(990, 10)],
    ["bytes=-5000", partial(0, 1000)],
    ["BYTES=10-19", partial(10, 10)],
    ["bytes=0-99999999999999999999999", partial(0, 1000)],
    ["bytes=010-0019", partial(10, 10)],
  ])("%s", (value, expected) => {
    expect(plan({ Range: value })).toEqual(expected);
  });

  it.each(["bytes=1000-", "bytes=1000-1001", "bytes=-0", "bytes=99999999999999999999999-"])(
    "%s can't be satisfied",
    (value) => {
      expect(plan({ Range: value })).toEqual(UNSATISFIABLE);
    },
  );

  it("can't be satisfied on an empty file, so a read of nothing is never asked for", () => {
    expect(plan({ Range: "bytes=-5" }, "GET", 0)).toEqual({
      status: 416,
      contentRange: "bytes */0",
    });
  });

  it.each([
    "items=0-1",
    "bytes=",
    "bytes=-",
    "bytes=a-b",
    "bytes=5-1",
    "bytes=9007199254740993-9007199254740992",
    `bytes=${"9".repeat(400)}-${"8".repeat(400)}`,
    "bytes=10-009",
    "bytes=0-1,5-6",
    "bytes=0-1, 5-6",
    "bytes= 0-1",
    "bytes=-1-2",
    "bytes=1.5-2",
  ])("%s is ignored: the whole file", (value) => {
    expect(plan({ Range: value })).toEqual({ status: 200 });
  });

  it("is ignored on HEAD, satisfiable or not", () => {
    expect(plan({ Range: "bytes=0-1" }, "HEAD")).toEqual({ status: 200 });
    expect(plan({ Range: "bytes=5000-" }, "HEAD")).toEqual({ status: 200 });
  });

  it("gives only a read inside the file, of at least one byte, for any header", () => {
    const spec = fc.oneof(
      fc.tuple(fc.nat(2000), fc.nat(2000)).map(([a, b]) => `bytes=${a}-${b}`),
      fc.nat(2000).map((a) => `bytes=${a}-`),
      fc.nat(2000).map((n) => `bytes=-${n}`),
      fc.string().map((s) => s.replace(/[^\x20-\x7e]/g, "")),
    );
    fc.assert(
      fc.property(spec, fc.nat(1500), (range, size) => {
        const answer = plan({ Range: range }, "GET", size);
        if (answer.status === 206) {
          expect(answer.length).toBeGreaterThanOrEqual(1);
          expect(answer.offset).toBeGreaterThanOrEqual(0);
          expect(answer.offset + answer.length).toBeLessThanOrEqual(size);
          expect(answer.contentRange).toBe(
            `bytes ${answer.offset}-${answer.offset + answer.length - 1}/${size}`,
          );
        } else {
          expect([200, 416]).toContain(answer.status);
        }
      }),
    );
  });
});

describe("If-Range", () => {
  it.each([
    ["its ETag", ETAG, partial(0, 2)],
    ["another", '"other"', { status: 200 }],
    ["the weak form", `W/${ETAG}`, { status: 200 }],
    ["a date, even the very same one", SAME_SECOND, { status: 200 }],
    ["a later date", SECOND_AFTER, { status: 200 }],
    ["a list, which it doesn't take", `${ETAG}, "other"`, { status: 200 }],
  ])("with %s", (_what, value, expected) => {
    expect(plan({ Range: "bytes=0-1", "If-Range": value })).toEqual(expected);
  });

  it("that doesn't match sends the whole file, even for a range that can't be satisfied", () => {
    expect(plan({ Range: "bytes=5000-", "If-Range": '"other"' })).toEqual({ status: 200 });
    expect(plan({ Range: "bytes=5000-", "If-Range": ETAG })).toEqual(UNSATISFIABLE);
  });

  it("does nothing without a range", () => {
    expect(plan({ "If-Range": '"other"' })).toEqual({ status: 200 });
  });
});
