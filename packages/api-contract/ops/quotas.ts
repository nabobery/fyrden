import { HANDLE_PATTERN } from "@fyrden/domain";
import { z } from "zod";
import { defineOperation, INSTANCE_ADMIN } from "../src/op.js";

export const Quota = z.object({
  account: z.string().describe("The account's handle."),
  max_repos: z.number().int().describe("Active repositories the account may have."),
  repos: z.number().int().describe("Its active repositories now."),
  max_storage_bytes: z
    .number()
    .int()
    .describe("Bytes its repositories' pushes may store (pack and commands, as received)."),
  storage_bytes: z.number().int().describe("Bytes stored by committed pushes."),
  reserved_bytes: z.number().int().describe("Bytes reserved by pushes being received."),
});

export const getUserQuota = defineOperation({
  id: "quotas.user.get",
  method: "GET",
  path: "/user/quota",
  summary: "Get your quota",
  description:
    "The authenticated user's quota: how many repositories it may have and how many bytes their pushes may store, and how much of each is used. A deleted repository's bytes are free again once its deletion finishes.",
  input: z.object({}),
  output: Quota,
  permission: "members:read",
  principals: ["user"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "get_quota",
    title: "Get your quota",
    description: "Show your repository and storage quota and how much of it is used.",
    readOnly: true,
  },
});

export const getOrgQuota = defineOperation({
  id: "quotas.org.get",
  method: "GET",
  path: "/orgs/{org}/quota",
  summary: "Get an organization's quota",
  description: "An organization's quota and its use, for its members.",
  input: z.object({
    org: z.string().regex(HANDLE_PATTERN).describe("The organization's handle."),
  }),
  output: Quota,
  permission: "members:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "get_org_quota",
    title: "Get an organization's quota",
    description: "Show an organization's repository and storage quota and its use.",
    readOnly: true,
  },
});

export const setQuota = defineOperation({
  id: "admin.quotas.set",
  method: "PUT",
  path: "/admin/accounts/{account}/quota",
  summary: "Set an account's quota",
  description:
    "Sets a user's or organization's limits; null goes back to the instance default, and a limit left out is kept. Lowering a limit below the use refuses new repositories and pushes; nothing is deleted. Instance administrators only.",
  input: z.object({
    account: z.string().regex(HANDLE_PATTERN).describe("The user's or organization's handle."),
    max_repos: z.number().int().min(0).nullable().optional(),
    max_storage_bytes: z.number().int().min(0).nullable().optional(),
  }),
  output: Quota,
  permission: INSTANCE_ADMIN,
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "set_quota",
    title: "Set an account's quota",
    description: "Set a user's or organization's repository and storage limits (administrators).",
    readOnly: false,
  },
});
