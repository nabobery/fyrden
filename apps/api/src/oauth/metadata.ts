import { PERMISSION_NAMES } from "@fyrden/domain";
import { Hono } from "hono";
import type { AuthVariables } from "../middleware/auth.js";
import { DPOP_ALGS } from "./dpop.js";
import { TOKEN_EXCHANGE } from "./exchange.js";
import { originOf } from "./params.js";
import { RESOURCES, type Resource, resourceUri } from "./resources.js";

/**
 * Discovery: the authorization server's metadata (RFC 8414) and each
 * protected resource's (RFC 9728), which a 401's `WWW-Authenticate`
 * points to. Public, cacheable, readable from any origin.
 */
export const wellKnownRouter = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

const PUBLIC = { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" };

wellKnownRouter.get("/oauth-authorization-server", (c) => {
  const origin = originOf(c);
  return c.json(
    {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token", TOKEN_EXCHANGE],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: PERMISSION_NAMES,
      authorization_response_iss_parameter_supported: true,
      dpop_signing_alg_values_supported: DPOP_ALGS,
      client_id_metadata_document_supported: true,
    },
    200,
    PUBLIC,
  );
});

wellKnownRouter.get("/oauth-protected-resource/:resource", (c) => {
  const resource = c.req.param("resource");
  if (!RESOURCES.includes(resource as Resource)) return c.notFound();
  const origin = originOf(c);
  return c.json(
    {
      resource: resourceUri(origin, resource as Resource),
      resource_name: resource === "mcp" ? "Fyrden MCP server" : "Fyrden REST API",
      authorization_servers: [origin],
      scopes_supported: PERMISSION_NAMES,
      bearer_methods_supported: ["header"],
      dpop_signing_alg_values_supported: DPOP_ALGS,
    },
    200,
    PUBLIC,
  );
});
