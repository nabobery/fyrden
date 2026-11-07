import { matchesIfNoneMatch } from "./cache.js";

/** What a download answers, worked out before any byte is read. */
export type DownloadPlan =
  | { readonly status: 200 | 304 | 412 }
  | { readonly status: 206; offset: number; length: number; contentRange: string }
  | { readonly status: 416; contentRange: string };

export interface DownloadResource {
  /** Strong and in quotes: the bytes behind it never change. */
  readonly etag: string;
  /** Milliseconds; `Last-Modified` holds it in whole seconds, as these comparisons do. */
  readonly lastModified: number;
  readonly size: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH = MONTHS.join("|");
const TIME = "(\\d{2}):(\\d{2}):(\\d{2})";
const IMF_DATE = new RegExp(
  `^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\\d{2}) (${MONTH}) (\\d{4}) ${TIME} GMT$`,
);
const RFC850_DATE = new RegExp(
  `^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\\d{2})-(${MONTH})-(\\d{2}) ${TIME} GMT$`,
);
const ASCTIME_DATE = new RegExp(
  `^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (${MONTH}) ( \\d|\\d{2}) ${TIME} (\\d{4})$`,
);

function utc(
  year: number,
  month: string,
  day: string,
  hour: string,
  minute: string,
  second: string,
): number | undefined {
  // A leap second is valid and has no time of its own: it reads as the second before.
  const seconds = hour === "23" && minute === "59" && second === "60" ? 59 : Number(second);
  const time = Date.UTC(
    year,
    MONTHS.indexOf(month),
    Number(day),
    Number(hour),
    Number(minute),
    seconds,
  );
  const date = new Date(time);
  // Date.UTC carries an overflow on (31 February, 25:00), which isn't a date:
  // an hour's shows in the day, and any other's in its own field.
  return date.getUTCFullYear() === year &&
    date.getUTCDate() === Number(day) &&
    date.getUTCMinutes() === Number(minute) &&
    date.getUTCSeconds() === seconds
    ? time
    : undefined;
}

/**
 * An HTTP-date in any of its three forms (RFC 9110 §5.6.7), else undefined,
 * for a condition to be ignored as the RFC says. `Date.parse` won't do: it
 * reads `2030` as a date, which would answer a 304 for a value that isn't one.
 */
function httpDate(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  const imf = IMF_DATE.exec(value);
  if (imf) {
    const [, day = "", month = "", year = "", hour = "", minute = "", second = ""] = imf;
    return utc(Number(year), month, day, hour, minute, second);
  }
  const rfc850 = RFC850_DATE.exec(value);
  if (rfc850) {
    const [, day = "", month = "", short = "", hour = "", minute = "", second = ""] = rfc850;
    // Two digits name the latest such moment not over 50 years ahead.
    const ahead = new Date(now);
    ahead.setUTCFullYear(ahead.getUTCFullYear() + 50);
    const thisYear = new Date(now).getUTCFullYear();
    const base = thisYear - (thisYear % 100) + Number(short);
    // Four centuries back reach a leap day from any start: most centuries have none.
    for (let year = base + 100; year >= base - 300; year -= 100) {
      const time = utc(year, month, day, hour, minute, second);
      if (time !== undefined && time <= ahead.getTime()) return time;
    }
    return undefined;
  }
  const asctime = ASCTIME_DATE.exec(value);
  if (asctime) {
    const [, month = "", day = "", hour = "", minute = "", second = "", year = ""] = asctime;
    return utc(Number(year), month, day.trim(), hour, minute, second);
  }
  return undefined;
}

/** `If-Match`: `*`, or any listed tag by strong comparison (a weak tag never matches). */
function matchesIfMatch(condition: string, etag: string): boolean {
  return condition.trim() === "*" || condition.match(/(?:W\/)?"[^"]*"/g)?.includes(etag) === true;
}

/** Whether one run of digits is the larger number, at any length: `Number` would round them. */
function digitsExceed(a: string, b: string): boolean {
  const left = a.replace(/^0+/, "");
  const right = b.replace(/^0+/, "");
  return left.length === right.length ? left > right : left.length > right.length;
}

/** One `bytes=` range against `size`, else the whole file. A list is the whole file too. */
function rangePlan(range: string, size: number): DownloadPlan {
  const spec = /^bytes=(?:(\d+)-(\d*)|-(\d+))$/i.exec(range);
  if (!spec) return { status: 200 };
  const [, first, last, suffix] = spec;
  let offset: number;
  let end: number;
  if (suffix !== undefined) {
    // `-0` starts past the end, so it can't be satisfied, as the RFC says.
    offset = Math.max(0, size - Number(suffix));
    end = size - 1;
  } else {
    offset = Number(first);
    if (last && first && digitsExceed(first, last)) return { status: 200 };
    end = last ? Math.min(Number(last), size - 1) : size - 1;
  }
  if (offset >= size) return { status: 416, contentRange: `bytes */${size}` };
  return {
    status: 206,
    offset,
    length: end - offset + 1,
    contentRange: `bytes ${offset}-${end}/${size}`,
  };
}

/**
 * Conditions then range, in the order of RFC 9110 §13.2.2. A 206 always names
 * at least one byte inside the file. `If-Range` takes an ETag only: a date
 * within the same second could splice two versions of a file, and sending the
 * whole file is always correct (§13.1.5).
 */
export function downloadPlan(
  request: { readonly method: string; readonly headers: Headers },
  { etag, lastModified, size }: DownloadResource,
  now: number,
): DownloadPlan {
  const { headers } = request;
  const lastSecond = Math.floor(lastModified / 1000) * 1000;

  const ifMatch = headers.get("If-Match");
  if (ifMatch !== null) {
    if (!matchesIfMatch(ifMatch, etag)) return { status: 412 };
  } else {
    const since = httpDate(headers.get("If-Unmodified-Since"), now);
    if (since !== undefined && since < lastSecond) return { status: 412 };
  }

  const ifNoneMatch = headers.get("If-None-Match");
  if (ifNoneMatch !== null) {
    if (matchesIfNoneMatch(ifNoneMatch, etag)) return { status: 304 };
  } else {
    const since = httpDate(headers.get("If-Modified-Since"), now);
    if (since !== undefined && since >= lastSecond) return { status: 304 };
  }

  const range = headers.get("Range");
  if (range === null || request.method !== "GET") return { status: 200 };
  const ifRange = headers.get("If-Range");
  if (ifRange !== null && ifRange.trim() !== etag) return { status: 200 };
  return rangePlan(range, size);
}
