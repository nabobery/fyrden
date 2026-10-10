import type { TokenRecord } from "@fyrden/adapters-cloudflare/auth";
import type { Logger, Metrics } from "@fyrden/adapters-cloudflare/obs";
import {
  AUTHENTICATED,
  type FyrdenRegistry,
  INSTANCE_ADMIN,
  type Input,
  makeProblem,
  type OperationDef,
  type Output,
  type Problem,
} from "@fyrden/api-contract";
import type { AuthState } from "../middleware/auth.js";

/** What every operation handler receives, whichever surface (REST or MCP) called it. */
export interface OpContext {
  env: Env;
  auth: TokenRecord;
  authState: AuthState;
  log: Logger;
  metrics: Metrics;
  requestId: string;
  waitUntil(promise: Promise<unknown>): void;
}

export type OpHandler<D extends OperationDef> = (
  ctx: OpContext,
  input: Input<D>,
) => Promise<Output<D>>;

/** One handler per registry operation; a missing one is a type error. */
export type Handlers = { [D in FyrdenRegistry[number] as D["id"]]: OpHandler<D> };

export type OpResult = { ok: true; output: unknown } | { ok: false; problem: Problem };

/**
 * An expected failure a handler reports (a taken handle, a missing user). The
 * executor turns it into a problem document; any other exception is a bug.
 */
export class OperationError extends Error {
  override name = "OperationError";
  constructor(
    readonly status: 400 | 404 | 409 | 422,
    readonly code: string,
    detail: string,
  ) {
    super(detail);
  }
}

function fail(
  ctx: OpContext,
  status: number,
  code: string,
  detail: string,
  missingPermission?: string,
): OpResult {
  return {
    ok: false,
    problem: makeProblem({
      status,
      code,
      detail,
      requestId: ctx.requestId,
      ...(missingPermission !== undefined && { missingPermission }),
    }),
  };
}

/**
 * Whether the caller holds an operation's permission. Until the authorization
 * layer (repository and org roles) exists, any other permission is denied:
 * an operation declared with one cannot run by accident.
 */
export function hasPermission(permission: string, auth: TokenRecord): boolean {
  if (permission === AUTHENTICATED) return true;
  if (permission === INSTANCE_ADMIN) return auth.isInstanceAdmin;
  return false;
}

/**
 * Runs one operation for any surface (REST or MCP), so they cannot drift:
 * rate limit, write re-verification, principal-type and permission checks,
 * input validation, handler, and output validation.
 */
export async function executeOperation(
  op: OperationDef,
  handler: OpHandler<OperationDef>,
  ctx: OpContext,
  rawInput: unknown,
): Promise<OpResult> {
  // Limited by token id, which a re-verification cannot change; checked
  // first so a flood of writes cannot drive D1 primary lookups.
  const limiter = op.rateLimit === "read" ? ctx.env.RATE_LIMIT_READ : ctx.env.RATE_LIMIT_WRITE;
  if (!(await limiter.limit({ key: ctx.auth.id })).success) {
    return fail(ctx, 429, "rate_limited", "Too many requests for this token.");
  }

  // A write must see revocation immediately, even if the request was
  // verified from the read cache (MCP verifies every call in read mode).
  // From here on, everything uses the record the primary returned.
  let auth = ctx.auth;
  if (op.method !== "GET" && ctx.authState.mode === "read") {
    const fresh = await ctx.authState.verifyForWrite();
    if (!fresh.ok)
      return fail(ctx, 401, "invalid_token", "The token is invalid, expired or revoked.");
    auth = fresh.record;
  }

  if (!op.principals.includes(auth.principalType)) {
    return fail(
      ctx,
      403,
      "principal_type_not_allowed",
      `${auth.principalType} principals cannot call ${op.id}.`,
    );
  }

  if (!hasPermission(op.permission, auth)) {
    return fail(
      ctx,
      403,
      "missing_permission",
      `${op.id} needs the ${op.permission} permission.`,
      op.permission,
    );
  }

  const input = op.input.safeParse(rawInput);
  if (!input.success) {
    const detail = input.error.issues
      .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
      .join("; ");
    return fail(ctx, 422, "invalid_input", detail);
  }
  let output: unknown;
  try {
    output = await handler(
      { ...ctx, auth, authState: { ...ctx.authState, record: auth } },
      input.data,
    );
  } catch (error) {
    if (error instanceof OperationError) return fail(ctx, error.status, error.code, error.message);
    throw error;
  }
  // A handler returning the wrong shape is a server bug, never sent as-is.
  return { ok: true, output: op.output.parse(output) };
}
