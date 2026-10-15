import { HANDLE_PATTERN, PERMISSION_NAMES } from "@fyrden/domain";
import { z } from "zod";
import { defineOperation } from "../src/op.js";

/** Longest a delegation grant lasts. Proposed. */
export const MAX_GRANT_DAYS = 365;

const GrantId = z
  .string()
  .regex(/^grt_[0-9A-HJKMNP-TV-Z]{26}$/)
  .describe("The grant's id.");

export const Grant = z.object({
  id: z.string().describe("Grant id (grt_ prefix)."),
  grantor: z.string().describe("The handle of the user the agent acts for."),
  grantor_id: z.string(),
  agent: z.string().describe("The handle of the agent the grant lets act."),
  agent_id: z.string(),
  parent_id: z
    .string()
    .nullable()
    .describe("The grant this one was passed down from (to a sub-agent); null for a user's own."),
  root_id: z.string().describe("The user's grant at the top of the chain."),
  depth: z.number().int().describe("1 for a user's grant, 2 for a sub-agent's."),
  scopes: z.array(z.string()),
  repositories: z
    .array(z.string())
    .nullable()
    .describe("Repository ids the grant is limited to; null for every one the user can reach."),
  expires_at: z.number().int().describe("Unix time in milliseconds."),
  created_at: z.number().int().describe("Unix time in milliseconds."),
  revoked_at: z.number().int().nullable(),
});

export const createGrant = defineOperation({
  id: "grants.create",
  method: "POST",
  path: "/grants",
  summary: "Create a delegation grant",
  description:
    "Lets an agent act for you, limited to `scopes`, `repositories` and an expiry: the agent exchanges its own token for a delegated one (`POST /oauth/token`, RFC 8693). An agent holding a grant may pass a narrower one (`parent`) to another agent of its owner, one hop down at most. Revoking a grant revokes the tokens issued under it and its sub-grants.",
  input: z.object({
    agent: z.string().regex(HANDLE_PATTERN).describe("The agent's handle."),
    scopes: z
      .array(z.enum(PERMISSION_NAMES))
      .min(1)
      .max(32)
      .describe("Permissions the agent may use for you (and what they imply)."),
    repositories: z
      .array(z.string().regex(/^[^/\s]+\/[^/\s]+$/))
      .min(1)
      .max(100)
      .optional()
      .describe(
        "`owner/name` of each repository it is limited to; every one you can reach when absent.",
      ),
    expires_in_days: z.number().int().min(1).max(MAX_GRANT_DAYS).default(30),
    parent: GrantId.optional().describe(
      "For an agent: the grant it holds and passes a narrower one of to another agent.",
    ),
  }),
  output: Grant,
  permission: "grants:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  mcp: {
    tool: "create_grant",
    title: "Create a delegation grant",
    description:
      "Let an agent act for you (or pass a narrower grant down one hop) with scopes, repositories and an expiry.",
    readOnly: false,
  },
});

export const listGrants = defineOperation({
  id: "grants.list",
  method: "GET",
  path: "/grants",
  summary: "List delegation grants",
  description:
    "The grants you made (a user), or that you hold or passed down (an agent), newest first; revoked ones too.",
  input: z.object({
    per_page: z.coerce.number().int().min(1).max(100).default(30).describe("Page size, 1-100."),
    cursor: z.string().max(200).optional().describe("From a previous page's `next_cursor`."),
  }),
  output: z.object({
    grants: z.array(Grant),
    next_cursor: z
      .string()
      .nullable()
      .describe("Pass as `cursor` for the next page; null on the last page."),
  }),
  permission: "grants:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_grants",
    title: "List delegation grants",
    description: "List the delegation grants you made, hold or passed down, a page at a time.",
    readOnly: true,
  },
});

export const revokeGrant = defineOperation({
  id: "grants.revoke",
  method: "DELETE",
  path: "/grants/{grant_id}",
  summary: "Revoke a delegation grant",
  description:
    "Revokes a grant and the grants passed down from it: every token issued under them stops working at once for writes (within 30 seconds for reads). Its user, or the agent that passed it down, may revoke it.",
  input: z.object({ grant_id: GrantId }),
  output: Grant,
  permission: "grants:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "revoke_grant",
    title: "Revoke a delegation grant",
    description: "Revoke a grant and those passed down from it; tokens under them stop.",
    readOnly: false,
  },
});
