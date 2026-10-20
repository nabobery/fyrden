import {
  HANDLE_SHAPE,
  MAX_HANDLE_LENGTH,
  MAX_MILESTONE_DESCRIPTION_LENGTH,
  MAX_MILESTONE_TITLE_LENGTH,
  MILESTONE_STATES,
} from "@fyrden/domain";
import { z } from "zod";
import { defineOperation } from "../src/op.js";
import { REPO_NAME_PATTERN } from "./repos.js";
import { Milestone } from "./subject-meta.js";

const RepoInput = {
  owner: z
    .string()
    .min(1)
    .max(MAX_HANDLE_LENGTH)
    .regex(HANDLE_SHAPE)
    .describe("The owner's handle."),
  repo: z.string().regex(REPO_NAME_PATTERN).describe("The repository's name."),
};
const MilestoneNumber = z.coerce.number().int().positive().describe("The milestone's number.");
const Title = z.string().trim().min(1).max(MAX_MILESTONE_TITLE_LENGTH);
const Description = z.string().max(MAX_MILESTONE_DESCRIPTION_LENGTH);
const DueOn = z
  .number()
  .int()
  .min(0)
  .describe("Fyrden: Unix time in milliseconds (GitHub takes an ISO 8601 time).");

const MANAGE =
  "Takes write access, and the `issues:write` or `pull_requests:write` permission (milestones serve both).";
const READ = "Takes the `issues:read` or `pull_requests:read` permission (milestones serve both).";

export const listMilestones = defineOperation({
  id: "milestones.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/milestones",
  summary: "List milestones",
  description: `The repository's milestones by due date, then number; one without a due date counts as due after every date (last ascending, first descending). GitHub's \`completeness\` order is not offered. ${READ}`,
  input: z.object({
    ...RepoInput,
    state: z.enum(["open", "closed", "all"]).default("open"),
    sort: z.enum(["due_on"]).default("due_on"),
    direction: z.enum(["asc", "desc"]).default("asc"),
    per_page: z.coerce.number().int().min(1).max(100).default(30).describe("Page size, 1-100."),
    cursor: z
      .string()
      .max(400)
      .optional()
      .describe("From a previous page's `next_cursor`, with the same filters."),
  }),
  output: z.object({
    milestones: z.array(Milestone),
    next_cursor: z
      .string()
      .nullable()
      .describe("Pass as `cursor` for the next page; null on the last page."),
  }),
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_milestones",
    title: "List milestones",
    description: "List a repository's milestones, open ones by default.",
    readOnly: true,
  },
});

export const getMilestone = defineOperation({
  id: "milestones.get",
  method: "GET",
  path: "/repos/{owner}/{repo}/milestones/{milestone_number}",
  summary: "Get a milestone",
  description: `One milestone, with its open and closed counts as they stand. ${READ}`,
  input: z.object({ ...RepoInput, milestone_number: MilestoneNumber }),
  output: Milestone,
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "get_milestone",
    title: "Get a milestone",
    description: "Get one of a repository's milestones.",
    readOnly: true,
  },
});

export const createMilestone = defineOperation({
  id: "milestones.create",
  method: "POST",
  path: "/repos/{owner}/{repo}/milestones",
  summary: "Create a milestone",
  description: `Creates a milestone; its title must be new. ${MANAGE}`,
  input: z.object({
    ...RepoInput,
    title: Title,
    state: z.enum(MILESTONE_STATES).default("open"),
    description: Description.optional(),
    due_on: DueOn.optional(),
  }),
  output: Milestone,
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  mcp: {
    tool: "create_milestone",
    title: "Create a milestone",
    description: "Create a milestone in a repository (write access).",
    readOnly: false,
  },
});

export const updateMilestone = defineOperation({
  id: "milestones.update",
  method: "PATCH",
  path: "/repos/{owner}/{repo}/milestones/{milestone_number}",
  summary: "Update a milestone",
  description: `Changes a milestone's title, description or due date, or closes or reopens it. ${MANAGE}`,
  input: z.object({
    ...RepoInput,
    milestone_number: MilestoneNumber,
    title: Title.optional(),
    state: z.enum(MILESTONE_STATES).optional(),
    description: Description.nullable().optional().describe("Null clears it."),
    due_on: DueOn.nullable().optional().describe("Null clears it."),
  }),
  output: Milestone,
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "update_milestone",
    title: "Update a milestone",
    description: "Change, close or reopen a milestone (write access).",
    readOnly: false,
  },
});

export const deleteMilestone = defineOperation({
  id: "milestones.delete",
  method: "DELETE",
  path: "/repos/{owner}/{repo}/milestones/{milestone_number}",
  summary: "Delete a milestone",
  description: `Deletes a milestone; its issues and pull requests are in none from then on. Answers what was deleted (GitHub answers 204). ${MANAGE}`,
  input: z.object({ ...RepoInput, milestone_number: MilestoneNumber }),
  output: z.object({ number: z.number().int(), state: z.literal("deleted") }),
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "delete_milestone",
    title: "Delete a milestone",
    description: "Delete a repository's milestone (write access).",
    readOnly: false,
  },
});
