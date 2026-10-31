/**
 * Milestones as the pages read and show them: the API's own shapes (types
 * only), a due date as a form's date field writes it and as the API takes
 * it, and where a milestone's issues and pull requests are listed.
 */

import type { getMilestone, listMilestones, Output } from "@fyrden/api-contract";

export type Milestone = Output<typeof getMilestone>;
export type MilestonesPage = Output<typeof listMilestones>;

/**
 * Bytes of a milestone form read at most: a description of 65,536
 * characters and a title, URL-encoded at up to 9 bytes a character, and
 * the rest.
 */
export const MILESTONE_FORM_MAX_BYTES = 9 * 65_536 + 16 * 1024;

/** Characters of a description the list shows (as text: the rest is in its editor). */
export const DESCRIPTION_EXCERPT = 500;

/** The latest due date the API takes (JavaScript's latest time, in year 275760). */
const LATEST_DUE = 8_640_000_000_000_000;

/**
 * A date field's value (`YYYY-MM-DD`, more year digits past 9999) as the
 * API takes a due date: that day's start in UTC, in milliseconds; null for
 * none (an empty field); undefined for a value that is no date the API
 * takes (none before 1970, none past its latest).
 */
export function dueOf(value: string): number | null | undefined {
  if (value === "") return null;
  const match = /^(\d{4,6})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const at = Date.UTC(year, month - 1, day);
  if (!(at >= 0 && at <= LATEST_DUE)) return undefined;
  // Rolled over (the 31st of a 30-day month): not the date written.
  const back = new Date(at);
  return back.getUTCFullYear() === year &&
    back.getUTCMonth() === month - 1 &&
    back.getUTCDate() === day
    ? at
    : undefined;
}

/** A due date as a date field shows it (`YYYY-MM-DD`, its UTC day, more year digits past 9999); "" for none. */
export function dateOf(due: number | null): string {
  if (due === null) return "";
  const at = new Date(due);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${String(at.getUTCFullYear()).padStart(4, "0")}-${two(at.getUTCMonth() + 1)}-${two(at.getUTCDate())}`;
}

/** What of a description the list shows: up to `DESCRIPTION_EXCERPT` characters, cut with "…". */
export function excerpt(description: string): string {
  // Read only as far as it shows (a description may hold 65,536 characters).
  let shown = "";
  let count = 0;
  for (const char of description) {
    if (count === DESCRIPTION_EXCERPT) return `${shown}…`;
    shown += char;
    count += 1;
  }
  return description;
}

/** A milestone's issues and pull requests, in any state. */
export function milestoneItems(owner: string, repo: string, number: number): string {
  const query = new URLSearchParams({ state: "all", kind: "all", milestone: String(number) });
  return `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?${query}`;
}

/** `/repos/{owner}/{repo}/milestones/{number}` for the API. */
export const milestoneApiPath = (repoApi: string, number: number): string =>
  `${repoApi}/milestones/${number}`;
