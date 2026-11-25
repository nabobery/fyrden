/*
 * The `created` filter of a list of runs, in GitHub's search syntax for
 * dates (verified 2026-11-25:
 * https://docs.github.com/en/search-github/getting-started-with-searching-on-github/understanding-the-search-syntax#query-for-dates).
 */

/** Times in milliseconds: from `from` on, before `until`; null for no bound. */
export interface TimeRange {
  readonly from: number | null;
  readonly until: number | null;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})$/;
const DAY = 86_400_000;
const SECOND = 1_000;
/** The offset farthest from UTC in use, +14:00. */
const MAX_OFFSET_MINUTES = 14 * 60;

/** What a date (a UTC day) or a time (a second) covers. */
function instant(text: string): { readonly from: number; readonly until: number } | undefined {
  const day = utcDay(text);
  if (day !== undefined) return { from: day, until: day + DAY };
  const match = TIME.exec(text);
  if (!match) return undefined;
  const [, date = "", hour = "", minute = "", second = "00", zone = ""] = match;
  const midnight = utcDay(date);
  const [h, m, s] = [Number(hour), Number(minute), Number(second)];
  const [zoneHours, zoneMinutes] =
    zone === "Z" ? [0, 0] : [Number(zone.slice(1, 3)), Number(zone.slice(4))];
  const offset = zoneHours * 60 + zoneMinutes;
  if (midnight === undefined || h > 23 || m > 59 || s > 59) return undefined;
  if (zoneMinutes > 59 || offset > MAX_OFFSET_MINUTES) return undefined;
  const local = midnight + ((h * 60 + m) * 60 + s) * SECOND;
  const from = local - (zone.startsWith("-") ? -offset : offset) * 60 * SECOND;
  return { from, until: from + SECOND };
}

function utcDay(text: string): number | undefined {
  const match = DATE.exec(text);
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const time = Date.UTC(year, month - 1, day);
  const back = new Date(time);
  // A day the month does not have rolls over, and a year before 100 is not itself.
  return back.getUTCFullYear() === year &&
    back.getUTCMonth() === month - 1 &&
    back.getUTCDate() === day
    ? time
    : undefined;
}

/** The times a `created` filter names; undefined for text that is not one. */
export function parseCreatedFilter(text: string): TimeRange | undefined {
  const dots = text.indexOf("..");
  if (dots >= 0) {
    const [left, right] = [text.slice(0, dots), text.slice(dots + 2)];
    const first = left === "*" ? null : instant(left);
    const last = right === "*" ? null : instant(right);
    if (first === undefined || last === undefined || (first === null && last === null))
      return undefined;
    return { from: first?.from ?? null, until: last?.until ?? null };
  }
  const operator = /^(?:>=|<=|>|<)/.exec(text)?.[0] ?? "";
  const named = instant(text.slice(operator.length));
  if (!named) return undefined;
  switch (operator) {
    case ">=":
      return { from: named.from, until: null };
    case ">":
      return { from: named.until, until: null };
    case "<=":
      return { from: null, until: named.until };
    case "<":
      return { from: null, until: named.from };
    default:
      return named;
  }
}
