import {
  checkText,
  HANDLE_SHAPE,
  MAX_CHECK_NAME_LENGTH,
  MAX_HANDLE_LENGTH,
  MAX_STATUS_DESCRIPTION_LENGTH,
  MAX_TARGET_URL_LENGTH,
  STATUS_STATES,
  targetUrl,
} from "@fyrden/domain";
import { z } from "zod";
import { defineOperation } from "../src/op.js";
import { REPO_NAME_PATTERN } from "./repos.js";

const RepoInput = {
  owner: z
    .string()
    .min(1)
    .max(MAX_HANDLE_LENGTH)
    .regex(HANDLE_SHAPE)
    .describe("The owner's handle."),
  repo: z.string().regex(REPO_NAME_PATTERN).describe("The repository's name."),
};
const Ref = z
  .string()
  .min(1)
  .max(1024)
  .describe(
    "A full commit SHA, a branch, a tag or a full ref name. One path segment: percent-encode a slash (`feature%2Fx`).",
  );
const PerPage = z.coerce.number().int().min(1).max(100).default(30).describe("Page size, 1-100.");
const Cursor = z.string().max(2_000).optional().describe("From a previous page's `next_cursor`.");
const NextCursor = z
  .string()
  .nullable()
  .describe("Pass as `cursor` for the next page; null on the last page.");

const State = z.enum(STATUS_STATES);

export const CommitStatus = z.object({
  id: z.number().int(),
  state: State,
  context: z.string(),
  description: z.string().nullable(),
  target_url: z.string().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int().describe("A status never changes: its creation time."),
  creator: z.object({ id: z.string() }).describe("The principal that posted it."),
});

const COMPATIBILITY =
  "GitHub's shape, with Fyrden's cursor paging in place of `page`, times in milliseconds, and the creator as an id.";

export const createStatus = defineOperation({
  id: "statuses.create",
  method: "POST",
  path: "/repos/{owner}/{repo}/statuses/{sha}",
  summary: "Create a commit status",
  description: `Posts a status on a commit: \`state\` is \`pending\`, \`success\`, \`failure\` or \`error\`, under a \`context\` (default \`default\`, compared ignoring case) that tells one system's statuses from another's. The commit must be one this repository has (422 \`commit_not_found\`). A commit takes 1,000 statuses of one context and 10,000 in all (422 \`status_limit\`), and 1,000 status summaries (each publisher's contexts, counted across publishers; 422 \`check_limit\`). The status is attributed to the principal that posts it, for an agent acting for a user the agent: a required check naming an expected source matches that principal. ${COMPATIBILITY} Takes the \`statuses:write\` permission.`,
  input: z.object({
    ...RepoInput,
    sha: z
      .string()
      .regex(/^[0-9a-f]{40}$/, "a full commit SHA, lowercase")
      .describe("The commit."),
    state: State,
    target_url: z
      .string()
      .max(MAX_TARGET_URL_LENGTH)
      .refine((url) => targetUrl(url).ok, "an absolute http or https URL")
      .nullable()
      .optional()
      .describe("A link to the status's details (absolute http or https)."),
    // Limits in characters (code points), as the repository counts them; a UTF-16 bound first.
    description: z
      .string()
      .max(MAX_STATUS_DESCRIPTION_LENGTH * 2)
      .refine(
        (text) => text === "" || checkText(text, MAX_STATUS_DESCRIPTION_LENGTH).ok,
        `at most ${MAX_STATUS_DESCRIPTION_LENGTH} characters, no control characters`,
      )
      .nullable()
      .optional()
      .describe(`A short description, at most ${MAX_STATUS_DESCRIPTION_LENGTH} characters.`),
    context: z
      .string()
      .max(MAX_CHECK_NAME_LENGTH * 2)
      .refine(
        (text) => checkText(text, MAX_CHECK_NAME_LENGTH).ok,
        `1 to ${MAX_CHECK_NAME_LENGTH} characters, no control characters`,
      )
      .default("default")
      .describe("The label that tells this system's statuses from others'."),
  }),
  output: CommitStatus,
  permission: "statuses:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  mcp: {
    tool: "create_commit_status",
    title: "Create a commit status",
    description:
      "Post a status (pending, success, failure or error) on a commit under a context, such as a CI result.",
    readOnly: false,
  },
});

export const listStatuses = defineOperation({
  id: "statuses.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/commits/{ref}/statuses",
  summary: "List commit statuses for a reference",
  description: `Every status posted on the commit \`ref\` names, newest first. ${COMPATIBILITY} Takes the \`statuses:read\` permission.`,
  input: z.object({ ...RepoInput, ref: Ref, per_page: PerPage, cursor: Cursor }),
  output: z.object({ statuses: z.array(CommitStatus), next_cursor: NextCursor }),
  permission: "statuses:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_commit_statuses",
    title: "List commit statuses",
    description: "List the statuses posted on a commit (by SHA, branch or tag), newest first.",
    readOnly: true,
  },
});

export const getCombinedStatus = defineOperation({
  id: "statuses.combined",
  method: "GET",
  path: "/repos/{owner}/{repo}/commits/{ref}/status",
  summary: "Get the combined status for a reference",
  description: `The latest status of each context on the commit \`ref\` names, whoever posted it, in context order, and their roll-up: \`failure\` if any is \`failure\` or \`error\`, else \`pending\` if there are none or any is \`pending\`, else \`success\`. \`state\` and \`total_count\` cover every context, whatever the page. ${COMPATIBILITY} Takes the \`statuses:read\` permission.`,
  input: z.object({ ...RepoInput, ref: Ref, per_page: PerPage, cursor: Cursor }),
  output: z.object({
    state: z.enum(["pending", "success", "failure"]),
    sha: z.string().describe("The commit the ref named."),
    total_count: z.number().int().describe("Contexts with a status."),
    statuses: z.array(CommitStatus),
    next_cursor: NextCursor,
  }),
  permission: "statuses:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "get_combined_status",
    title: "Get a commit's combined status",
    description:
      "Get the latest status of each context on a commit (by SHA, branch or tag) and whether they pass together.",
    readOnly: true,
  },
});
