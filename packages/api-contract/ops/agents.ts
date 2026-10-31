import { HANDLE_SHAPE, MAX_HANDLE_LENGTH, SCOPE_NAMES } from "@fyrden/domain";
import { z } from "zod";
import { defineOperation } from "../src/op.js";
import { MAX_TOKEN_DAYS, NewHandle } from "./admin.js";
import { TokenId, UserToken } from "./tokens.js";

export const Agent = z.object({
  id: z.string().describe("Agent id (agt_ prefix)."),
  handle: z.string(),
  display_name: z.string().nullable(),
  owner: z.string().describe("The handle of the user or organization that owns the agent."),
  owner_id: z.string(),
  created_at: z.number().int().describe("Unix time in milliseconds."),
  disabled: z.boolean().describe("A disabled agent's tokens and grants stop working."),
});

const AgentHandle = z
  .string()
  .min(1)
  .max(MAX_HANDLE_LENGTH)
  .regex(HANDLE_SHAPE)
  .describe("The agent's handle: 1-39 letters, digits and single inner hyphens.");

export const createAgent = defineOperation({
  id: "agents.create",
  method: "POST",
  path: "/agents",
  summary: "Create an agent",
  description:
    "Creates an agent principal owned by you, or by an organization you own (`org`). An agent acts with its own tokens and collaborator roles, or for a user under a delegation grant; either way it never exceeds its owner.",
  input: z.object({
    handle: NewHandle.describe(
      "1-39 letters, digits and single inner hyphens; unique among all handles, ignoring case; not reserved.",
    ),
    display_name: z.string().min(1).max(100).optional(),
    org: z
      .string()
      .min(1)
      .max(MAX_HANDLE_LENGTH)
      .regex(HANDLE_SHAPE)
      .optional()
      .describe("An organization you own to own the agent; you when absent."),
  }),
  output: Agent,
  permission: "agents:write",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  mcp: {
    tool: "create_agent",
    title: "Create an agent",
    description: "Create an agent principal owned by you (or an organization you own).",
    readOnly: false,
  },
});

export const listAgents = defineOperation({
  id: "agents.list",
  method: "GET",
  path: "/agents",
  summary: "List agents",
  description: "Your agents, or those of an organization you own (`org`), oldest first.",
  input: z.object({
    org: z.string().min(1).max(MAX_HANDLE_LENGTH).regex(HANDLE_SHAPE).optional(),
    per_page: z.coerce.number().int().min(1).max(100).default(30).describe("Page size, 1-100."),
    cursor: z.string().max(200).optional().describe("From a previous page's `next_cursor`."),
  }),
  output: z.object({
    agents: z.array(Agent),
    next_cursor: z
      .string()
      .nullable()
      .describe("Pass as `cursor` for the next page; null on the last page."),
  }),
  permission: "agents:read",
  principals: ["user"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_agents",
    title: "List agents",
    description: "List your agents, or an organization's you own, a page at a time.",
    readOnly: true,
  },
});

export const getAgent = defineOperation({
  id: "agents.get",
  method: "GET",
  path: "/agents/{agent}",
  summary: "Get an agent",
  description: "An agent you own, or one an organization you own owns.",
  input: z.object({ agent: AgentHandle }),
  output: Agent,
  permission: "agents:read",
  principals: ["user"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "get_agent",
    title: "Get an agent",
    description: "Get one of your agents (or an organization's you own).",
    readOnly: true,
  },
});

export const disableAgent = defineOperation({
  id: "agents.disable",
  method: "DELETE",
  path: "/agents/{agent}",
  summary: "Disable an agent",
  description:
    "Disables an agent: its tokens, the tokens issued for it under delegation grants, and its grants stop working at once for writes (within 30 seconds for reads). Its handle stays taken.",
  input: z.object({ agent: AgentHandle }),
  output: Agent,
  permission: "agents:write",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "disable_agent",
    title: "Disable an agent",
    description: "Disable an agent: its tokens and grants stop at once for writes.",
    readOnly: false,
  },
});

export const CreatedAgentToken = z.object({
  id: z.string().describe("Token id (tok_ prefix)."),
  token: z.string().describe("The token. Shown once and never stored."),
  type: z.enum(["pat", "git"]),
  agent_id: z.string(),
  scopes: z.array(z.string()),
  expires_at: z.number().int().describe("Unix time in milliseconds."),
});

export const createAgentToken = defineOperation({
  id: "agents.tokens.create",
  method: "POST",
  path: "/agents/{agent}/tokens",
  summary: "Create a token for an agent",
  description:
    "Mints a token the agent acts with as itself: a personal access token (`pat`, also the subject of a token exchange) or a git token (`git`), never wider than your token (its scopes and repositories). Returned once.",
  input: z.object({
    agent: AgentHandle,
    type: z.enum(["pat", "git"]).default("pat"),
    scopes: z
      .array(z.enum(SCOPE_NAMES))
      .max(32)
      .default([])
      .describe(
        "Permissions the token is limited to (and what they imply), within your token's. Empty: your token's (for an unrestricted token, the agent's full rights, capped by its owner's).",
      ),
    expires_in_days: z.number().int().min(1).max(MAX_TOKEN_DAYS).default(30),
  }),
  output: CreatedAgentToken,
  permission: "agents:write",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  secretResponse: true,
  // Not an MCP tool: a minted credential would land in a model's context.
  mcp: false,
});

export const listAgentTokens = defineOperation({
  id: "agents.tokens.list",
  method: "GET",
  path: "/agents/{agent}/tokens",
  summary: "List an agent's tokens",
  description:
    "The tokens an agent acts with as itself (personal access and git tokens), newest first; revoked and expired ones too. Never the token values.",
  input: z.object({
    agent: AgentHandle,
    per_page: z.coerce.number().int().min(1).max(100).default(30).describe("Page size, 1-100."),
    cursor: z.string().max(200).optional().describe("From a previous page's `next_cursor`."),
  }),
  output: z.object({
    tokens: z.array(UserToken),
    next_cursor: z
      .string()
      .nullable()
      .describe("Pass as `cursor` for the next page; null on the last page."),
  }),
  permission: "agents:read",
  principals: ["user"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_agent_tokens",
    title: "List an agent's tokens",
    description: "List an agent's tokens (never their values), newest first.",
    readOnly: true,
  },
});

export const revokeAgentToken = defineOperation({
  id: "agents.tokens.revoke",
  method: "DELETE",
  path: "/agents/{agent}/tokens/{token_id}",
  summary: "Revoke an agent's token",
  description:
    "Revokes one of an agent's tokens: it stops working at once for writes (within 30 seconds for reads); the agent's other tokens keep working.",
  input: z.object({ agent: AgentHandle, token_id: TokenId }),
  output: z.object({ id: z.string(), revoked: z.literal(true) }),
  permission: "agents:write",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "revoke_agent_token",
    title: "Revoke an agent's token",
    description: "Revoke one of an agent's tokens.",
    readOnly: false,
  },
});
