import type { FeedEntry } from "@fyrden/domain";

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

/** One entry's category; null for one that makes no email. */
function categoryOf(entry: FeedEntry): EmailCategory | null {
  const { recipient, feed } = entry;
  if (recipient.state !== "open" || recipient.silent || recipient.kind === "digest") return null;
  if (ASKS.has(recipient.kind) || recipient.kind === "merge_conflict") return "direct";
  if (
    recipient.kind === "activity" &&
    recipient.reasons.includes("author") &&
    OWN_STATE.has(feed.action)
  )
    return "direct";
  if (recipient.reasons.every((r) => r === "watching")) return "watching";
  return "participating";
}

/**
 * The category one event's entries for one recipient make: the strongest
 * of them (direct, then participating, then watching); null when none
 * makes email.
 */
export function emailCategory(entries: readonly FeedEntry[]): EmailCategory | null {
  let best: EmailCategory | null = null;
  for (const entry of entries) {
    const category = categoryOf(entry);
    if (
      category &&
      (best === null || EMAIL_CATEGORIES.indexOf(category) < EMAIL_CATEGORIES.indexOf(best))
    )
      best = category;
  }
  return best;
}
