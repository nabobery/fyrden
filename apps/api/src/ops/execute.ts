import type { TokenRecord } from "@fyrden/adapters-cloudflare/auth";
import type { Logger, Metrics } from "@fyrden/adapters-cloudflare/obs";
import {
  type FyrdenRegistry,
  type Input,
  makeProblem,
  type OperationDef,
  type Output,
  type Problem,
} from "@fyrden/api-contract";
import { checkOperation } from "@fyrden/domain";
import type { AuthState } from "../middleware/auth.js";
import {
  type Claim,
  finishIdempotent,
  outcomeOf,
  requestHash,
  startIdempotent,
} from "../rest/idempotency.js";

/** What every operation handler receives, whichever surface (REST or MCP) called it. */
export interface OpContext {
  env: Env;
  auth: TokenRecord;
  authState: AuthState;
  log: Logger;
  metrics: Metrics;
  requestId: string;
  /** The hostname the request arrived on (this deployment's own host). */
  requestHost: string;
  /** The origin (scheme, host and port) the request arrived on, for links back to this API. */
  requestOrigin: string;
  waitUntil(promise: Promise<unknown>): void;
}

export type OpHandler<D extends OperationDef> = (
  ctx: OpContext,
  input: Input<D>,
) => Promise<Output<D>>;

/** One handler per registry operation; a missing one is a type error. */
export type Handlers = { [D in FyrdenRegistry[number] as D["id"]]: OpHandler<D> };

export type OpResult =
  | { ok: true; output: unknown; replayed?: true; status?: number }
  | { ok: false; problem: Problem; replayed?: true };

/**
 * An expected failure a handler reports (a taken handle, a missing user). The
 * executor turns it into a problem document; any other exception is a bug.
 */
export class OperationError extends Error {
  override name = "OperationError";
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422,
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
 * Whether the caller may call an operation with this permission at all: its
 * principal type and its token's scopes, and for instance permissions the
 * whole check. The handler checks repository and account permissions again,
 * completely, once it has resolved the repository or account.
 */
export function hasPermission(permission: OperationDef["permission"], auth: TokenRecord): boolean {
  return checkOperation(permission, {
    actorType: auth.principalType,
    isInstanceAdmin: auth.isInstanceAdmin,
    scopes: auth.scopes,
  }).allow;
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
  /** A REST write's `Idempotency-Key`, checked once the request may run at all. */
  options: { readonly idempotencyKey?: string } = {},
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
  // The same token's same request with the same key: the first answer, not a second run.
  let claim: Claim | undefined;
  if (options.idempotencyKey !== undefined && op.idempotency === "key") {
    const start = await startIdempotent(
      ctx.env,
      {
        tokenId: auth.id,
        key: options.idempotencyKey,
        opId: op.id,
        hash: await requestHash(op.id, input.data),
        now: Date.now(),
      },
      ctx.metrics,
    );
    if (start.kind === "refuse") return fail(ctx, start.status, start.code, start.detail);
    if (start.kind === "replay")
      return start.status >= 400
        ? { ok: false, problem: start.body as Problem, replayed: true }
        : { ok: true, output: start.body, status: start.status, replayed: true };
    claim = start.claim;
  }
  let result: OpResult;
  try {
    const output = await handler(
      { ...ctx, auth, authState: { ...ctx.authState, record: auth } },
      input.data,
    );
    // A handler returning the wrong shape is a server bug, never sent as-is.
    result = { ok: true, output: op.output.parse(output) };
  } catch (error) {
    if (!(error instanceof OperationError)) {
      // It may have taken effect: retries with its key are refused, not run.
      if (claim)
        await finishIdempotent(ctx.env, claim, { kind: "unknown" }, ctx.metrics).catch(() => {});
      throw error;
    }
    result = fail(ctx, error.status, error.code, error.message);
  }
  if (claim) await finishIdempotent(ctx.env, claim, outcomeOf(op, result), ctx.metrics);
  return result;
}
