import { createToken, createUser } from "../ops/admin.js";
import { createImport, getImport } from "../ops/imports.js";
import { whoami } from "../ops/meta.js";
import {
  createRepo,
  deleteRepo,
  deleteRepos,
  forkRepo,
  getRepo,
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
  createRepo,
  listRepos,
  getRepo,
  updateRepo,
  deleteRepo,
  deleteRepos,
  forkRepo,
  createUpload,
  getUpload,
  completeUpload,
  abortUpload,
  createImport,
  getImport,
] as const);
export type FyrdenRegistry = typeof registry;
