import type { TokenRecord, VerifyMode, VerifyResult } from "@fyrden/adapters-cloudflare/auth";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { problem } from "../http/problem.js";
import { checkProof, DPOP_ALGS, takeJti } from "../oauth/dpop.js";
import { audienceAllows, bearerChallenge, type Resource } from "../oauth/resources.js";
import { sessionUser } from "../oauth/session.js";
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
 * Reads a token from `Authorization: Bearer <token>`, `Authorization: DPoP
 * <token>` (a DPoP-bound token, RFC 9449) or from the password slot of
 * Basic auth (what git clients send).
 */
export function extractCredential(
  header: string | undefined,
): { token: string; scheme: "bearer" | "dpop" | "basic" } | undefined {
  if (!header) return undefined;
  const [scheme, value] = header.split(" ", 2);
  if (!scheme || !value) return undefined;
  const kind = scheme.toLowerCase();
  if (kind === "bearer" || kind === "dpop") return { token: value.trim(), scheme: kind };
  if (kind === "basic") {
    try {
      const decoded = atob(value.trim());
      const colon = decoded.indexOf(":");
      return colon >= 0 ? { token: decoded.slice(colon + 1), scheme: "basic" } : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The header with which the web UI's server presents a signed-in user's session cookie. */
export const SESSION_HEADER = "X-Fyrden-Session";

/**
 * A signed-in user's session as a credential: the user's full rights,
 * checked on the primary each time (a revoked session stops at once).
 */
async function sessionCredential(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
): Promise<AuthState | undefined> {
  const client = c.req.header("CF-Connecting-IP") ?? "unknown";
  if (!(await c.env.RATE_LIMIT_AUTH.limit({ key: client })).success) return undefined;
  const record = async (): Promise<VerifyResult> => {
    const user = await sessionUser(c);
    if (!user) return { ok: false, reason: "revoked" };
    return {
      ok: true,
      record: {
        id: user.sessionId,
        type: "ses",
        principalId: user.userId,
        principalType: "user",
        principalHandle: user.handle,
        isInstanceAdmin: user.isInstanceAdmin,
        scopes: [],
        repoIds: null,
        expiresAt: user.expiresAt,
        lastUsedAt: null,
        act: [],
        grantId: null,
        ceilingIds: [],
        audience: null,
        dpopJkt: null,
        requiresDpop: false,
      },
    };
  };
  const first = await record();
  if (!first.ok) return undefined;
  c.set(
    "log",
    c.get("log").child({ principalId: first.record.principalId, principalType: "user" }),
  );
  return { record: first.record, mode: "write", verifyForWrite: record };
}

/** The token alone (see `extractCredential`). */
export const extractToken = (header: string | undefined): string | undefined =>
  extractCredential(header)?.token;

/**
 * Whether a verified token is presented as it must be: a DPoP-bound one
 * with the `DPoP` scheme and a fresh proof by its key naming this request
 * and the token (each proof taken once); a bearer one not with the `DPoP`
 * scheme; and, where an acting agent's owner requires DPoP, only a
 * DPoP-bound token, except a git token used by git itself (`git`: git
 * cannot send proofs; the same token at the REST API or MCP is refused).
 */
async function presentedAsBound(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
  record: TokenRecord,
  credential: { token: string; scheme: string },
  git: boolean,
): Promise<boolean> {
  if (record.dpopJkt === null) {
    if (credential.scheme === "dpop") return false;
    return !(record.requiresDpop && !(git && record.type === "git"));
  }
  const proof = c.req.header("DPoP");
  if (credential.scheme !== "dpop" || !proof) return false;
  const check = await checkProof(
    proof,
    { method: c.req.method, url: c.req.url, now: Date.now() },
    credential.token,
  );
  return check.ok && check.jkt === record.dpopJkt && (await takeJti(c.env, check));
}

export const invalidToken = (c: Context, resource: Resource = "api") =>
  problem(c, 401, "invalid_token", "The token is invalid, expired or revoked.", {
    "WWW-Authenticate": bearerChallenge(new URL(c.req.url).origin, resource, "invalid_token"),
  });

export type Authentication =
  | { ok: true; state: AuthState }
  | { ok: false; reason: "missing" | "rate_limited" | "invalid" | "dpop" };

/**
 * Verifies the request's token in `mode`. Every attempt is rate limited per
 * client address before the token is looked up, so a stream of made-up
 * tokens cannot drive unbounded D1 reads. On success the request's logger
 * names the principal. `git`: the request is git's own (smart HTTP).
 */
export async function authenticate(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
  mode: VerifyMode,
  options: { readonly git?: boolean } = {},
): Promise<Authentication> {
  const credential = extractCredential(c.req.header("Authorization"));
  if (!credential) {
    // The web UI's server, for a signed-in user: the session cookie, with a header no
    // cross-site page can send (it would need a CORS preflight the API never grants).
    if (c.req.header(SESSION_HEADER) === "1") {
      const session = await sessionCredential(c);
      if (session) return { ok: true, state: session };
      return { ok: false, reason: "invalid" };
    }
    return { ok: false, reason: "missing" };
  }
  const { token } = credential;
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
  if (!(await presentedAsBound(c, result.record, credential, options.git === true)))
    return { ok: false, reason: "dpop" };

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
      if (auth.reason === "dpop")
        return problem(
          c,
          401,
          "invalid_dpop_proof",
          "This token needs a valid DPoP proof (RFC 9449).",
          {
            "WWW-Authenticate": `DPoP algs="${DPOP_ALGS.join(" ")}", error="invalid_dpop_proof"`,
          },
        );
      return invalidToken(c, resource);
    }
    // A token issued for another resource (RFC 8707) is not taken here.
    if (!audienceAllows(auth.state.record.audience, origin, resource))
      return invalidToken(c, resource);
    c.set("auth", auth.state.record);
    c.set("authState", auth.state);
    await next();
  });
