import { HANDLE_SHAPE, MAX_HANDLE_LENGTH } from "@fyrden/domain";
import { z } from "zod";
import { defineOperation, NoContent } from "../src/op.js";

const Org = z
  .string()
  .min(1)
  .max(MAX_HANDLE_LENGTH)
  .regex(HANDLE_SHAPE)
  .describe("The organization's handle.");
const RunnerId = z.coerce.number().int().positive().describe("The runner's id.");

const SWITCH_NOTE =
  " While the deployment has not turned self-hosted runners on (`FYRDEN_CI_RUNNERS`), a registration token is refused with 409 `runners_off`.";

export const RunnerRegistrationToken = z.object({
  token: z
    .string()
    .describe(
      "The registration token (`fyrden_run_` prefix): registers one runner, once. Shown once and never stored.",
    ),
  expires_at: z.number().int().describe("Unix time in milliseconds: an hour after it was made."),
});

export const createRunnerRegistrationToken = defineOperation({
  id: "orgs.runners.registration_tokens.create",
  method: "POST",
  path: "/orgs/{org}/actions/runners/registration-token",
  summary: "Create a runner registration token",
  description: `Mints a token that registers one self-hosted runner for the organization (\`gitea/runner register --token\`), within the hour. The runner serves every repository of the organization whose jobs its labels match. Owners only.${SWITCH_NOTE}`,
  input: z.object({ org: Org }),
  output: RunnerRegistrationToken,
  permission: "self_hosted_runners:write",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  secretResponse: true,
  // Not an MCP tool: a credential would land in a model's context.
  mcp: false,
});

export const SelfHostedRunner = z.object({
  id: z.number().int(),
  name: z.string(),
  labels: z.array(z.string()).describe("As the runner last declared them."),
  version: z.string().describe("The runner's version, as it last declared it."),
  ephemeral: z.boolean().describe("Registered to take one job."),
  created_at: z.number().int().describe("Unix time in milliseconds: when it registered."),
  declared_at: z
    .number()
    .int()
    .nullable()
    .describe(
      "Unix time in milliseconds: when its daemon last started; null when it never has (a registration whose answer was lost: delete it).",
    ),
  revoked_at: z
    .number()
    .int()
    .nullable()
    .describe(
      "Unix time in milliseconds: when it was deleted; its credential stopped working then.",
    ),
});

export const listRunners = defineOperation({
  id: "orgs.runners.list",
  method: "GET",
  path: "/orgs/{org}/actions/runners",
  summary: "List an organization's self-hosted runners",
  description:
    "Lists the organization's self-hosted runners, oldest first, deleted ones too; never their credentials. Owners only.",
  input: z.object({
    org: Org,
    per_page: z.coerce.number().int().min(1).max(100).default(30).describe("Page size, 1-100."),
    cursor: z.string().max(200).optional().describe("From a previous page's `next_cursor`."),
  }),
  output: z.object({
    runners: z.array(SelfHostedRunner),
    next_cursor: z
      .string()
      .nullable()
      .describe("Pass as `cursor` for the next page; null on the last page."),
  }),
  permission: "self_hosted_runners:read",
  principals: ["user"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_org_runners",
    title: "List self-hosted runners",
    description: "List an organization's self-hosted runners (never their credentials).",
    readOnly: true,
  },
});

export const deleteRunner = defineOperation({
  id: "orgs.runners.delete",
  method: "DELETE",
  path: "/orgs/{org}/actions/runners/{runner_id}",
  summary: "Delete a self-hosted runner",
  description:
    "Revokes a runner's credential at once: its next call is refused and the runner stops. It stays listed, with `revoked_at`. Deleting it again changes nothing. Owners only.",
  input: z.object({ org: Org, runner_id: RunnerId }),
  output: NoContent,
  permission: "self_hosted_runners:write",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 204,
  mcp: {
    tool: "delete_org_runner",
    title: "Delete a self-hosted runner",
    description: "Revoke an organization's self-hosted runner; it stops at its next call.",
    readOnly: false,
  },
});
