import { z } from "zod";
import { atLeast, type RepoRole } from "../authz/roles.js";

/*
 * What issues and pull requests are sorted by: a repository's labels and
 * milestones, and who is assigned. Both kinds share one number sequence,
 * so these attach to a number, whichever kind it is.
 */

/** The longest label name, in characters (GitHub's). */
export const MAX_LABEL_NAME_LENGTH = 50;
/** The longest label description, in characters (GitHub's). */
export const MAX_LABEL_DESCRIPTION_LENGTH = 100;
/** A label's color: six hex digits, without `#` (GitHub's), kept lower-case. */
export const LABEL_COLOR = /^[0-9a-fA-F]{6}$/;
/**
 * A label name: no control characters, no surrounding spaces, and not `.`
 * or `..` (a path segment URLs resolve away, so no path could name it).
 */
export const LABEL_NAME = /^(?!\.\.?$)[^\p{Cc}\s](?:[^\p{Cc}]*[^\p{Cc}\s])?$/u;

/**
 * A label name as names compare: the case of ASCII letters ignored, others
 * kept (as SQLite's `NOCASE`, which the storage's uniqueness and lookups
 * use): `Bug` and `bug` are one name, `É` and `é` two.
 */
export function labelNameKey(name: string): string {
  return name.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** Labels a repository holds at most. */
export const MAX_REPO_LABELS = 1_000;
/** Labels an organization's default set holds at most. */
export const MAX_DEFAULT_LABELS = 100;
/** Labels on one issue or pull request at most (GitHub's). */
export const MAX_SUBJECT_LABELS = 100;
/** Assignees of one issue or pull request at most (GitHub's). */
export const MAX_ASSIGNEES = 10;

/** The longest milestone title, in characters. */
export const MAX_MILESTONE_TITLE_LENGTH = 256;
/** The longest milestone description, in characters. */
export const MAX_MILESTONE_DESCRIPTION_LENGTH = 65_536;
export const MILESTONE_STATES = ["open", "closed"] as const;
export type MilestoneState = (typeof MILESTONE_STATES)[number];

/** The entity types label and milestone snapshots travel as in events. */
export const LABEL_ENTITY = "label";
export const MILESTONE_ENTITY = "milestone";

/** A label's name, color and description, as given. */
export interface LabelSpec {
  readonly name: string;
  readonly color: string;
  readonly description: string | null;
}

/**
 * GitHub's default labels: what a new repository gets until its
 * organization sets its own default set (a user's repositories always).
 */
export const GITHUB_DEFAULT_LABELS: readonly LabelSpec[] = [
  { name: "bug", color: "d73a4a", description: "Something isn't working" },
  {
    name: "documentation",
    color: "0075ca",
    description: "Improvements or additions to documentation",
  },
  { name: "duplicate", color: "cfd3d7", description: "This issue or pull request already exists" },
  { name: "enhancement", color: "a2eeef", description: "New feature or request" },
  { name: "good first issue", color: "7057ff", description: "Good for newcomers" },
  { name: "help wanted", color: "008672", description: "Extra attention is needed" },
  { name: "invalid", color: "e4e669", description: "This doesn't seem right" },
  { name: "question", color: "d876e3", description: "Further information is requested" },
  { name: "wontfix", color: "ffffff", description: "This will not be worked on" },
];

/** A label as events carry it. */
export const LabelRowSchema = z.strictObject({
  id: z.number().int().positive(),
  name: z.string().min(1).max(MAX_LABEL_NAME_LENGTH),
  color: z.string().regex(/^[0-9a-f]{6}$/),
  description: z.string().max(MAX_LABEL_DESCRIPTION_LENGTH).nullable(),
  /** Copied in from a default set. */
  isDefault: z.boolean(),
  createdAt: z.number().int().min(0),
  updatedAt: z.number().int().min(0),
});
export type LabelRow = z.infer<typeof LabelRowSchema>;

/** A milestone as events carry it. */
export const MilestoneRowSchema = z.strictObject({
  number: z.number().int().positive(),
  title: z.string().min(1).max(MAX_MILESTONE_TITLE_LENGTH),
  description: z.string().max(MAX_MILESTONE_DESCRIPTION_LENGTH).nullable(),
  state: z.enum(MILESTONE_STATES),
  /** Unix ms; null for none. */
  dueOn: z.number().int().min(0).nullable(),
  closedAt: z.number().int().min(0).nullable(),
  /** Open and closed issues in it, as they stand. */
  openIssues: z.number().int().min(0),
  closedIssues: z.number().int().min(0),
  /** Open and closed (or merged) pull requests in it, as they stand. */
  openPulls: z.number().int().min(0),
  closedPulls: z.number().int().min(0),
  creator: z.string(),
  createdAt: z.number().int().min(0),
  updatedAt: z.number().int().min(0),
});
export type MilestoneRow = z.infer<typeof MilestoneRowSchema>;

/** What an issue's or pull request's snapshot carries of its labels, assignees and milestone. */
export const SubjectMetaRowShape = {
  /** Its labels' ids, ascending. */
  labels: z.array(z.number().int().positive()).max(MAX_SUBJECT_LABELS),
  /** Its assignees' principal ids, ascending. */
  assignees: z.array(z.string()).max(MAX_ASSIGNEES),
  /** Its milestone's number; null for none (or one deleted). */
  milestone: z.number().int().positive().nullable(),
};
/**
 * The snapshot fields an issue's or pull request's record leaves out (read
 * when it is emitted). Its record keeps `milestone` as recorded, which may
 * name one deleted since: a snapshot carries it only while it exists.
 */
export type SubjectMetaField = "labels" | "assignees";

/** What can be done to sort issues and pull requests. */
export const METADATA_ACTIONS = [
  "label",
  "assign",
  "set_milestone",
  "manage_labels",
  "manage_milestones",
] as const;
export type MetadataAction = (typeof METADATA_ACTIONS)[number];

/**
 * The role each takes (GitHub's): triage labels, assigns and sets the
 * milestone of any issue or pull request (its author too needs triage);
 * write creates, edits and deletes labels and milestones. A locked
 * conversation does not stop any of them.
 */
export const METADATA_ACTION_RULES: Readonly<Record<MetadataAction, RepoRole>> = {
  label: "triage",
  assign: "triage",
  set_milestone: "triage",
  manage_labels: "write",
  manage_milestones: "write",
};

/** Whether a caller with `role` (capped by any agents' owners) may take `action`. */
export function decideMetadataAction(
  action: MetadataAction,
  role: RepoRole | null,
): { ok: true } | { ok: false; refusal: "forbidden" } {
  return atLeast(role, METADATA_ACTION_RULES[action])
    ? { ok: true }
    : { ok: false, refusal: "forbidden" };
}
