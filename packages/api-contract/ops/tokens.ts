import { PERMISSION_NAMES } from "@fyrden/domain";
import { z } from "zod";
import { defineOperation } from "../src/op.js";
import { MAX_TOKEN_DAYS } from "./admin.js";

export const UserToken = z.object({
  id: z.string().describe("Token id (tok_ prefix)."),
  type: z.enum(["pat", "git"]),
  scopes: z.array(z.string()),
  repositories: z
    .array(z.string())
    .nullable()
    .describe("Repository ids it is limited to; null for every one its holder can reach."),
  created_at: z.number().int().describe("Unix time in milliseconds."),
  expires_at: z.number().int().describe("Unix time in milliseconds."),
  last_used_at: z.number().int().nullable(),
  revoked: z.boolean(),
});

export const TokenId = z
  .string()
  .regex(/^tok_[0-9A-HJKMNP-TV-Z]{26}$/)
  .describe("The token's id.");

export const listUserTokens = defineOperation({
  id: "users.tokens.list",
  method: "GET",
  path: "/user/tokens",
  summary: "List your tokens",
  description: "Your personal access and git tokens, newest first; revoked and expired ones too.",
  input: z.object({
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
  permission: "tokens:read",
  principals: ["user"],
  rateLimit: "read",
  idempotency: "none",
  mcp: false,
});

export const CreatedUserToken = z.object({
  id: z.string(),
  token: z.string().describe("The token. Shown once and never stored."),
  type: z.enum(["pat", "git"]),
  scopes: z.array(z.string()),
  expires_at: z.number().int().describe("Unix time in milliseconds."),
});

export const createUserToken = defineOperation({
  id: "users.tokens.create",
  method: "POST",
  path: "/user/tokens",
  summary: "Create a token",
  description:
    "Mints a personal access token (`pat`) or a git token (`git`, for clone, fetch and push) for you, never wider than the token or session making it, and returns it once.",
  input: z.object({
    type: z.enum(["pat", "git"]).default("pat"),
    scopes: z
      .array(z.enum(PERMISSION_NAMES))
      .max(32)
      .default([])
      .describe("Permissions it is limited to (and what they imply). Empty: your token's."),
    expires_in_days: z.number().int().min(1).max(MAX_TOKEN_DAYS).default(30),
  }),
  output: CreatedUserToken,
  permission: "tokens:write",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  secretResponse: true,
  // Not an MCP tool: a minted credential would land in a model's context.
  mcp: false,
});

export const revokeUserToken = defineOperation({
  id: "users.tokens.revoke",
  method: "DELETE",
  path: "/user/tokens/{token_id}",
  summary: "Revoke a token",
  description:
    "Revokes one of your tokens: it stops working at once for writes (within 30 seconds for reads).",
  input: z.object({ token_id: TokenId }),
  output: z.object({ id: z.string(), revoked: z.literal(true) }),
  permission: "tokens:write",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  mcp: false,
});
