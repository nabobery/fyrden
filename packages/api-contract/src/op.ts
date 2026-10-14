import {
  AUTHENTICATED,
  isPermission,
  type Permission,
  PRINCIPAL_TYPES,
  type PrincipalType,
  permissionDef,
} from "@fyrden/domain";
import type { z } from "zod";

export { AUTHENTICATED };

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Only an instance administrator may call the operation. */
export const INSTANCE_ADMIN = "instance:admin" satisfies Permission;

/**
 * One operation, declared once. REST routes, the OpenAPI document, MCP
 * tools and the SDK are all generated from these definitions.
 */
export interface OperationDef<
  I extends z.ZodObject = z.ZodObject,
  O extends z.ZodType = z.ZodType,
  Id extends string = string,
> {
  /** Stable id, `<area>.<verb>`; kept as a literal type so handler maps can require every id. */
  id: Id;
  method: HttpMethod;
  /**
   * OpenAPI-style path under /api, e.g. `/repos/{owner}/{repo}`. The last
   * parameter may be greedy, `{path+}`: it takes the rest of the path,
   * slashes included (a file path, a branch name).
   */
  path: string;
  summary: string;
  description?: string;
  /** All inputs: path parameters, then the query (GET) or JSON body (others). */
  input: I;
  output: O;
  /**
   * Permission the caller needs, from the permission table in
   * `@fyrden/domain`; `AUTHENTICATED` when any authenticated caller may.
   */
  permission: Permission | typeof AUTHENTICATED;
  /** Principal types allowed to call it at all. */
  principals: readonly PrincipalType[];
  rateLimit: "read" | "write" | "expensive";
  /** Non-GET operations take an Idempotency-Key. */
  idempotency: "none" | "key";
  /** HTTP status of a successful response; 201 when the operation creates a resource. */
  successStatus?: 200 | 201;
  /** The response carries a secret, so idempotent replays omit it. */
  secretResponse?: boolean;
  mcp: false | { tool: string; title: string; description: string; readOnly: boolean };
}

export type Input<D extends OperationDef> = z.infer<D["input"]>;
export type Output<D extends OperationDef> = z.infer<D["output"]>;

export class RegistryError extends Error {
  override name = "RegistryError";
}

const ID = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/;
const TOOL = /^[a-z][a-z0-9_]{0,63}$/;
const PATH = /^(\/([a-z0-9_-]+|\{[a-z_]+\}))*(\/\{[a-z_]+\+\})?$/;

export function pathParams(path: string): string[] {
  return [...path.matchAll(/\{([a-z_]+)\+?\}/g)].map((m) => m[1] as string);
}

/** The path as OpenAPI writes it: a greedy `{path+}` is `{path}`. */
export function openApiPath(path: string): string {
  return path.replace(/\{([a-z_]+)\+\}/g, "{$1}");
}

function validate(def: OperationDef): void {
  const fail = (reason: string) => {
    throw new RegistryError(`operation ${def.id || "<unnamed>"}: ${reason}`);
  };
  if (!ID.test(def.id)) fail("id must look like area.verb");
  if (!def.path || !PATH.test(def.path)) fail(`path ${def.path} is not a valid template`);
  if (!def.permission.trim()) fail("a permission is required");
  if (def.principals.length === 0) fail("at least one principal type is required");
  for (const p of def.principals)
    if (!PRINCIPAL_TYPES.includes(p)) fail(`unknown principal type ${p}`);
  if (def.permission !== AUTHENTICATED) {
    if (!isPermission(def.permission)) fail(`unknown permission ${def.permission}`);
    const held = permissionDef(def.permission as Permission);
    for (const p of def.principals)
      if (!held.principals.includes(p)) fail(`${p} principals cannot hold ${def.permission}`);
    // The executor re-verifies a token on the primary for non-GET methods only.
    if (def.method === "GET" && held.writes) fail("a GET operation cannot need a write permission");
  }
  if (def.method === "GET" && def.idempotency !== "none")
    fail("GET operations are naturally idempotent");
  if (def.method !== "GET" && def.idempotency !== "key")
    fail("non-GET operations require an Idempotency-Key");
  if (def.method === "GET" && def.successStatus === 201) fail("a GET operation cannot answer 201");
  if (def.mcp && !TOOL.test(def.mcp.tool)) fail(`MCP tool name ${def.mcp.tool} is invalid`);
  if (def.mcp && def.mcp.readOnly !== (def.method === "GET"))
    fail("MCP readOnly must match the HTTP method");
  const shape = def.input.shape;
  for (const param of pathParams(def.path))
    if (!(param in shape)) fail(`path parameter {${param}} missing from input`);
}

/** Validates and freezes one operation definition. */
export function defineOperation<
  const Id extends string,
  I extends z.ZodObject,
  O extends z.ZodType,
>(def: OperationDef<I, O, Id>): OperationDef<I, O, Id> {
  validate(def as unknown as OperationDef);
  return Object.freeze(def);
}

export type Registry = readonly OperationDef[];

/** Checks that ids, routes and MCP tool names are unique across the registry. */
export function defineRegistry<R extends readonly OperationDef[]>(ops: R): R {
  const seen = new Set<string>();
  const unique = (key: string, what: string) => {
    if (seen.has(key)) throw new RegistryError(`duplicate ${what}`);
    seen.add(key);
  };
  for (const op of ops) {
    validate(op);
    unique(`id:${op.id}`, `operation id ${op.id}`);
    unique(
      `route:${op.method} ${op.path.replace(/\{[a-z_]+\}/g, "{}").replace(/\{[a-z_]+\+\}/g, "{+}")}`,
      `route ${op.method} ${op.path}`,
    );
    if (op.mcp) unique(`tool:${op.mcp.tool}`, `MCP tool ${op.mcp.tool}`);
  }
  return Object.freeze(ops) as R;
}
