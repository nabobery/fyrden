import type { CaptureValue } from "./capture.js";

/*
 * What webhook captures are made of: the API's own shapes of the entities
 * an event names, as of the event, with two conventions a delivery's body
 * follows. A user (in the API, an object holding a principal id alone,
 * `{ id }`) is captured as `{ $user: id }`, its login shown when the body
 * is made; a time (`*_at`, `due_on`, and the `from` of an edit of one) is
 * ISO 8601, null when no date can hold it.
 */

/** The capture format this version makes and makes bodies from. */
export const CAPTURE_VERSION = 1;

/** How long after its event a body is still made from its capture (see `DELIVERY_POLICY`). */
export const CAPTURE_DEADLINE_MS = 7 * 24 * 60 * 60_000;

const TIME = /(^|_)at$|^due_on$/;

function iso(value: unknown): CaptureValue {
  if (typeof value !== "number") return value === undefined ? null : capturable(value);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** A time field's value: a time, or an edit's `{ from }` of one. */
function timeOf(value: unknown): CaptureValue {
  if (typeof value === "object" && value !== null && !Array.isArray(value) && "from" in value)
    return {
      ...(capturable(value) as Record<string, CaptureValue>),
      from: iso((value as { from: unknown }).from),
    };
  return iso(value);
}

/** `value` (an API shape, or part of one) as a capture holds it; undefined fields are left out. */
export function capturable(value: unknown): CaptureValue {
  if (Array.isArray(value)) return value.map(capturable);
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    const [only] = entries;
    if (entries.length === 1 && only?.[0] === "id" && typeof only[1] === "string")
      return { $user: only[1] };
    return Object.fromEntries(
      entries.map(([key, item]) => [key, TIME.test(key) ? timeOf(item) : capturable(item)]),
    );
  }
  return value as CaptureValue;
}

/** A user as a capture names one, or null. */
export const userOf = (id: string | null | undefined): CaptureValue =>
  id === null || id === undefined ? null : { $user: id };
