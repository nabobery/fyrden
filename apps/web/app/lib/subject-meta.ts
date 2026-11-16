/**
 * An issue's or pull request's labels, assignees, milestone, lock and
 * deletion, as the sidebar's and the pickers' forms change them: their
 * intents and what each says when done (the API calls are the server's,
 * in subject-meta.server.ts).
 */

import type { LockReason } from "@fyrden/domain";

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

export const isMetaIntent = (intent: string): intent is MetaIntent =>
  (META_INTENTS as readonly string[]).includes(intent);

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

export const LOCK_REASON_LABEL: Record<LockReason, string> = {
  "off-topic": "Off-topic",
  "too heated": "Too heated",
  resolved: "Resolved",
  spam: "Spam",
};
