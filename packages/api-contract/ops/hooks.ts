import { HANDLE_PATTERN } from "@fyrden/domain";
import { z } from "zod";
import { defineOperation } from "../src/op.js";
import { REPO_NAME_PATTERN } from "./repos.js";

const RepoInput = {
  owner: z.string().regex(HANDLE_PATTERN).describe("The owner's handle."),
  repo: z.string().regex(REPO_NAME_PATTERN).describe("The repository's name."),
};
const HookId = z.coerce.number().int().positive().describe("The webhook's id.");
const HookEvent = z.enum([
  "push",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issue_comment",
  "*",
]);
const Url = z
  .string()
  .max(2048)
  .describe(
    "Where deliveries are posted: https (http only for a public repository), never this server or a private address.",
  );

export const Hook = z.object({
  id: z.number().int(),
  name: z.literal("web"),
  active: z.boolean(),
  events: z.array(z.string()),
  config: z.object({ url: z.string(), content_type: z.literal("json") }),
  created_at: z.string(),
  updated_at: z.string(),
  last_response: z.object({
    code: z.number().int().nullable(),
    status: z.string(),
    message: z.string().nullable(),
  }),
  disabled_reason: z
    .string()
    .nullable()
    .describe("Fyrden: why the server turned the hook off (its receiver answered 410 Gone)."),
  secrets: z
    .number()
    .int()
    .describe("Fyrden: secrets that sign its deliveries (two while one is being replaced)."),
});

const Secret = z
  .string()
  .describe(
    "The signing secret (`whsec_…`, Standard Webhooks): shown this once; verify deliveries' `webhook-signature` with it.",
  );

export const listHooks = defineOperation({
  id: "repos.hooks.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/hooks",
  summary: "List repository webhooks",
  description: "The repository's webhooks. Administrators only.",
  input: z.object(RepoInput),
  output: z.array(Hook),
  permission: "repository_hooks:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_webhooks",
    title: "List repository webhooks",
    description: "List the webhooks of a repository you administer.",
    readOnly: true,
  },
});

export const getHook = defineOperation({
  id: "repos.hooks.get",
  method: "GET",
  path: "/repos/{owner}/{repo}/hooks/{hook_id}",
  summary: "Get a repository webhook",
  description: "One webhook. Administrators only.",
  input: z.object({ ...RepoInput, hook_id: HookId }),
  output: Hook,
  permission: "repository_hooks:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "get_webhook",
    title: "Get a repository webhook",
    description: "Get one webhook of a repository you administer.",
    readOnly: true,
  },
});

export const createHook = defineOperation({
  id: "repos.hooks.create",
  method: "POST",
  path: "/repos/{owner}/{repo}/hooks",
  summary: "Create a repository webhook",
  description:
    "Adds a webhook (at most 20 a repository) and sends it a `ping`. Fyrden signs deliveries with Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature`), with a secret the server makes: it is in this answer only. Events: `push`, `pull_request`, `pull_request_review`, `pull_request_review_comment`, `issue_comment`, or `*`. Administrators only.",
  input: z.object({
    ...RepoInput,
    name: z.literal("web").optional(),
    config: z.object({
      url: Url,
      content_type: z.literal("json").optional(),
    }),
    events: z.array(HookEvent).min(1).max(6).default(["push"]),
    active: z.boolean().default(true),
  }),
  output: Hook.extend({ secret: Secret }),
  permission: "repository_hooks:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  secretResponse: true,
  // A secret in the answer: REST only.
  mcp: false,
});

export const updateHook = defineOperation({
  id: "repos.hooks.update",
  method: "PATCH",
  path: "/repos/{owner}/{repo}/hooks/{hook_id}",
  summary: "Update a repository webhook",
  description:
    "Changes a webhook's URL, events or state (turning it on clears why the server turned it off). Deliveries waiting for an attempt go to the new URL. Administrators only.",
  input: z.object({
    ...RepoInput,
    hook_id: HookId,
    config: z
      .object({ url: Url.optional(), content_type: z.literal("json").optional() })
      .optional(),
    events: z.array(HookEvent).min(1).max(6).optional(),
    add_events: z.array(HookEvent).max(6).optional(),
    remove_events: z.array(HookEvent).max(6).optional(),
    active: z.boolean().optional(),
  }),
  output: Hook,
  permission: "repository_hooks:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: false,
});

export const deleteHook = defineOperation({
  id: "repos.hooks.delete",
  method: "DELETE",
  path: "/repos/{owner}/{repo}/hooks/{hook_id}",
  summary: "Delete a repository webhook",
  description: "Removes a webhook; its waiting deliveries are cancelled. Administrators only.",
  input: z.object({ ...RepoInput, hook_id: HookId }),
  output: z.object({ id: z.number().int(), state: z.literal("deleted") }),
  permission: "repository_hooks:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: false,
});

export const pingHook = defineOperation({
  id: "repos.hooks.pings.create",
  method: "POST",
  path: "/repos/{owner}/{repo}/hooks/{hook_id}/pings",
  summary: "Ping a repository webhook",
  description: "Sends the webhook a `ping` delivery. Administrators only.",
  input: z.object({ ...RepoInput, hook_id: HookId }),
  output: z.object({ id: z.number().int(), state: z.literal("pinged") }),
  permission: "repository_hooks:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "ping_webhook",
    title: "Ping a repository webhook",
    description: "Send a webhook of a repository you administer a ping delivery.",
    readOnly: false,
  },
});

