import { Hono } from "hono";
import type { AuthVariables } from "../middleware/auth.js";
import { authorizeDecision, authorizeRequest } from "./authorize.js";
import { registerClient } from "./clients.js";
import { TOKEN_EXCHANGE, tokenExchange } from "./exchange.js";
import { codeGrant, refreshGrant, revokeToken } from "./issue.js";
import { formParams, refuse } from "./params.js";

/**
 * The authorization server (OAuth 2.1, public clients with PKCE): the
 * authorization endpoint and its consent, the token endpoint (authorization
 * code, refresh token and RFC 8693 token exchange grants), revocation
 * (RFC 7009) and client registration (RFC 7591). Metadata is served from
 * `/.well-known` (`metadata.ts`).
 */
export const oauthRouter = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

oauthRouter.get("/authorize", authorizeRequest);
oauthRouter.post("/authorize", authorizeDecision);
oauthRouter.post("/register", registerClient);

oauthRouter.post("/token", async (c) => {
  const client = c.req.header("CF-Connecting-IP") ?? "unknown";
  if (!(await c.env.RATE_LIMIT_AUTH.limit({ key: client })).success)
    return refuse(c, "slow_down", "Too many token requests from this address.", 429);
  const params = await formParams(c);
  if (params === "too_large")
    return refuse(c, "invalid_request", "The request body is too large.", 413);
  if (!params)
    return refuse(c, "invalid_request", "The body is not a form (or a JSON object) of parameters.");
  switch (params.get("grant_type")) {
    case "authorization_code":
      return codeGrant(c, params);
    case "refresh_token":
      return refreshGrant(c, params);
    case TOKEN_EXCHANGE:
      return tokenExchange(c, params);
    default:
      return refuse(
        c,
        "unsupported_grant_type",
        `grant_type: authorization_code, refresh_token or ${TOKEN_EXCHANGE}.`,
      );
  }
});

oauthRouter.post("/revoke", async (c) => {
  const client = c.req.header("CF-Connecting-IP") ?? "unknown";
  if (!(await c.env.RATE_LIMIT_AUTH.limit({ key: client })).success)
    return refuse(c, "slow_down", "Too many requests from this address.", 429);
  const params = await formParams(c);
  if (!params || params === "too_large")
    return refuse(c, "invalid_request", "The body is malformed.");
  return revokeToken(c, params);
});
