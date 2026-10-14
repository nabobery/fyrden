import { delegationOf, readGrantLinks } from "@fyrden/adapters-cloudflare/auth";
import { isPermission, scopesAllow } from "@fyrden/domain";
import type { Context } from "hono";
import { Hono } from "hono";
import { grantById } from "../accounts/delegation.js";
import type { AuthVariables } from "../middleware/auth.js";
import { clock, tokenStore } from "../services.js";

/**
 * The authorization server's token endpoint. It takes one grant type for
 * now: RFC 8693 token exchange, by which an agent trades its own token for
 * a delegated one under a delegation grant (`grant_id`, a Fyrden
 * parameter). The delegated token's principal is the user the grant is
 * from (`sub`); its act chain is the grant's agent, then, for a grant
 * passed down, the parent grant's agent (`act`, then `act.act`). It never
 * exceeds the grant, the grants above it, or the agent's own token, and
 * lives at most an hour (Proposed), and no longer than any of them.
 */

export const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
export const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

/** Proposed. */
export const EXCHANGE_POLICY = {
  /** The longest a delegated token lives. */
  accessTokenTtlMs: 60 * 60 * 1000,
  /** The largest request body read (a token request is a few hundred bytes). */
  maxBodyBytes: 16 * 1024,
};

type OAuthError =
  | "invalid_request"
  | "invalid_grant"
  | "invalid_scope"
  | "unsupported_grant_type"
  | "slow_down";

type Ctx = Context<{ Bindings: Env; Variables: AuthVariables }>;

const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };

/** An RFC 6749 §5.2 error answer. */
function refuse(c: Ctx, error: OAuthError, description: string, status: 400 | 413 | 429 = 400) {
  return c.json({ error, error_description: description }, status, NO_STORE);
}

/**
 * The request body as text, read up to `limit` bytes; undefined past it
 * (whatever `Content-Length` says, or without one).
 */
async function boundedText(request: Request, limit: number): Promise<string | undefined> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > limit) return undefined;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** The request's parameters: a form (RFC 6749) or, for convenience, a JSON object of strings. */
function paramsOf(type: string, text: string): Map<string, string> | undefined {
  const params = new Map<string, string>();
  if (type.startsWith("application/json")) {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    for (const [key, value] of Object.entries(raw))
      if (typeof value === "string") params.set(key, value);
    return params;
  }
  if (!type.startsWith("application/x-www-form-urlencoded")) return undefined;
  // A parameter sent twice is refused (RFC 6749 §3.2).
  for (const [key, value] of new URLSearchParams(text)) {
    if (params.has(key)) return undefined;
    params.set(key, value);
  }
  return params;
}

async function enabled(env: Env, principalId: string): Promise<boolean> {
  const row = await env.DIRECTORY.withSession("first-primary")
    .prepare("SELECT 1 AS one FROM principals WHERE id = ? AND disabled_at IS NULL")
    .bind(principalId)
    .first();
  return row !== null;
}

export const oauthRouter = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

