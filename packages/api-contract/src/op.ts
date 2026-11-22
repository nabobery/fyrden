import {
  AUTHENTICATED,
  isPermission,
  type Permission,
  PRINCIPAL_TYPES,
  type PrincipalType,
  permissionDef,
} from "@fyrden/domain";
import { z } from "zod";

export { AUTHENTICATED };

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Only an instance administrator may call the operation. */
export const INSTANCE_ADMIN = "instance:admin" satisfies Permission;
/** Reading the instance's operational state (instance administrators). */
export const INSTANCE_READ = "instance:read" satisfies Permission;

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
  /**
   * HTTP status of a successful response; 201 when the operation creates a
   * resource, 202 where GitHub answers it, 204 or 205 (with `NoContent` as
   * the output) where GitHub answers nothing (205: Reset Content, as
   * GitHub's marking a notification thread read). A `NoContent` operation
   * may also answer a fixed 201 with no body.
   */
  successStatus?: 200 | 201 | 202 | 204 | 205;
  /**
   * The statuses a `NoContent` operation answers with no body when the
   * outcome decides it, as GitHub's secret `PUT` answers 201 when it
   * creates and 204 when it updates. Its handler returns
   * `statusResult(status, null)`; it declares no `successStatus`.
   */
  successStatuses?: readonly NoContentStatus[];
  /** The response carries a secret, so idempotent replays omit it. */
  secretResponse?: boolean;
  /**
   * A write the read model's maintenance does not hold back: its own
   * controller's (pausing and resuming its writers).
   */
  duringMaintenance?: boolean;
  /**
   * A GET whose REST answer carries an ETag of its body: a request whose
   * `If-None-Match` matches gets 304 Not Modified.
   */
  etag?: boolean;
  /**
   * A GET that must see a revoked or narrowed credential at once, as a
   * write does: re-verified on the directory's primary before its
   * permission is checked.
   */
  freshAuth?: boolean;
  /** Its REST answers, refusals too, are kept by no cache (`Cache-Control: private, no-store`). */
  noStore?: boolean;
  mcp:
    | false
    | {
        tool: string;
        title: string;
        description: string;
        readOnly: boolean;
        /**
         * Whether calling it again with the same arguments changes nothing
         * more; by default when it reads, sets (PUT) or removes (DELETE).
         */
        idempotent?: boolean;
      };
}

/** The statuses an operation may answer with no body. */
export type NoContentStatus = 201 | 204 | 205;

/**
 * The output of an operation that answers nothing (`successStatus` 204, 205
 * or 201, or `successStatuses`): `null` to its handler, idempotency replays
 * and the SDK; REST sends no body, MCP a short text.
 */
export const NoContent = z.null().describe("No content.");

export const answersNothing = (def: Pick<OperationDef, "output">): boolean =>
  def.output === NoContent;

/** Whether an operation takes GitHub's page numbers: `page` and `per_page`. */
export const takesPageNumbers = (def: Pick<OperationDef, "input">): boolean =>
  "page" in def.input.shape && "per_page" in def.input.shape;

/**
 * Whether an operation takes page numbers and counts its items in
 * `total_count`: its REST answer links the other pages (`Link`, as GitHub's),
 * which clients such as `gh` follow.
 */
export const pagedByTotal = (def: Pick<OperationDef, "input" | "output">): boolean =>
  takesPageNumbers(def) && def.output instanceof z.ZodObject && "total_count" in def.output.shape;

/** Every status an operation answers on success. */
export const successStatusesOf = (
  def: Pick<OperationDef, "successStatus" | "successStatuses">,
): readonly number[] => def.successStatuses ?? [def.successStatus ?? 200];

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
  if (def.successStatuses !== undefined) {
    if (!answersNothing(def))
      fail("only an operation whose output is NoContent has successStatuses");
    if (def.successStatus !== undefined) fail("successStatuses replaces successStatus");
    if (def.method === "GET") fail("a GET operation answers one status");
    const statuses = new Set<number>(def.successStatuses);
    if (statuses.size < 2 || statuses.size !== def.successStatuses.length)
      fail("successStatuses lists two or more distinct statuses");
    for (const status of statuses)
      if (status !== 201 && status !== 204 && status !== 205)
        fail(`successStatuses cannot list ${status}`);
  } else if (answersNothing(def)) {
    if (def.successStatus !== 201 && def.successStatus !== 204 && def.successStatus !== 205)
      fail("an operation whose output is NoContent answers 201, 204 or 205");
  } else if (def.successStatus === 204 || def.successStatus === 205)
    fail("an operation answers 204 or 205 only when its output is NoContent");
  if (def.etag && answersNothing(def)) fail("an operation answering nothing has no ETag");
  if (def.secretResponse && answersNothing(def))
    fail("an operation answering nothing has no secret response");
  if (def.etag && def.method !== "GET") fail("only a GET operation answers with an ETag");
  if (def.mcp && !TOOL.test(def.mcp.tool)) fail(`MCP tool name ${def.mcp.tool} is invalid`);
  if (def.mcp && def.mcp.readOnly !== (def.method === "GET"))
    fail("MCP readOnly must match the HTTP method");
  const shape = def.input.shape;
  for (const param of pathParams(def.path))
    if (!(param in shape)) fail(`path parameter {${param}} missing from input`);
}

/**
 * Validates and freezes one operation definition. An operation declaring
 * `successStatuses` keeps their literal types, so its handler is typed to
 * answer one of them.
 */
export function defineOperation<
  const Id extends string,
  I extends z.ZodObject,
  O extends z.ZodType,
  const S extends readonly NoContentStatus[],
>(
  def: OperationDef<I, O, Id> & { successStatuses: S },
): OperationDef<I, O, Id> & {
  successStatuses: S;
};
export function defineOperation<
  const Id extends string,
  I extends z.ZodObject,
  O extends z.ZodType,
>(def: OperationDef<I, O, Id> & { successStatuses?: undefined }): OperationDef<I, O, Id>;
export function defineOperation(def: OperationDef): OperationDef;
export function defineOperation(def: OperationDef): OperationDef {
  validate(def);
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
