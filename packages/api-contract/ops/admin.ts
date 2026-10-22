import {
  HANDLE_SHAPE,
  isReservedHandle,
  MAX_HANDLE_LENGTH,
  PERMISSION_NAMES,
} from "@fyrden/domain";
import { z } from "zod";
import { defineOperation, INSTANCE_ADMIN, NoContent } from "../src/op.js";

/** A new user's, organization's or agent's handle: valid, and not one the web origin's paths take. */
export const NewHandle = z
  .string()
  .min(1)
  .max(MAX_HANDLE_LENGTH)
  .regex(HANDLE_SHAPE)
  .refine((handle) => !isReservedHandle(handle), "is reserved");

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
    handle: NewHandle.describe(
      "1-39 letters, digits and single inner hyphens; unique, ignoring case; not reserved.",
    ),
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

/** Why an administrator suspends or unsuspends a user: kept with the change, shown to administrators. */
const Reason = z.string().max(200).optional();

export const suspendUser = defineOperation({
  id: "admin.users.suspend",
  method: "PUT",
  path: "/users/{username}/suspended",
  summary: "Suspend a user",
  description:
    "Suspends a user, as GitHub Enterprise does: the user can no longer sign in, and none of their tokens, nor those of the agents they own, work while suspended; their sessions and OAuth tokens are revoked for good. Their repositories stay available to their collaborators. Suspending a suspended user changes nothing. Instance administrators only; not yourself, nor the last active administrator.",
  input: z.object({
    username: z.string().min(1).max(64),
    reason: Reason,
  }),
  output: NoContent,
  permission: INSTANCE_ADMIN,
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 204,
  mcp: {
    tool: "suspend_user",
    title: "Suspend a user",
    description:
      "Suspend a user on this Fyrden instance: they cannot sign in and their tokens stop working until unsuspended. Requires an instance administrator.",
    readOnly: false,
  },
});

/** A user deletion, as its job stands. */
export const UserDeletion = z.object({
  id: z
    .string()
    .describe("The user's id (usr_ prefix); their handle is released, and the id names them."),
  state: z
    .enum(["deleting", "deleted"])
    .describe("`deleting` while the deletion runs; `deleted` once it is done."),
  step: z
    .enum(["repositories", "accounts", "stars", "feeds", "finalize", "done"])
    .describe(
      "Where it is: their repositories deleted, their access in every account removed, their stars and feed, then done.",
    ),
  blocked: z
    .string()
    .nullable()
    .describe(
      "Why it waits, or null: `sole_owner:<organization id>` while the user is an organization's only owner (make another user its owner with `PUT /admin/organizations/{org}/owners/{username}`).",
    ),
  created_at: z.number().int().describe("When it began, Unix time in milliseconds."),
  updated_at: z.number().int().describe("When it last moved, Unix time in milliseconds."),
});

export const deleteUser = defineOperation({
  id: "admin.users.delete",
  method: "DELETE",
  path: "/admin/users/{username}",
  summary: "Delete a user",
  description:
    "Deletes a user, as GitHub Enterprise does, with their repositories and everything else of theirs: from the request on they and their agents can do nothing (every credential revoked, their handles released and held for 90 days); the rest runs in the background, and the deletion answers 202 with where it is (GitHub Enterprise answers 204 and works at once). What they made in others' repositories stays, shown as `ghost`. An organization they solely own holds the deletion until an administrator makes someone else its owner. Asking again answers where the deletion is: by the released handle while it is held, and by the user's id at any time (a deleted user's handle is their id). Instance administrators only; not yourself, nor the last active administrator.",
  input: z.object({ username: z.string().min(1).max(64) }),
  output: UserDeletion,
  permission: INSTANCE_ADMIN,
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 202,
  mcp: {
    tool: "delete_user",
    title: "Delete a user",
    description:
      "Delete a user on this Fyrden instance with their repositories; it runs in the background (call again, with the user's id, to see where it is). Requires an instance administrator.",
    readOnly: false,
  },
});

export const unsuspendUser = defineOperation({
  id: "admin.users.unsuspend",
  method: "DELETE",
  path: "/users/{username}/suspended",
  summary: "Unsuspend a user",
  description:
    "Lifts a user's suspension: they can sign in again, and their tokens and their agents' work again (sessions and OAuth tokens revoked by the suspension stay revoked). Unsuspending a user who is not suspended changes nothing. Instance administrators only.",
  input: z.object({
    username: z.string().min(1).max(64),
    reason: Reason,
  }),
  output: NoContent,
  permission: INSTANCE_ADMIN,
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 204,
  mcp: {
    tool: "unsuspend_user",
    title: "Unsuspend a user",
    description:
      "Lift a user's suspension on this Fyrden instance. Requires an instance administrator.",
    readOnly: false,
  },
});
