/*
 * Five-field POSIX cron for `on.schedule`, read in UTC: minute, hour, day
 * of month, month, day of week. Each field is `*` or a comma list of
 * values and ranges, with a step on `*` or a range; months take JAN-DEC
 * and days SUN-SAT in any case, and day of week 7 is Sunday as 0 is. When
 * day of month and day of week are both restricted (neither is `*`), a day
 * matching either runs (POSIX `crontab`, verified 2026-11-15,
 * https://pubs.opengroup.org/onlinepubs/9799919799/utilities/crontab.html).
 * GitHub documents the same five fields and these operators (verified
 * 2026-11-15, https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
 * No seconds, no `@` macros. Times are milliseconds since the epoch.
 */

export interface Cron {
  /** Membership by value: index 0-59, 0-23, 1-31, 1-12 and 0-6 (Sunday 0). */
  readonly minutes: readonly boolean[];
  readonly hours: readonly boolean[];
  readonly daysOfMonth: readonly boolean[];
  readonly months: readonly boolean[];
  readonly daysOfWeek: readonly boolean[];
  /** The field was written as `*`. */
  readonly anyDayOfMonth: boolean;
  readonly anyDayOfWeek: boolean;
}

export type ParsedCron =
  | { readonly ok: true; readonly cron: Cron }
  | { readonly ok: false; readonly message: string };

interface FieldSpec {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly names?: readonly string[];
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const FIELDS: readonly FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS },
  { name: "day of week", min: 0, max: 7, names: DAYS },
];
/** Days in each month, February in a leap year. */
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MINUTE = 60_000;
const DAY = 86_400_000;
/** How far {@link cronNext} looks: five years, leap days included. */
const SEARCH_DAYS = 5 * 366;

/** `text` as a cron, or a message naming what is wrong. */
export function parseCron(text: string): ParsedCron {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 5 || parts[0] === "") {
    return fail(`\`${clip(text)}\` is not a cron expression: it needs five fields.`);
  }
  const sets: boolean[][] = [];
  for (const [i, spec] of FIELDS.entries()) {
    const set = readField(parts[i] as string, spec);
    if (typeof set === "string") return fail(set);
    sets.push(set);
  }
  const [minutes, hours, daysOfMonth, months, week] = sets as [
    boolean[],
    boolean[],
    boolean[],
    boolean[],
    boolean[],
  ];
  // 7 is Sunday.
  const daysOfWeek = week.slice(0, 7);
  if (week[7]) daysOfWeek[0] = true;
  const cron: Cron = {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    anyDayOfMonth: parts[2] === "*",
    anyDayOfWeek: parts[4] === "*",
  };
  // Day of month alone decides the day when day of week is `*`: it may name no real date.
  if (!cron.anyDayOfMonth && cron.anyDayOfWeek) {
    const real = MONTH_DAYS.some(
      (days, m) => months[m + 1] && daysOfMonth.slice(1, days + 1).some(Boolean),
    );
    if (!real) return fail(`\`${clip(text)}\` never runs: no month it names has that day.`);
  }
  return { ok: true, cron };
}

/** One field's values, or the message saying why it cannot be read. */
function readField(field: string, spec: FieldSpec): boolean[] | string {
  const set = new Array<boolean>(spec.max + 1).fill(false);
  const bad = `\`${clip(field)}\` is not a valid ${spec.name} field`;
  for (const item of field.split(",")) {
    const match = /^(\*|[0-9A-Za-z]+(?:-[0-9A-Za-z]+)?)(?:\/([0-9]+))?$/.exec(item);
    if (!match) return `${bad}.`;
    const [, range = "", stepText] = match;
    let from = spec.min;
    let to = spec.max;
    if (range !== "*") {
      const [first = "", second] = range.split("-");
      const a = fieldValue(first, spec);
      const b = second === undefined ? a : fieldValue(second, spec);
      if (typeof a === "string") return a;
      if (typeof b === "string") return b;
      if (a > b) return `${bad}: the range \`${clip(range)}\` runs backwards.`;
      from = a;
      // A step on one value runs from it through the field's maximum (GitHub: `20/15` is
      // minutes 20, 35 and 50).
      to = second === undefined && stepText !== undefined ? spec.max : b;
    }
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isSafeInteger(step) || step < 1) return `${bad}: a step must be at least 1.`;
    for (let v = from; v <= to; v += step) set[v] = true;
  }
  return set;
}

function fieldValue(token: string, spec: FieldSpec): number | string {
  const named = spec.names?.indexOf(token.toLowerCase()) ?? -1;
  // Month names count from 1, day names from 0.
  if (named >= 0) return named + (spec.names === MONTHS ? 1 : 0);
  const range = `${spec.min}-${spec.max}`;
  if (!/^[0-9]+$/.test(token)) {
    return `\`${clip(token)}\` is not a value of the ${spec.name} field (${range}${spec.names ? " or a name" : ""}).`;
  }
  const value = Number(token);
  if (value < spec.min || value > spec.max) {
    return `\`${clip(token)}\` is out of range for the ${spec.name} field (${range}).`;
  }
  return value;
}

/** Whether `ms` (any millisecond of the minute) is an occurrence of `cron`. */
export function cronMatches(cron: Cron, ms: number): boolean {
  const d = new Date(ms);
  return (
    cron.minutes[d.getUTCMinutes()] === true &&
    cron.hours[d.getUTCHours()] === true &&
    dayMatches(cron, d)
  );
}

function dayMatches(cron: Cron, d: Date): boolean {
  if (!cron.months[d.getUTCMonth() + 1]) return false;
  const dom = cron.daysOfMonth[d.getUTCDate()] === true;
  const dow = cron.daysOfWeek[d.getUTCDay()] === true;
  if (!cron.anyDayOfMonth && !cron.anyDayOfWeek) return dom || dow;
  return dom && dow;
}

/** The first occurrence strictly after `afterMs`, or null when none falls within five years. */
export function cronNext(cron: Cron, afterMs: number): number | null {
  let t = Math.floor(afterMs / MINUTE) * MINUTE + MINUTE;
  const limit = t + SEARCH_DAYS * DAY;
  while (t <= limit) {
    const d = new Date(t);
    if (dayMatches(cron, d)) {
      const hour = d.getUTCHours();
      for (let h = hour; h < 24; h++) {
        if (!cron.hours[h]) continue;
        for (let m = h === hour ? d.getUTCMinutes() : 0; m < 60; m++) {
          if (cron.minutes[m]) {
            return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m);
          }
        }
      }
    }
    t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  }
  return null;
}

/** GitHub: "The shortest interval you can run scheduled workflows is once every 5 minutes" (events page above). */
export const SCHEDULE_SPACING_MS = 5 * MINUTE;

/**
 * The next time a schedule fires: the first occurrence after `nowMs` that
 * is also at or after `lastFiredMs + spacingMs`, so an every-5-minutes cron fired at 12:00
 * fires next at 12:05. Null when none falls within five years.
 */
export function nextTick(
  cron: Cron,
  nowMs: number,
  lastFiredMs: number | null,
  spacingMs: number = SCHEDULE_SPACING_MS,
): number | null {
  // Occurrences are whole milliseconds: "at or after x" is "strictly after x - 1".
  const after = lastFiredMs === null ? nowMs : Math.max(nowMs, lastFiredMs + spacingMs - 1);
  return cronNext(cron, after);
}

function fail(message: string): ParsedCron {
  return { ok: false, message };
}

function clip(text: string): string {
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}
