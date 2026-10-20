import { MILESTONE_STATES } from "@fyrden/domain";
import { z } from "zod";

/** A label as the API answers it (GitHub's shape). */
export const Label = z.object({
  id: z.number().int(),
  name: z.string(),
  color: z.string(),
  description: z.string().nullable(),
  default: z.boolean().describe("Copied in from a default set."),
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
