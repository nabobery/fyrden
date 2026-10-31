/**
 * An issue's or pull request's labels, assignees, milestone, lock and
 * deletion, as the sidebar's and the pickers' forms change them: their
 * intents and what each says when done (the API calls are the server's,
 * in subject-meta.server.ts).
 */

import type { LockReason } from "@fyrden/domain";

/** The intents these forms send. */
export const META_INTENTS = [
  "label-add",
  "label-remove",
  "assign",
  "unassign",
  "milestone-set",
  "milestone-clear",
  "lock",
  "unlock",
  "delete-issue",
] as const;
export type MetaIntent = (typeof META_INTENTS)[number];

/** Whether `intent` is one of these forms'. */
export const isMetaIntent = (intent: string): intent is MetaIntent =>
  (META_INTENTS as readonly string[]).includes(intent);

/** What a done change says. */
export const META_DONE: Record<MetaIntent, string> = {
  "label-add": "Label added.",
  "label-remove": "Label removed.",
  assign: "Assigned.",
  unassign: "Unassigned.",
  "milestone-set": "Milestone set.",
  "milestone-clear": "Milestone cleared.",
  lock: "Conversation locked.",
  unlock: "Conversation unlocked.",
  "delete-issue": "Issue deleted.",
};

/** GitHub's lock reasons, as the lock form offers them (the API's own list). */
export const LOCK_REASON_LABEL: Record<LockReason, string> = {
  "off-topic": "Off-topic",
  "too heated": "Too heated",
  resolved: "Resolved",
  spam: "Spam",
};
