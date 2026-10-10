import { PRINCIPAL_TYPES, type PrincipalType } from "@fyrden/domain";
import type { z } from "zod";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Any authenticated principal may call the operation; authorization is not otherwise narrowed. */
export const AUTHENTICATED = "authenticated";
/** Only an instance administrator may call the operation. */
export const INSTANCE_ADMIN = "instance:admin";

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
  /** OpenAPI-style path under /api, e.g. `/repos/{owner}/{repo}`. */
  path: string;
  summary: string;
  description?: string;
  /** All inputs: path parameters, then the query (GET) or JSON body (others). */
  input: I;
  output: O;
  /** Permission the caller needs, checked by the authorization layer. */
  permission: string;
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
const PATH = /^(\/([a-z0-9-]+|\{[a-z_]+\}))+$/;

export function pathParams(path: string): string[] {
  return [...path.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1] as string);
}

function validate(def: OperationDef): void {
  const fail = (reason: string) => {
    throw new RegistryError(`operation ${def.id || "<unnamed>"}: ${reason}`);
  };
  if (!ID.test(def.id)) fail("id must look like area.verb");
  if (!PATH.test(def.path)) fail(`path ${def.path} is not a valid template`);
  if (!def.permission.trim()) fail("a permission is required");
  if (def.principals.length === 0) fail("at least one principal type is required");
  for (const p of def.principals)
    if (!PRINCIPAL_TYPES.includes(p)) fail(`unknown principal type ${p}`);
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
      `route:${op.method} ${op.path.replace(/\{[a-z_]+\}/g, "{}")}`,
      `route ${op.method} ${op.path}`,
    );
    if (op.mcp) unique(`tool:${op.mcp.tool}`, `MCP tool ${op.mcp.tool}`);
  }
  return Object.freeze(ops) as R;
}
