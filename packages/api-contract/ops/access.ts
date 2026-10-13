import { HANDLE_PATTERN } from "@fyrden/domain";
import { z } from "zod";
import { defineOperation } from "../src/op.js";
import { REPO_NAME_PATTERN } from "./repos.js";

const Owner = z.string().regex(HANDLE_PATTERN).describe("The owner's handle.");
const Repo = z.string().regex(REPO_NAME_PATTERN).describe("The repository's name.");
const Org = z.string().regex(HANDLE_PATTERN).describe("The organization's handle.");
const Username = z.string().regex(HANDLE_PATTERN).describe("The user's handle.");
const TeamSlug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(100)
  .describe("The team's slug (lowercase letters, digits and inner hyphens).");

/** GitHub's names for the five repository roles. */
export const RepoPermissionName = z
  .enum(["pull", "triage", "push", "maintain", "admin"])
  .describe("`pull` reads, `push` writes, `admin` administers (GitHub's role names).");

const Page = {
  per_page: z.coerce.number().int().min(1).max(100).default(30).describe("Page size, 1-100."),
  cursor: z.string().max(200).optional().describe("From a previous page's `next_cursor`."),
};
const NextCursor = z
  .string()
  .nullable()
  .describe("Pass as `cursor` for the next page; null on the last page.");

export const Collaborator = z.object({
  repo: z.string().describe("owner/name"),
  user: z.string(),
  permission: RepoPermissionName,
});

export const setCollaborator = defineOperation({
  id: "repos.collaborators.set",
  method: "PUT",
  path: "/repos/{owner}/{repo}/collaborators/{username}",
  summary: "Add a collaborator or change a collaborator's role",
  description:
    "Gives a user a role on one repository, at once (no invitation). Administrators of the repository only.",
  input: z.object({
    owner: Owner,
    repo: Repo,
    username: Username,
    permission: RepoPermissionName.default("push"),
  }),
  output: Collaborator,
  permission: "administration:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "set_collaborator",
    title: "Add a repository collaborator",
    description: "Give a user a role on a repository you administer.",
    readOnly: false,
  },
});

export const removeCollaborator = defineOperation({
  id: "repos.collaborators.remove",
  method: "DELETE",
  path: "/repos/{owner}/{repo}/collaborators/{username}",
  summary: "Remove a collaborator",
  description:
    "Takes a user's collaborator role on a repository away; roles the user has otherwise (organization, teams) stay. Repositories told of the change stop counting it at once; every repository stops within 60 seconds for writes and 5 minutes for reads. Administrators of the repository only.",
  input: z.object({ owner: Owner, repo: Repo, username: Username }),
  output: z.object({ repo: z.string(), user: z.string(), state: z.literal("removed") }),
  permission: "administration:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "remove_collaborator",
    title: "Remove a repository collaborator",
    description: "Take a user's collaborator role on a repository you administer away.",
    readOnly: false,
  },
});

export const listCollaborators = defineOperation({
  id: "repos.collaborators.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/collaborators",
  summary: "List a repository's collaborators",
  description:
    "Lists the users given a role on this repository directly, by handle (owners, organization members and teams are not listed).",
  input: z.object({ owner: Owner, repo: Repo, ...Page }),
  output: z.object({
    collaborators: z.array(
      z.object({ id: z.string(), login: z.string(), permission: RepoPermissionName }),
    ),
    next_cursor: NextCursor,
  }),
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_collaborators",
    title: "List repository collaborators",
    description: "List the users given a role on a repository directly.",
    readOnly: true,
  },
});

export const Team = z.object({ slug: z.string(), name: z.string() });

export const createTeam = defineOperation({
  id: "orgs.teams.create",
  method: "POST",
  path: "/orgs/{org}/teams",
  summary: "Create a team",
  description:
    "Creates a team in an organization, with no members or repositories; its slug comes from its name. Owners only.",
  input: z.object({
    org: Org,
    name: z.string().min(1).max(100).describe("The team's name."),
  }),
  output: Team,
  permission: "members:write",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  mcp: {
    tool: "create_team",
    title: "Create a team",
    description: "Create a team in an organization you own.",
    readOnly: false,
  },
});

export const listTeams = defineOperation({
  id: "orgs.teams.list",
  method: "GET",
  path: "/orgs/{org}/teams",
  summary: "List an organization's teams",
  description: "Lists an organization's teams by slug. Members only.",
  input: z.object({ org: Org, ...Page }),
  output: z.object({ teams: z.array(Team), next_cursor: NextCursor }),
  permission: "members:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_teams",
    title: "List teams",
    description: "List the teams of an organization you belong to.",
    readOnly: true,
  },
});

export const setTeamMembership = defineOperation({
  id: "orgs.teams.memberships.set",
  method: "PUT",
  path: "/orgs/{org}/teams/{team_slug}/memberships/{username}",
  summary: "Add a team member",
  description: "Adds a member of the organization to a team, at once. Owners only.",
  input: z.object({ org: Org, team_slug: TeamSlug, username: Username }),
  output: z.object({ team: z.string(), user: z.string(), state: z.literal("active") }),
  permission: "members:write",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "add_team_member",
    title: "Add a team member",
    description: "Add a member of the organization to one of its teams.",
    readOnly: false,
  },
});

export const removeTeamMembership = defineOperation({
  id: "orgs.teams.memberships.remove",
  method: "DELETE",
  path: "/orgs/{org}/teams/{team_slug}/memberships/{username}",
  summary: "Remove a team member",
  description:
    "Removes a user from a team; roles the user has otherwise stay. Repositories told of the change stop counting the team's role at once; every repository stops within 60 seconds for writes and 5 minutes for reads. Owners only.",
  input: z.object({ org: Org, team_slug: TeamSlug, username: Username }),
  output: z.object({ team: z.string(), user: z.string(), state: z.literal("removed") }),
  permission: "members:write",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "remove_team_member",
    title: "Remove a team member",
    description: "Remove a user from one of the organization's teams.",
    readOnly: false,
  },
});

export const setTeamRepo = defineOperation({
  id: "orgs.teams.repos.set",
  method: "PUT",
  path: "/orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}",
  summary: "Give a team a role on a repository",
  description:
    "Gives a team a role on one of the organization's repositories; every member of the team gets it. Owners only.",
  input: z.object({
    org: Org,
    team_slug: TeamSlug,
    owner: Owner,
    repo: Repo,
    permission: RepoPermissionName.default("push"),
  }),
  output: z.object({ team: z.string(), repo: z.string(), permission: RepoPermissionName }),
  permission: "members:write",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "set_team_repo",
    title: "Give a team a repository role",
    description: "Give one of the organization's teams a role on one of its repositories.",
    readOnly: false,
  },
});

export const removeTeamRepo = defineOperation({
  id: "orgs.teams.repos.remove",
  method: "DELETE",
  path: "/orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}",
  summary: "Take a team's role on a repository away",
  description:
    "Takes a team's role on a repository away; its members keep the roles they have otherwise (members of the organization read). Repositories told of the change stop counting it at once; every repository stops within 60 seconds for writes and 5 minutes for reads. Owners only.",
  input: z.object({ org: Org, team_slug: TeamSlug, owner: Owner, repo: Repo }),
  output: z.object({ team: z.string(), repo: z.string(), state: z.literal("removed") }),
  permission: "members:write",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "remove_team_repo",
    title: "Take a team's repository role away",
    description: "Take one of the organization's teams' role on a repository away.",
    readOnly: false,
  },
});
