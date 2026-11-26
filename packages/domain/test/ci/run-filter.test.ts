import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseCreatedFilter } from "../../src/ci/run-filter.js";

const at = (iso: string) => Date.parse(iso);
const DAY = 86_400_000;

describe("parseCreatedFilter", () => {
  it.each<[string, number | null, number | null]>([
    ["2026-11-20", at("2026-11-20T00:00:00Z"), at("2026-11-21T00:00:00Z")],
    [">=2026-11-20", at("2026-11-20T00:00:00Z"), null],
    [">2026-11-20", at("2026-11-21T00:00:00Z"), null],
    ["<=2026-11-20", null, at("2026-11-21T00:00:00Z")],
    ["<2026-11-20", null, at("2026-11-20T00:00:00Z")],
    ["2026-11-18..2026-11-20", at("2026-11-18T00:00:00Z"), at("2026-11-21T00:00:00Z")],
    ["2026-11-18..*", at("2026-11-18T00:00:00Z"), null],
    ["*..2026-11-20", null, at("2026-11-21T00:00:00Z")],
    [
      "2026-11-20T10:15:30Z..2026-11-20T11:00:00+01:00",
      at("2026-11-20T10:15:30Z"),
      at("2026-11-20T10:00:01Z"),
    ],
    [">2026-11-20T10:15:30Z", at("2026-11-20T10:15:31Z"), null],
    [">=2026-11-20T10:00:00-13:59", at("2026-11-20T23:59:00Z"), null],
    [">=2026-11-20T10:00:00+14:00", at("2026-11-19T20:00:00Z"), null],
    ["2026-11-20T10:15Z", at("2026-11-20T10:15:00Z"), at("2026-11-20T10:15:01Z")],
  ])("reads %s", (text, from, until) => {
    expect(parseCreatedFilter(text)).toEqual({ from, until });
  });

  it.each([
    "",
    "yesterday",
    "2026-13-01",
    "2026-02-30",
    "2026-11-20..",
    "..2026-11-20",
    "*..*",
    ">=2026-11-20..2026-11-21",
    "2026-11-20T25:00:00Z",
    "2026-11-20T10:00:00",
    "2026-11-20T10:00:00+00:60",
    "2026-11-20T10:00:00-00:99",
    "2026-11-20T10:00:00+14:01",
    "2026-11-20 10:00",
    "=2026-11-20",
    "2026-11-20..2026-11-21..2026-11-22",
    "١٩٧٠-٠١-٠١",
  ])("refuses %j", (text) => {
    expect(parseCreatedFilter(text)).toBeUndefined();
  });

  it("names the whole of any day, and never throws", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 40_000 }), (days) => {
        const day = new Date(days * DAY).toISOString().slice(0, 10);
        expect(parseCreatedFilter(day)).toEqual({ from: days * DAY, until: (days + 1) * DAY });
      }),
    );
    fc.assert(
      fc.property(fc.string(), (text) => {
        const range = parseCreatedFilter(text);
        expect(range === undefined || typeof range === "object").toBe(true);
      }),
    );
  });
});
