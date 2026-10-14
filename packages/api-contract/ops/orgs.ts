import { HANDLE_PATTERN } from "@fyrden/domain";
import { z } from "zod";
import { defineOperation, INSTANCE_ADMIN } from "../src/op.js";

const Handle = z
  .string()
  .regex(HANDLE_PATTERN)
  .describe("1-39 letters, digits and single inner hyphens; unique, ignoring case.");

const OrgParam = Handle.describe("The organization's handle.");
const UserParam = Handle.describe("The user's handle.");

/** GitHub's names for the two organization roles: `admin` is an owner. */
const MembershipRole = z
  .enum(["admin", "member"])
  .describe("`admin`: an owner, who administers every repository of the organization.");

export const Org = z.object({
  id: z.string().describe("Organization id (org_ prefix)."),
  login: z.string(),
  created_at: z.number().int().describe("Unix time in milliseconds."),
});

export const createOrg = defineOperation({
  id: "admin.orgs.create",
  method: "POST",
  path: "/admin/organizations",
  summary: "Create an organization",
  description:
    "Creates an organization with a user as its first owner. Instance administrators only.",
  input: z.object({
    login: Handle.describe("The organization's handle; unique across users and organizations."),
    admin: UserParam.describe("The handle of the user who becomes its first owner."),
  }),
  output: Org,
  permission: INSTANCE_ADMIN,
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  mcp: {
    tool: "create_org",
    title: "Create an organization",
    description: "Create an organization with a first owner. Requires an instance administrator.",
    readOnly: false,
  },
});

export const OrgSettings = z.object({
  login: z.string(),
  require_dpop: z
    .boolean()
    .describe(
      "Whether the organization's agents may use API tokens only DPoP-bound (RFC 9449); git tokens are exempt.",
    ),
});

export const updateOrg = defineOperation({
  id: "orgs.update",
  method: "PATCH",
  path: "/orgs/{org}",
  summary: "Update an organization's settings",
  description:
    "Changes an organization's settings: whether its agents' API tokens must be DPoP-bound (`require_dpop`). Owners only.",
  input: z.object({
    org: OrgParam,
    require_dpop: z.boolean().optional(),
  }),
  output: OrgSettings,
  permission: "members:write",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  mcp: false,
});

export const Membership = z.object({
  org: z.string(),
  user: z.string(),
  role: MembershipRole,
  state: z.literal("active"),
});

export const setMembership = defineOperation({
  id: "orgs.memberships.set",
  method: "PUT",
  path: "/orgs/{org}/memberships/{username}",
  summary: "Add a member or change a member's role",
  description:
    "Makes a user a member (or an owner, `admin`) of an organization, at once. The last owner cannot be made a member. Owners only.",
  input: z.object({
    org: OrgParam,
    username: UserParam,
    role: MembershipRole.default("member"),
  }),
  output: Membership,
  permission: "members:write",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "set_org_membership",
    title: "Add an organization member",
    description: "Add a user to an organization, or change the user's role there.",
    readOnly: false,
  },
});

export const removeMembership = defineOperation({
  id: "orgs.memberships.remove",
  method: "DELETE",
  path: "/orgs/{org}/memberships/{username}",
  summary: "Remove a member",
  description:
    "Removes a user from an organization and its teams; collaborator roles on its repositories stay. Repositories told of the change stop counting the membership at once; every repository stops within 60 seconds for writes and 5 minutes for reads. The last owner cannot be removed. Owners only.",
  input: z.object({ org: OrgParam, username: UserParam }),
  output: z.object({ org: z.string(), user: z.string(), state: z.literal("removed") }),
  permission: "members:write",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "remove_org_membership",
    title: "Remove an organization member",
    description: "Remove a user from an organization.",
    readOnly: false,
  },
});

export const listMembers = defineOperation({
  id: "orgs.members.list",
  method: "GET",
  path: "/orgs/{org}/members",
  summary: "List an organization's members",
  description: "Lists an organization's members by handle, ignoring case. Members only.",
  input: z.object({
    org: OrgParam,
    per_page: z.coerce.number().int().min(1).max(100).default(30).describe("Page size, 1-100."),
    cursor: z.string().max(200).optional().describe("From a previous page's `next_cursor`."),
  }),
  output: z.object({
    members: z.array(z.object({ id: z.string(), login: z.string(), role: MembershipRole })),
    next_cursor: z
      .string()
      .nullable()
      .describe("Pass as `cursor` for the next page; null on the last page."),
  }),
  permission: "members:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_org_members",
    title: "List organization members",
    description: "List the members of an organization you belong to.",
    readOnly: true,
  },
});
