import {
  CHECK_CONCLUSIONS,
  CHECK_STATUSES,
  HANDLE_SHAPE,
  MAX_CHECK_NAME_LENGTH,
  MAX_HANDLE_LENGTH,
} from "@fyrden/domain";
import { z } from "zod";
import { defineOperation } from "../src/op.js";
import { REPO_NAME_PATTERN } from "./repos.js";

/** A check of Fyrden's CI on a commit. */
export const CheckRun = z.object({
  name: z.string(),
  head_sha: z.string(),
  status: z.enum(CHECK_STATUSES),
  conclusion: z.enum(CHECK_CONCLUSIONS).nullable(),
  attempt: z
    .number()
    .int()
    .describe(
      "Fyrden: 1, then one more each time a run starts a check of this name on the commit.",
    ),
  run: z
    .object({
      id: z.string(),
      run_attempt: z.number().int(),
      job_id: z
        .number()
        .int()
        .nullable()
        .describe(
          "The job within the run; null for a workflow file that could not run, and for a name a re-run settled without a job of that name.",
        ),
    })
    .nullable()
    .describe("Fyrden: the CI run it came from; null once that run is no longer kept."),
  details_url: z.string().nullable(),
  updated_at: z.number().int().describe("Unix time in milliseconds."),
});

export const listCheckRuns = defineOperation({
  id: "checks.runs.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/commits/{ref}/check-runs",
  summary: "List check runs for a reference",
  description:
    "The checks Fyrden's CI published on the commit `ref` names, in name order: the latest of each name, so of two runs whose jobs share a name on one commit, the later start. Commit statuses, which others post, are `statuses.combined`'s; what a pull request's base branch requires of both is `pulls.required_checks.get`'s. GitHub's shape in part: Fyrden's run and job ids in place of check run, suite and app ids, times in milliseconds and cursor paging; `total_count` counts every match, whatever the page. `filter=all` and `app_id` are refused (422 `unsupported_parameter`). Takes the `statuses:read` permission.",
  input: z.object({
    owner: z
      .string()
      .min(1)
      .max(MAX_HANDLE_LENGTH)
      .regex(HANDLE_SHAPE)
      .describe("The owner's handle."),
    repo: z.string().regex(REPO_NAME_PATTERN).describe("The repository's name."),
    ref: z
      .string()
      .min(1)
      .max(1024)
      .describe(
        "A full commit SHA, a branch, a tag or a full ref name. One path segment: percent-encode a slash (`feature%2Fx`).",
      ),
    check_name: z
      .string()
      .min(1)
      .max(MAX_CHECK_NAME_LENGTH * 2)
      .optional()
      .describe("Only the check of this name, ignoring case."),
    status: z.enum(CHECK_STATUSES).optional().describe("Only checks of this status."),
    filter: z
      .enum(["latest", "all"])
      .default("latest")
      .describe("`latest` only: earlier attempts of a name are not listed."),
    app_id: z
      .unknown()
      .optional()
      .describe("Not supported (422 `unsupported_parameter`): checks come from Fyrden's CI alone."),
    per_page: z.coerce.number().int().min(1).max(100).default(30).describe("Page size, 1-100."),
    cursor: z
      .string()
      .max(2_000)
      .optional()
      .describe("From a previous page's `next_cursor`, with the same filters."),
  }),
  output: z.object({
    total_count: z.number().int(),
    check_runs: z.array(CheckRun),
    next_cursor: z
      .string()
      .nullable()
      .describe("Pass as `cursor` for the next page; null on the last page."),
  }),
  permission: "statuses:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_check_runs",
    title: "List a commit's check runs",
    description:
      "List the checks CI published on a commit (by SHA, branch or tag), each with the run and job it came from. Commit statuses are get_combined_status's.",
    readOnly: true,
  },
});
