import type { TokenRecord } from "@fyrden/adapters-cloudflare/auth";
import type { Logger, Metrics } from "@fyrden/adapters-cloudflare/obs";
import {
  type FyrdenRegistry,
  type Input,
  makeProblem,
  type OperationDef,
  type Output,
  type Problem,
  type ProblemInit,
} from "@fyrden/api-contract";
import { checkOperation, isPermission, permissionDef } from "@fyrden/domain";
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
  /** When the request arrived, before anything awaited (milliseconds since the epoch). */
  receivedAt?: number;
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
    readonly status: 400 | 401 | 403 | 404 | 405 | 409 | 410 | 422 | 429 | 503,
    readonly code: string,
    detail: string,
    /** Where the client starts over (for an expired cursor). */
    readonly resync?: string,
    /** For `stale`: the version it is at now. */
    readonly currentVersion?: number,
    /** With a 429: seconds to wait before trying again. */
    readonly retryAfter?: number,
  ) {
    super(detail);
  }
}

function fail(
  ctx: OpContext,
  status: number,
  code: string,
  detail: string,
  extra: Pick<ProblemInit, "missingPermission" | "resync" | "currentVersion" | "retryAfter"> = {},
): OpResult {
  return {
    ok: false,
    problem: makeProblem({ status, code, detail, requestId: ctx.requestId, ...extra }),
  };
}

/**
 * Why an operation refuses a credential before anything else: its
 * permission is a web session's only and the credential is not one.
 * Undefined when it does not.
 */
export function sessionRefusal(
  op: OperationDef,
  auth: Pick<TokenRecord, "type">,
): { code: string; detail: string } | undefined {
  if (!isPermission(op.permission) || permissionDef(op.permission).sessionOnly !== true) return;
  if (auth.type === "ses") return;
  return {
    code: "session_required",
    detail: `${op.id} is done from Fyrden's web pages, signed in, with no token.`,
  };
}

/** Whose budget a request spends: a token's own, or the token it was minted from (minting more resets nothing). */
export function rateLimitKey(auth: Pick<TokenRecord, "id" | "sourceId">): string {
  return auth.sourceId ?? auth.id;
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
 * The request's credential as the directory's primary has it now (the
 * request's own record when it was verified there): what a write, or a
 * read that must see revocation at once, goes on. A refusal says why, as a
 * 401 answers it.
 */
export async function reverified(
  ctx: Pick<OpContext, "auth" | "authState">,
): Promise<
  | { readonly ok: true; readonly record: TokenRecord }
  | { readonly ok: false; readonly code: string; readonly detail: string }
> {
  if (ctx.authState.mode !== "read") return { ok: true, record: ctx.auth };
  const fresh = await ctx.authState.verifyForWrite();
  if (!fresh.ok)
    return {
      ok: false,
      code: "invalid_token",
      detail: "The token is invalid, expired or revoked.",
    };
  // An owner may have required DPoP since the cached answer (a bound token's proof was
  // checked); a git token is exempt only where git uses it, never here.
  if (fresh.record.requiresDpop && fresh.record.dpopJkt === null)
    return {
      ok: false,
      code: "invalid_dpop_proof",
      detail: "This token needs a valid DPoP proof (RFC 9449).",
    };
  return { ok: true, record: fresh.record };
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
  // Limited by token (or its source) id, which a re-verification cannot change; checked
  // first so a flood of writes cannot drive D1 primary lookups.
  // A web session's only operation refuses every other credential before anything else.
  const refused = sessionRefusal(op, ctx.auth);
  if (refused) return fail(ctx, 403, refused.code, refused.detail);

  const limiter = op.rateLimit === "read" ? ctx.env.RATE_LIMIT_READ : ctx.env.RATE_LIMIT_WRITE;
  if (!(await limiter.limit({ key: rateLimitKey(ctx.auth) })).success) {
    return fail(ctx, 429, "rate_limited", "Too many requests for this token.");
  }

  // A write must see revocation immediately, even if the request was
  // verified from the read cache (MCP verifies every call in read mode).
  // From here on, everything uses the record the primary returned.
  let auth = ctx.auth;
  let authState = ctx.authState;
  if (op.method !== "GET") {
    const fresh = await reverified(ctx);
    if (!fresh.ok) return fail(ctx, 401, fresh.code, fresh.detail);
    auth = fresh.record;
    // Verified on the primary: a handler's own `reverified` takes it as it is.
    authState = { ...authState, record: auth, mode: "write" };
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
    return fail(ctx, 403, "missing_permission", `${op.id} needs the ${op.permission} permission.`, {
      missingPermission: op.permission,
    });
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
    const output = await handler({ ...ctx, auth, authState }, input.data);
    // A handler returning the wrong shape is a server bug, never sent as-is.
    result = { ok: true, output: op.output.parse(output) };
  } catch (error) {
    if (!(error instanceof OperationError)) {
      // It may have taken effect: retries with its key are refused, not run.
      if (claim)
        await finishIdempotent(ctx.env, claim, { kind: "unknown" }, ctx.metrics).catch(() => {});
      throw error;
    }
    result = fail(ctx, error.status, error.code, error.message, {
      ...(error.resync !== undefined && { resync: error.resync }),
      ...(error.currentVersion !== undefined && { currentVersion: error.currentVersion }),
      ...(error.retryAfter !== undefined && { retryAfter: error.retryAfter }),
    });
  }
  if (claim) await finishIdempotent(ctx.env, claim, outcomeOf(op, result), ctx.metrics);
  return result;
}
