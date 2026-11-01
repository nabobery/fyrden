import type { FeedEntry, FeedRecipient } from "@fyrden/domain";
import { type InboxReason, reasonOf, strongestReason } from "../do/user/inbox.js";

/*
 * Which notification email an event's entries for one recipient make, by
 * what the event did and why the recipient hears of it (never by the
 * thread's merged inbox reason, which keeps a mention long after it):
 *
 * - `direct`: it asks something of the recipient: a review requested (of
 *   them or their team), an assignment, a mention; or their own issue or
 *   pull request closed, reopened or merged, or now in conflict.
 * - `participating`: activity on a thread they take part in or subscribed
 *   to (a comment, a review, an outcome of a review of theirs).
 * - `watching`: activity in a repository they watch, and nothing more.
 *
 * Entries that only settle something (`resolved`) and silent ones (the
 * recipient's own action) make no email; digests are not emailed.
 */

export const EMAIL_CATEGORIES = ["direct", "participating", "watching"] as const;
export type EmailCategory = (typeof EMAIL_CATEGORIES)[number];

const ASKS = new Set(["review_requested", "assigned", "mention"]);
const OWN_STATE = new Set(["closed", "reopened", "merged", "merge_conflict"]);

/** One contribution's category (a recipient's, for an event's `action`); null for none. */
function categoryOf(
  recipient: Pick<FeedRecipient, "kind" | "reasons" | "state" | "silent">,
  action: string,
): EmailCategory | null {
  if (recipient.state !== "open" || recipient.silent || recipient.kind === "digest") return null;
  if (ASKS.has(recipient.kind) || recipient.kind === "merge_conflict") return "direct";
  if (
    recipient.kind === "activity" &&
    recipient.reasons.includes("author") &&
    OWN_STATE.has(action)
  )
    return "direct";
  if (recipient.reasons.every((r) => r === "watching")) return "watching";
  return "participating";
}

const rank = (category: EmailCategory) => EMAIL_CATEGORIES.indexOf(category);

/**
 * The category one event's entries for one recipient make: the strongest
 * of them (direct, then participating, then watching); null when none
 * makes email.
 */
export function emailCategory(entries: readonly FeedEntry[]): EmailCategory | null {
  let best: EmailCategory | null = null;
  for (const entry of entries) {
    const category = categoryOf(entry.recipient, entry.feed.action);
    if (category && (best === null || rank(category) < rank(best))) best = category;
  }
  return best;
}

/** What an event's email for one recipient is: its category, and the inbox reason it is for. */
export interface EmailMark {
  readonly category: Exclude<EmailCategory, "watching">;
  readonly reason: InboxReason;
}

/**
 * The email one recipient's contributions to an event (`action`) make,
 * folded as `emailCategory` does, with the strongest inbox reason among
 * the contributions that make email (what a thread unsubscribe is judged
 * by); null for none. Watching email is not sent yet: its sender work is
 * not priced as discretionary work.
 */
export function emailMark(
  contributions: readonly Pick<FeedRecipient, "kind" | "reasons" | "state" | "silent">[],
  action: string,
): EmailMark | null {
  let best: EmailCategory | null = null;
  let reason: InboxReason | null = null;
  for (const contribution of contributions) {
    const category = categoryOf(contribution, action);
    if (!category) continue;
    if (best === null || rank(category) < rank(best)) best = category;
    const why = reasonOf(contribution.kind, contribution.reasons);
    reason = reason === null ? why : strongestReason(reason, why);
  }
  if (best === null || best === "watching" || reason === null) return null;
  return { category: best, reason };
}
