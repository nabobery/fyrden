import { MILESTONE_STATES } from "@fyrden/domain";
import { z } from "zod";

/** Fyrden's version of what an answer shows: an update's `expected_version`. */
export const Version = z
  .number()
  .int()
  .describe(
    "Fyrden: the record's edit baseline, moved by every change of the record itself (not by reactions, counts or what it embeds); an update given it as `expected_version` applies only while it is still this (409 `stale` otherwise).",
  );

/** An update's precondition (Fyrden's): the `version` it was made from. */
export const ExpectedVersion = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe(
    "Fyrden: the `version` the change was made from; refused with 409 `stale` when it changed since.",
  );

/** A label as the API answers it (GitHub's shape). */
export const Label = z.object({
  id: z.number().int(),
  name: z.string(),
  color: z.string(),
  description: z.string().nullable(),
  default: z.boolean().describe("Copied in from a default set."),
  version: Version,
});

/** A milestone as the API answers it (GitHub's shape). */
export const Milestone = z.object({
  id: z.number().int().describe("Fyrden: the number again (milestones have no separate id space)."),
  number: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  state: z.enum(MILESTONE_STATES),
  open_issues: z
    .number()
    .int()
    .describe("Open issues and pull requests in it, of the kinds the caller reads."),
  closed_issues: z
    .number()
    .int()
    .describe("Closed issues, and closed or merged pull requests, of the kinds the caller reads."),
  creator: z.object({ id: z.string() }),
  due_on: z.number().int().nullable().describe("Unix time in milliseconds."),
  created_at: z.number().int().describe("Unix time in milliseconds."),
  updated_at: z.number().int().describe("Unix time in milliseconds."),
  closed_at: z.number().int().nullable().describe("Unix time in milliseconds."),
  version: Version,
});

/** Who is assigned, and what it is sorted by, as issues and pull requests answer it. */
export const SortingOutput = {
  labels: z.array(Label),
  assignee: z
    .object({ id: z.string() })
    .nullable()
    .describe("The first of `assignees` (GitHub's older field); null for none."),
  assignees: z.array(z.object({ id: z.string() })),
  milestone: Milestone.nullable(),
};

/** What reactions a target has, counted by content (GitHub's rollup). */
export const ReactionRollup = z
  .object({
    total_count: z.number().int(),
    "+1": z.number().int(),
    "-1": z.number().int(),
    laugh: z.number().int(),
    confused: z.number().int(),
    heart: z.number().int(),
    hooray: z.number().int(),
    rocket: z.number().int(),
    eyes: z.number().int(),
  })
  .describe("Its reactions counted by content, as they stand.");
