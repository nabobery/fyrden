import { HANDLE_PATTERN, PERMISSION_NAMES } from "@fyrden/domain";
import { z } from "zod";
import { defineOperation, INSTANCE_ADMIN } from "../src/op.js";

/** Longest lifetime an administrator can give a token. */
export const MAX_TOKEN_DAYS = 365;

export const CreatedUser = z.object({
  id: z.string().describe("User id (usr_ prefix)."),
  handle: z.string(),
  type: z.literal("user"),
  created_at: z.number().int().describe("Unix time in milliseconds."),
});

export const createUser = defineOperation({
  id: "admin.users.create",
  method: "POST",
  path: "/admin/users",
  summary: "Create a user",
  description: "Creates a user account. Instance administrators only.",
  input: z.object({
    handle: z
      .string()
      .regex(HANDLE_PATTERN)
      .describe("1-39 letters, digits and single inner hyphens; unique, ignoring case."),
  }),
  output: CreatedUser,
  permission: INSTANCE_ADMIN,
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  mcp: {
    tool: "create_user",
    title: "Create a user",
    description:
      "Create a user account on this Fyrden instance. Requires an instance administrator.",
    readOnly: false,
  },
});

export const CreatedToken = z.object({
  id: z.string().describe("Token id (tok_ prefix); use it to revoke the token."),
  token: z.string().describe("The token. Shown once and never stored."),
  type: z.enum(["pat", "git"]),
  user_id: z.string(),
  scopes: z.array(z.string()),
  expires_at: z.number().int().describe("Unix time in milliseconds."),
});

export const createToken = defineOperation({
  id: "admin.tokens.create",
  method: "POST",
  path: "/admin/users/{user_id}/tokens",
  summary: "Create a token for a user",
  description:
    "Mints a personal access token (`pat`) or git token (`git`) for a user and returns it once. Instance administrators only.",
  input: z.object({
    user_id: z.string().min(1),
    type: z.enum(["pat", "git"]).default("pat"),
    scopes: z
      .array(z.enum(PERMISSION_NAMES))
      .max(32)
      .default([])
      .describe(
        "Permissions the token is limited to (and what they imply). Empty: the user's full rights.",
      ),
    expires_in_days: z.number().int().min(1).max(MAX_TOKEN_DAYS).default(30),
  }),
  output: CreatedToken,
  permission: INSTANCE_ADMIN,
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  secretResponse: true,
  // Not an MCP tool: a minted credential would land in a model's context.
  mcp: false,
});
