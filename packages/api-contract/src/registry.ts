import { createToken, createUser } from "../ops/admin.js";
import { whoami } from "../ops/meta.js";
import { defineRegistry } from "./op.js";

/** Every operation Fyrden exposes. Order is the order in OpenAPI and MCP listings. */
export const registry = defineRegistry([whoami, createUser, createToken] as const);
export type FyrdenRegistry = typeof registry;