export const rotateHookSecret = defineOperation({
  id: "repos.hooks.secret.rotate",
  method: "POST",
  path: "/repos/{owner}/{repo}/hooks/{hook_id}/secret",
  summary: "Rotate a webhook's secret",
  description:
    "Fyrden: a new signing secret (in this answer only). Deliveries are signed with both the new and the previous secret for a week, or until the previous one is dropped. Administrators only.",
  input: z.object({ ...RepoInput, hook_id: HookId }),
  output: z.object({ id: z.number().int(), secret: Secret }),
  permission: "repository_hooks:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  secretResponse: true,
  mcp: false,
});

export const dropPreviousHookSecret = defineOperation({
  id: "repos.hooks.secret.drop",
  method: "DELETE",
  path: "/repos/{owner}/{repo}/hooks/{hook_id}/secret/previous",
  summary: "Drop a webhook's previous secret",
  description:
    "Fyrden: stops signing deliveries with the secret a rotation replaced. Administrators only.",
  input: z.object({ ...RepoInput, hook_id: HookId }),
  output: z.object({ id: z.number().int(), secrets: z.number().int() }),
  permission: "repository_hooks:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: false,
});

const DeliveryState = z.enum(["pending", "done", "failed", "cancelled", "dropped"]);

const Delivery = z.object({
  id: z.string().describe("The delivery's `webhook-id` (the same on every attempt)."),
  event: z.string(),
  action: z.string().nullable(),
  state: DeliveryState,
  reason: z.string().nullable().describe("Why it failed, was cancelled or dropped."),
  status_code: z.number().int().nullable().describe("The last attempt's response status."),
  attempts: z.number().int(),
  delivered_at: z.string(),
  next_attempt_at: z.string().nullable(),
});

export const listHookDeliveries = defineOperation({
  id: "repos.hooks.deliveries.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/hooks/{hook_id}/deliveries",
  summary: "List deliveries for a repository webhook",
  description: "The webhook's deliveries of the last 30 days, newest first. Administrators only.",
  input: z.object({
    ...RepoInput,
    hook_id: HookId,
    per_page: z.coerce.number().int().min(1).max(100).default(30),
    cursor: z.string().max(200).optional().describe("From a previous page's `next_cursor`."),
  }),
  output: z.object({
    deliveries: z.array(Delivery),
    next_cursor: z.string().nullable(),
  }),
  permission: "repository_hooks:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_webhook_deliveries",
    title: "List webhook deliveries",
    description: "List the recent deliveries of a webhook of a repository you administer.",
    readOnly: true,
  },
});

export const getHookDelivery = defineOperation({
  id: "repos.hooks.deliveries.get",
  method: "GET",
  path: "/repos/{owner}/{repo}/hooks/{hook_id}/deliveries/{delivery_id}",
  summary: "Get a delivery for a repository webhook",
  description:
    "One delivery: its body and each attempt (where it was sent, what came back, the first 4 KiB of the response). Administrators only.",
  input: z.object({
    ...RepoInput,
    hook_id: HookId,
    delivery_id: z.string().regex(/^msg_[0-9a-f]{32}$/),
  }),
  output: Delivery.extend({
    request: z.object({ payload: z.record(z.string(), z.unknown()).nullable() }),
    attempts_made: z.array(
      z.object({
        n: z.number().int(),
        at: z.string(),
        url: z.string().nullable(),
        status_code: z.number().int().nullable(),
        duration_ms: z.number().int().nullable(),
        response: z.string().nullable(),
        error: z.string().nullable(),
      }),
    ),
  }),
  permission: "repository_hooks:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "get_webhook_delivery",
    title: "Get a webhook delivery",
    description: "Get one delivery of a webhook, with its body and attempts.",
    readOnly: true,
  },
});

export const redeliverHookDelivery = defineOperation({
  id: "repos.hooks.deliveries.redeliver",
  method: "POST",
  path: "/repos/{owner}/{repo}/hooks/{hook_id}/deliveries/{delivery_id}/attempts",
  summary: "Redeliver a delivery for a repository webhook",
  description:
    "Sends a finished delivery (`done` or `failed`) once more: its original body, the same `webhook-id`, signed with the hook's current secrets at a fresh timestamp. One attempt, not retried; queued, the answer comes before it is made. Refused while it is pending (409 `delivery_pending`), while a 410 from its receiver is turning the hook off (409 `hook_being_disabled`), for a delivery that was cancelled or dropped (422 `not_redeliverable`), once its body is gone (422 `payload_gone`), for an inactive hook (422 `hook_inactive`), and while the hook has 1,000 deliveries waiting (409 `too_many_outstanding`). Administrators only.",
  input: z.object({
    ...RepoInput,
    hook_id: HookId,
    delivery_id: z.string().regex(/^msg_[0-9a-f]{32}$/),
  }),
  output: Delivery,
  permission: "repository_hooks:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 202,
  mcp: {
    tool: "redeliver_webhook_delivery",
    title: "Redeliver a webhook delivery",
    description: "Send a finished webhook delivery once more, with its original body.",
    readOnly: false,
  },
});

export const resealHookSecrets = defineOperation({
  id: "admin.webhooks.reseal",
  method: "POST",
  path: "/admin/webhooks/reseal",
  summary: "Seal webhook secrets with the current key",
  description:
    "Fyrden: seals again, with `WEBHOOKS_KEY`, webhook secrets sealed with a retired key, a batch of repositories at a time (call again with `cursor` until `next_cursor` is null and `remaining` is 0); `unreadable` counts secrets whose key is gone (rotate those hooks' secrets). Instance administrators only.",
  input: z.object({
    cursor: z.string().max(200).optional(),
  }),
  output: z.object({
    resealed: z.number().int(),
    remaining: z.number().int(),
    unreadable: z.number().int(),
    next_cursor: z.string().nullable(),
  }),
  permission: "instance:admin",
  principals: ["user"],
  rateLimit: "expensive",
  idempotency: "key",
  mcp: false,
});
