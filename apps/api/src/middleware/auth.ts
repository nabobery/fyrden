import type { TokenRecord, VerifyMode, VerifyResult } from "@fyrden/adapters-cloudflare/auth";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { problem } from "../http/problem.js";
import { audienceAllows, bearerChallenge, type Resource } from "../oauth/resources.js";
import { tokenStore } from "../services.js";
import type { ObsVariables } from "./obs.js";

export interface AuthState {
  record: TokenRecord;
  /** The mode the request was verified in. */
  mode: VerifyMode;
  /** Re-verifies against the D1 primary; used before a write on a read-verified request. */
  verifyForWrite(): Promise<VerifyResult>;
}

export type AuthVariables = ObsVariables & { auth: TokenRecord; authState: AuthState };

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Reads a token from `Authorization: Bearer <token>` or from the password
 * slot of Basic auth (what git clients send).
 */
export function extractToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, value] = header.split(" ", 2);
  if (!scheme || !value) return undefined;
  if (scheme.toLowerCase() === "bearer") return value.trim();
  if (scheme.toLowerCase() === "basic") {
    try {
      const decoded = atob(value.trim());
      const colon = decoded.indexOf(":");
      return colon >= 0 ? decoded.slice(colon + 1) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export const invalidToken = (c: Context, resource: Resource = "api") =>
  problem(c, 401, "invalid_token", "The token is invalid, expired or revoked.", {
    "WWW-Authenticate": bearerChallenge(new URL(c.req.url).origin, resource, "invalid_token"),
  });

export type Authentication =
  | { ok: true; state: AuthState }
  | { ok: false; reason: "missing" | "rate_limited" | "invalid" };

/**
 * Verifies the request's token in `mode`. Every attempt is rate limited per
 * client address before the token is looked up, so a stream of made-up
 * tokens cannot drive unbounded D1 reads. On success the request's logger
 * names the principal.
 */
export async function authenticate(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
  mode: VerifyMode,
): Promise<Authentication> {
  const token = extractToken(c.req.header("Authorization"));
  if (!token) return { ok: false, reason: "missing" };
  const client = c.req.header("CF-Connecting-IP") ?? "unknown";
  if (!(await c.env.RATE_LIMIT_AUTH.limit({ key: client })).success) {
    return { ok: false, reason: "rate_limited" };
  }

  const store = tokenStore(c.env, {
    defer: (p) => c.executionCtx.waitUntil(p),
    metrics: c.get("metrics"),
  });
  const result = await store.verify(token, mode);
  c.get("metrics").count("auth.token", {
    type: result.ok ? result.record.type : "unknown",
    outcome: result.ok ? "ok" : result.reason,
  });
  if (!result.ok) return { ok: false, reason: "invalid" };

  c.set(
    "log",
    c.get("log").child({
      principalId: result.record.principalId,
      principalType: result.record.principalType,
      ...(result.record.act.length > 0 && { act: result.record.act }),
    }),
  );
  return {
    ok: true,
    state: {
      record: result.record,
      mode,
      verifyForWrite: () => store.verify(token, "write"),
    },
  };
}

/**
 * Requires a valid token.
 *
 * - `by-method`: GET, HEAD and OPTIONS verify in read mode (isolate cache
 *   allowed); every other method against the D1 primary. Used by REST, where
 *   the HTTP method is the operation's method.
 * - `read`: always read mode. Used by MCP, where every call is a POST; the
 *   operation executor re-verifies on the primary before any write.
 */
export const requireAuth = (
  policy: "by-method" | "read" = "by-method",
  resource: Resource = "api",
) =>
  createMiddleware<{ Bindings: Env; Variables: AuthVariables }>(async (c, next) => {
    const mode: VerifyMode = policy === "read" || READ_METHODS.has(c.req.method) ? "read" : "write";
    const origin = new URL(c.req.url).origin;
    const auth = await authenticate(c, mode);
    if (!auth.ok) {
      if (auth.reason === "missing") {
        return problem(c, 401, "unauthenticated", "A token is required.", {
          "WWW-Authenticate": bearerChallenge(origin, resource),
        });
      }
      if (auth.reason === "rate_limited") {
        return problem(c, 429, "rate_limited", "Too many authentication attempts.", {
          "Retry-After": "60",
        });
      }
      return invalidToken(c, resource);
    }
    // A token issued for another resource (RFC 8707) is not taken here.
    if (!audienceAllows(auth.state.record.audience, origin, resource))
      return invalidToken(c, resource);
    c.set("auth", auth.state.record);
    c.set("authState", auth.state);
    await next();
  });
