import {
  createTeam,
  listCollaborators,
  listTeams,
  removeCollaborator,
  removeTeamMembership,
  removeTeamRepo,
  setCollaborator,
  setTeamMembership,
  setTeamRepo,
} from "../ops/access.js";
import { createToken, createUser } from "../ops/admin.js";
import {
  compareCommits,
  getBranch,
  getCommit,
  listBranches,
  listCommits,
  listTags,
} from "../ops/browse.js";
import { createImport, getImport } from "../ops/imports.js";
import { whoami } from "../ops/meta.js";
import { createOrg, listMembers, removeMembership, setMembership } from "../ops/orgs.js";
import {
  createOrgRepo,
  createRepo,
  deleteRepo,
  deleteRepos,
  forkRepo,
  getRepo,
  listOrgRepos,
  listRepos,
  updateRepo,
} from "../ops/repos.js";
import { abortUpload, completeUpload, createUpload, getUpload } from "../ops/uploads.js";
import { defineRegistry } from "./op.js";

/** Every operation Fyrden exposes. Order is the order in OpenAPI and MCP listings. */
export const registry = defineRegistry([
  whoami,
  createUser,
  createToken,
  createOrg,
  createRepo,
  listRepos,
  getRepo,
  updateRepo,
  deleteRepo,
  deleteRepos,
  forkRepo,
  listBranches,
  getBranch,
  listTags,
  listCommits,
  getCommit,
  compareCommits,
  setMembership,
  removeMembership,
  listMembers,
  createOrgRepo,
  listOrgRepos,
  setCollaborator,
  removeCollaborator,
  listCollaborators,
  createTeam,
  listTeams,
  setTeamMembership,
  removeTeamMembership,
  setTeamRepo,
  removeTeamRepo,
  createUpload,
  getUpload,
  completeUpload,
  abortUpload,
  createImport,
  getImport,
] as const);
export type FyrdenRegistry = typeof registry;
