/*
 * Commit statuses and check summaries: what a check on a commit is, how a
 * status maps onto one, and the rules an attempt's state follows. The
 * repository object stores them; required checks and the activity feed
 * read them.
 */

/** A commit status's state, as GitHub's statuses API names them. */
export const STATUS_STATES = ["pending", "success", "failure", "error"] as const;
export type StatusState = (typeof STATUS_STATES)[number];

export const CHECK_STATUSES = ["queued", "in_progress", "completed"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

/** GitHub's check-run conclusions without `stale` (only GitHub sets it), plus a status's `error`. */
export const CHECK_CONCLUSIONS = [
  "success",
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "error",
] as const;
export type CheckConclusion = (typeof CHECK_CONCLUSIONS)[number];

/**
 * Who published a check: the id of the principal that posted a status (an
 * agent, never the user it acts for), or `ci` for Fyrden's own runs. No
 * principal id can be `ci`: every id carries a type prefix.
 */
export type CheckSource = string;
export const FYRDEN_CI_SOURCE: CheckSource = "ci";

/** One publisher's current state of one named check on one commit. */
export interface CheckSummary {
  /** As last written. */
  readonly name: string;
  readonly source: CheckSource;
  readonly kind: "status" | "check";
  /** The current attempt of a check; null for a status. */
  readonly attempt: number | null;
  /** The status a status summary reflects, increasing within a repository; null for a check. */
  readonly statusId: number | null;
  readonly status: CheckStatus;
  /** Set exactly when completed. */
  readonly conclusion: CheckConclusion | null;
  /** A status's target URL, a check's details URL. */
  readonly detailsUrl: string | null;
  /** For display; never an order. */
  readonly updatedAt: number;
}

/** Statuses one commit may have of one context (GitHub's limit). */
export const MAX_STATUSES_PER_CONTEXT = 1_000;
/** Statuses one commit may have in all. Proposed. */
export const MAX_STATUSES_PER_SHA = 10_000;
/** Summaries of each kind one commit may have (three 256-job matrices and more). Proposed. */
export const MAX_SUMMARIES_PER_SHA = 1_000;
/** Attempts of one check on one commit. Proposed. */
export const MAX_CHECK_ATTEMPTS = 100;
/** Updates or starts in one call. Proposed: the matrix cap. */
export const MAX_CHECK_BATCH = 256;
/**
 * Failing checks a pull request's record and its feed events name at most
 * (the excerpt shows a few); the count and a digest stand for the rest.
 * Proposed: with names of 255 characters, the record stays well inside a
 * row and an event.
 */
export const MAX_FAILING_SHOWN = 20;
/** Runs' trigger actors told of a pull request's failing checks, beside its author. Proposed. */
export const MAX_TRIGGER_HOLDERS = 50;
/** A context or check name, in characters. Proposed: GitHub documents none. */
export const MAX_CHECK_NAME_LENGTH = 255;
/** A status description, in characters. Proposed: GitHub's reported limit (unverified). */
export const MAX_STATUS_DESCRIPTION_LENGTH = 140;
/** A target or details URL, in characters. Proposed. */
export const MAX_TARGET_URL_LENGTH = 2_048;

/** How names are compared: GitHub's contexts are case-insensitive; NFC so one name has one key. */
export function checkNameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

export type TextCheck =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: "empty" | "too_long" | "control_character" };

/** Whether `text` is 1 to `max` characters (code points) with no control characters. */
export function checkText(text: string, max: number): TextCheck {
  if (text.length === 0) return { ok: false, reason: "empty" };
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it finds.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) return { ok: false, reason: "control_character" };
  let length = 0;
  for (const _ of text) if (++length > max) return { ok: false, reason: "too_long" };
  return { ok: true, value: text };
}

export type UrlCheck =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: "too_long" | "not_http" };

/** An absolute http or https URL, which pages may render as a link. */
export function targetUrl(text: string): UrlCheck {
  if (text.length > MAX_TARGET_URL_LENGTH) return { ok: false, reason: "too_long" };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: "not_http" };
  }
  return url.protocol === "https:" || url.protocol === "http:"
    ? { ok: true, value: text }
    : { ok: false, reason: "not_http" };
}

/** A full SHA-1 commit id as Fyrden writes it: 40 lowercase hex digits. */
export function isFullSha(text: string): boolean {
  return /^[0-9a-f]{40}$/.test(text);
}

/** What a status says as a summary: pending is in progress, the rest a conclusion. */
export function summaryOfStatus(state: StatusState): {
  status: CheckStatus;
  conclusion: CheckConclusion | null;
} {
  return state === "pending"
    ? { status: "in_progress", conclusion: null }
    : { status: "completed", conclusion: state };
}

/**
 * The outcome that stands after a status: the last one that was not
 * pending, so a re-run going pending keeps a failure known until it ends.
 */
export function settleStatus(
  settled: CheckConclusion | null,
  state: StatusState,
): CheckConclusion | null {
  return state === "pending" ? settled : state;
}

const RANK: Record<CheckStatus, number> = { queued: 0, in_progress: 1, completed: 2 };

export type CheckStep = "applied" | "unchanged" | "invalid_transition" | "invalid_update";

/**
 * Whether an attempt in state `from` may take `to`: forward only (skipping
 * allowed), a conclusion exactly when completed, and a completed attempt
 * final (the same conclusion again changes nothing).
 */
export function advanceCheck(
  from: { readonly status: CheckStatus; readonly conclusion: CheckConclusion | null },
  to: { readonly status: CheckStatus; readonly conclusion: CheckConclusion | null },
): CheckStep {
  if ((to.status === "completed") !== (to.conclusion !== null)) return "invalid_update";
  if (RANK[to.status] < RANK[from.status]) return "invalid_transition";
  if (to.status === from.status)
    return to.conclusion === from.conclusion ? "unchanged" : "invalid_transition";
  return "applied";
}

/** An outcome the pull request's author must act on. */
export function isFailing(conclusion: CheckConclusion | null): boolean {
  return conclusion === "failure" || conclusion === "error" || conclusion === "timed_out";
}

/**
 * The summaries that decide a commit's checks when no rule names any: the
 * latest status of each name, whoever posted it (as the combined status
 * reads them), and every check of Fyrden's runs. In the order given.
 */
export function countedByDefault(rows: readonly CheckSummary[]): CheckSummary[] {
  const latest = new Map<string, number>();
  for (const row of rows)
    if (row.kind === "status" && row.statusId !== null) {
      const key = checkNameKey(row.name);
      latest.set(key, Math.max(latest.get(key) ?? 0, row.statusId));
    }
  return rows.filter(
    (row) => row.kind === "check" || latest.get(checkNameKey(row.name)) === row.statusId,
  );
}

/**
 * A 64-bit digest of `text` as 16 hex digits (a cyrb53-style mix, two
 * 32-bit halves): what tells one record of failing checks from another
 * without keeping all of it. Not for secrets.
 */
export function digestOf(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return hex(h2) + hex(h1);
}