oauthRouter.post("/token", async (c) => {
  const client = c.req.header("CF-Connecting-IP") ?? "unknown";
  if (!(await c.env.RATE_LIMIT_AUTH.limit({ key: client })).success)
    return refuse(c, "slow_down", "Too many token requests from this address.", 429);
  const text = await boundedText(c.req.raw, EXCHANGE_POLICY.maxBodyBytes);
  if (text === undefined)
    return refuse(c, "invalid_request", "The request body is too large.", 413);
  const params = paramsOf(c.req.header("Content-Type") ?? "", text);
  if (!params)
    return refuse(c, "invalid_request", "The body is not a form (or a JSON object) of parameters.");
  if (params.get("grant_type") !== TOKEN_EXCHANGE)
    return refuse(c, "unsupported_grant_type", `Only ${TOKEN_EXCHANGE} is supported.`);
  const subjectToken = params.get("subject_token");
  const grantId = params.get("grant_id");
  if (!subjectToken || params.get("subject_token_type") !== ACCESS_TOKEN_TYPE)
    return refuse(
      c,
      "invalid_request",
      `subject_token (the agent's own token) and subject_token_type ${ACCESS_TOKEN_TYPE} are required.`,
    );
  const requested = params.get("requested_token_type");
  if (requested !== undefined && requested !== ACCESS_TOKEN_TYPE)
    return refuse(c, "invalid_request", `Only ${ACCESS_TOKEN_TYPE} is issued.`);
  if (!grantId) return refuse(c, "invalid_request", "grant_id (the delegation grant) is required.");

  const metrics = c.get("metrics");
  const store = tokenStore(c.env, { metrics });
  // On the primary: a revoked agent token exchanges for nothing.
  const subject = await store.verify(subjectToken, "write");
  if (!subject.ok || subject.record.principalType !== "agent" || subject.record.act.length > 0)
    return refuse(c, "invalid_grant", "The subject token is not a valid token of an agent's own.");
  const agent = subject.record;

  const now = clock();
  const grant = await grantById(c.env, grantId);
  if (!grant || grant.agent_id !== agent.principalId || !(await enabled(c.env, grant.grantor_id)))
    return refuse(c, "invalid_grant", "The agent holds no such grant.");
  // The chain from the grants themselves: this grant's agent, then its parent's.
  metrics.count("d1.query", { db: "directory", op: "token_grants" });
  const links = await readGrantLinks(c.env.DIRECTORY.withSession("first-primary"), grant.id);
  const parent = links.find((l) => l.id === grant.parent_id);
  const act = parent ? [grant.agent_id, parent.agent_id] : [grant.agent_id];
  if (!delegationOf(grant.id, JSON.stringify(act), links, now))
    return refuse(
      c,
      "invalid_grant",
      "The grant is revoked or expired, or an agent or owner is disabled.",
    );

  // Within the grant and the agent's own token (an empty list there: its full rights).
  const grantScopes = JSON.parse(grant.scopes) as string[];
  const scopeParam = params.get("scope");
  const scopes = scopeParam === undefined ? grantScopes : scopeParam.split(" ").filter(Boolean);
  if (
    scopes.length === 0 ||
    !scopes.every(
      (s) => isPermission(s) && scopesAllow(grantScopes, s) && scopesAllow(agent.scopes, s),
    )
  )
    return refuse(c, "invalid_scope", "The scopes exceed the grant's or the agent token's.");
  const grantRepos = grant.repo_ids === null ? null : (JSON.parse(grant.repo_ids) as string[]);
  const repoIds =
    grantRepos === null
      ? agent.repoIds
      : agent.repoIds === null
        ? grantRepos
        : grantRepos.filter((id) => agent.repoIds?.includes(id));

  const until = Math.min(
    now + EXCHANGE_POLICY.accessTokenTtlMs,
    grant.expires_at,
    ...links.map((l) => l.expires_at),
    agent.expiresAt,
  );
  // Judged again now: a deadline that passed during the lookups issues nothing.
  if (until <= clock())
    return refuse(c, "invalid_grant", "The grant or the agent's token expired meanwhile.");
  const minted = await store.mint({
    principalId: grant.grantor_id,
    type: "oat",
    scopes,
    repoIds,
    ttlMs: EXCHANGE_POLICY.accessTokenTtlMs,
    notAfter: until,
    delegation: { grantId: grant.id, act },
    audit: {
      actorId: agent.principalId,
      act,
      ...(c.get("requestId") !== undefined && { requestId: c.get("requestId") }),
    },
  });
  return c.json(
    {
      access_token: minted.token,
      issued_token_type: ACCESS_TOKEN_TYPE,
      token_type: "Bearer",
      expires_in: Math.max(0, Math.floor((minted.expiresAt - clock()) / 1000)),
      scope: scopes.join(" "),
    },
    200,
    NO_STORE,
  );
});
