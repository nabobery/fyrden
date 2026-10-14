import { readBoundedBody } from "../http/body.js";
import { clock, newId } from "../services.js";
import { MAX_OAUTH_BODY_BYTES, NO_STORE, type OAuthContext, refuse } from "./params.js";

/**
 * OAuth clients. Every client is public (PKCE, no secret): a native app,
 * a command-line tool or an MCP client on someone's machine. Dynamic
 * registration (RFC 7591) is kept for clients that need it (the MCP spec
 * prefers client ID metadata documents).
 */

export interface OAuthClient {
  readonly clientId: string;
  readonly name: string | null;
  readonly redirectUris: readonly string[];
}

/** Proposed. */
export const CLIENT_POLICY = {
  maxRedirectUris: 10,
  maxUriLength: 2000,
  maxNameLength: 100,
  /** Registrations the whole deployment takes in an hour (each address is rate limited too). */
  perHour: 1000,
};

/**
 * Whether `uri` may receive codes: an `https` URL, an `http` one on the
 * loopback interface (a native app's, RFC 8252 §7.3), or a private-use
 * scheme (reverse domain name, RFC 8252 §7.1); never with a fragment.
 */
export function isRedirectUri(uri: string): boolean {
  if (uri.length > CLIENT_POLICY.maxUriLength) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash !== "" || uri.includes("#")) return false;
  if (url.protocol === "https:") return url.hostname !== "";
  if (url.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  // A private-use scheme: a reverse domain name, so no web scheme is taken.
  return /^[a-z][a-z0-9+-]*(\.[a-z0-9+-]+)+:$/.test(url.protocol);
}

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * Whether `uri` is one of `registered`: exactly, or for a loopback `http`
 * URI, with any port (a native app listens where it can, RFC 8252 §7.3).
 */
export function matchesRedirect(registered: readonly string[], uri: string): boolean {
  if (registered.includes(uri)) return true;
  let given: URL;
  try {
    given = new URL(uri);
  } catch {
    return false;
  }
  if (given.protocol !== "http:" || !LOOPBACK.has(given.hostname) || uri.includes("#"))
    return false;
  return registered.some((r) => {
    const known = new URL(r);
    return (
      known.protocol === "http:" &&
      known.hostname === given.hostname &&
      known.pathname === given.pathname &&
      known.search === given.search
    );
  });
}

/** The client `clientId`, if it is registered. */
export async function clientById(env: Env, clientId: string): Promise<OAuthClient | undefined> {
  const row = await env.DIRECTORY.withSession("first-primary")
    .prepare("SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?")
    .bind(clientId)
    .first<{ client_id: string; client_name: string | null; redirect_uris: string }>();
  return row
    ? {
        clientId: row.client_id,
        name: row.client_name,
        redirectUris: JSON.parse(row.redirect_uris) as string[],
      }
    : undefined;
}

/** `POST /oauth/register`: registers a public client (RFC 7591). Rate limited per address. */
export async function registerClient(c: OAuthContext): Promise<Response> {
  const client = c.req.header("CF-Connecting-IP") ?? "unknown";
  if (!(await c.env.RATE_LIMIT_AUTH.limit({ key: client })).success)
    return refuse(c, "slow_down", "Too many registrations from this address.", 429);
  if (!(c.req.header("Content-Type") ?? "").startsWith("application/json"))
    return refuse(c, "invalid_client_metadata", "Send the client's metadata as JSON.");
  const body = await readBoundedBody(c.req.raw, MAX_OAUTH_BODY_BYTES);
  if (body === undefined) return refuse(c, "invalid_request", "The body is too large.", 413);
  let metadata: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    metadata = parsed as Record<string, unknown>;
  } catch {
    return refuse(c, "invalid_client_metadata", "The body is not a JSON object.");
  }
  const uris = metadata.redirect_uris;
  if (
    !Array.isArray(uris) ||
    uris.length === 0 ||
    uris.length > CLIENT_POLICY.maxRedirectUris ||
    !uris.every((u) => typeof u === "string" && isRedirectUri(u))
  )
    return refuse(
      c,
      "invalid_redirect_uri",
      "redirect_uris: 1 to 10 https URLs, loopback http URLs or private-use scheme URIs, without fragments.",
    );
  const method = metadata.token_endpoint_auth_method ?? "none";
  if (method !== "none")
    return refuse(
      c,
      "invalid_client_metadata",
      "Only public clients register here (token_endpoint_auth_method none, with PKCE).",
    );
  // Every client gets both (RFC 7591 §3.2.1 lets the server replace what it asked for); the
  // answer says so.
  const grants = metadata.grant_types ?? ["authorization_code"];
  if (
    !Array.isArray(grants) ||
    !grants.includes("authorization_code") ||
    !grants.every((g) => g === "authorization_code" || g === "refresh_token")
  )
    return refuse(
      c,
      "invalid_client_metadata",
      "grant_types: authorization_code, and refresh_token.",
    );
  const types = metadata.response_types ?? ["code"];
  if (!Array.isArray(types) || !types.every((t) => t === "code"))
    return refuse(c, "invalid_client_metadata", "response_types: code.");
  const name =
    typeof metadata.client_name === "string"
      ? metadata.client_name.slice(0, CLIENT_POLICY.maxNameLength)
      : null;
  const clientId = newId("cli");
  const now = clock();
  const db = c.env.DIRECTORY;
  // Only while the deployment took fewer than its hourly budget (checked in the insert).
  const [inserted] = await db.batch([
    db
      .prepare(
        `INSERT INTO oauth_clients (client_id, kind, client_name, redirect_uris, created_at)
         SELECT ?1, 'registered', ?2, ?3, ?4
         WHERE (SELECT count(*) FROM oauth_clients WHERE created_at > ?5) < ?6`,
      )
      .bind(clientId, name, JSON.stringify(uris), now, now - 60 * 60 * 1000, CLIENT_POLICY.perHour),
    db
      .prepare(
        `INSERT INTO audit_log (at, actor_id, action, target_id, details, request_id)
         SELECT ?1, NULL, 'oauth.client_register', ?2, json_object('name', ?3), ?4
         WHERE EXISTS (SELECT 1 FROM oauth_clients WHERE client_id = ?2)`,
      )
      .bind(now, clientId, name, c.get("requestId") ?? null),
  ]);
  if ((inserted?.meta.changes ?? 0) === 0)
    return refuse(c, "slow_down", "Too many registrations right now; try again later.", 429);
  return c.json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(now / 1000),
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    201,
    NO_STORE,
  );
}
