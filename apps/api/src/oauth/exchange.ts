import { delegationOf, readGrantLinks } from "@fyrden/adapters-cloudflare/auth";
import { isPermission, scopesAllow } from "@fyrden/domain";
import { grantById } from "../accounts/delegation.js";
import { clock, tokenStore } from "../services.js";
import { NO_STORE, type OAuthContext, originOf, refuse } from "./params.js";
import { resourceOf, resourceUri } from "./resources.js";

/**
 * RFC 8693 token exchange, by which an agent trades its own token for a
 * delegated one under a delegation grant (`grant_id`, a Fyrden
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
};

async function enabled(env: Env, principalId: string): Promise<boolean> {
  const row = await env.DIRECTORY.withSession("first-primary")
    .prepare("SELECT 1 AS one FROM principals WHERE id = ? AND disabled_at IS NULL")
    .bind(principalId)
    .first();
  return row !== null;
}

/** `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`. */
export async function tokenExchange(
  c: OAuthContext,
  params: Map<string, string>,
): Promise<Response> {
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
  // For one resource (RFC 8707): the REST API unless the MCP server is asked for.
  const resource = params.get("resource");
  if (resource !== undefined && !resourceOf(originOf(c), resource))
    return refuse(
      c,
      "invalid_target",
      `resource must be ${originOf(c)}/mcp or ${originOf(c)}/api.`,
    );

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
    // Bound to one resource (RFC 8707): the one asked for, else the REST API.
    audience: resource ?? resourceUri(originOf(c), "api"),
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
}
