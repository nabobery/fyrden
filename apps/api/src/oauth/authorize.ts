import { isPermission, PERMISSIONS } from "@fyrden/domain";
import { clock } from "../services.js";
import { clientById, matchesRedirect, type OAuthClient } from "./clients.js";
import { formParams, type OAuthContext, originOf, randomSecret, sha256Hex } from "./params.js";
import { resourceOf } from "./resources.js";
import { sessionUser } from "./session.js";

/**
 * The authorization endpoint (OAuth 2.1 authorization code with PKCE).
 * `GET /oauth/authorize` checks the request and asks the signed-in user to
 * consent (a page naming the client, the scopes and the resource);
 * `POST /oauth/authorize` takes the user's answer and sends the browser
 * back to the client with a single-use code, or an error. The request is
 * kept server-side between the two (`oauth_requests`): the page carries
 * only its id, and the answer must come from this origin and the same
 * user, so a cross-site form cannot approve one.
 */

/** Proposed. */
export const AUTHORIZE_POLICY = {
  /** How long a user has to answer the consent page. */
  requestTtlMs: 10 * 60 * 1000,
  /** How long a code may be redeemed after it is issued. */
  codeTtlMs: 60 * 1000,
  /** Requests one user may have waiting for an answer at once. */
  pendingPerUser: 20,
};

const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

type Html = { readonly __html: string };

const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );

function page(c: OAuthContext, status: 200 | 400 | 401 | 429, title: string, body: Html): Response {
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${escapeHtml(title)} · Fyrden</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#111}
h1{font-size:1.4rem}ul{padding-left:1.2rem}code{font-size:.9em}.actions{display:flex;gap:.75rem;margin-top:1.5rem}
button{font:inherit;padding:.5rem 1rem;border-radius:.4rem;border:1px solid #888;background:#fff;cursor:pointer}
button.primary{background:#1f6feb;border-color:#1f6feb;color:#fff}
@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}button{background:#21262d;color:#e6edf3}}</style>
</head><body><h1>${escapeHtml(title)}</h1>${body.__html}</body></html>`,
    status,
    {
      "Cache-Control": "no-store",
      // The page is never framed (clickjacking) and loads nothing.
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
    },
  );
}

const html = (text: string): Html => ({ __html: text });

/** An error the client cannot be told of (its identity or redirect URI is in doubt): shown to the user. */
const badRequest = (c: OAuthContext, why: string) =>
  page(c, 400, "This sign-in request is not valid", html(`<p>${escapeHtml(why)}</p>`));

/** Sends the browser back to the client (RFC 6749 §4.1.2, with RFC 9207 `iss`). */
function backToClient(
  c: OAuthContext,
  redirectUri: string,
  params: Record<string, string | null | undefined>,
): Response {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries({ ...params, iss: originOf(c) }))
    if (value != null) url.searchParams.set(key, value);
  return new Response(null, {
    status: 303,
    headers: { Location: url.toString(), "Cache-Control": "no-store" },
  });
}

/** `GET /oauth/authorize`. */
export async function authorizeRequest(c: OAuthContext): Promise<Response> {
  const q = new URL(c.req.url).searchParams;
  for (const key of new Set(q.keys()))
    if (q.getAll(key).length > 1) return badRequest(c, `The parameter ${key} is sent twice.`);
  const clientId = q.get("client_id") ?? "";
  const redirectUri = q.get("redirect_uri") ?? "";
  const client = clientId ? await clientById(c.env, clientId) : undefined;
  if (!client) return badRequest(c, "The application is not known here.");
  // Exact match (RFC 9700 §4.1.3; a loopback one with any port): the client is told nothing until this holds.
  if (!matchesRedirect(client.redirectUris, redirectUri))
    return badRequest(c, "The application's redirect address is not one it registered.");
  const state = q.get("state");
  const fail = (error: string, description: string) =>
    backToClient(c, redirectUri, { error, error_description: description, state });
  if (q.get("response_type") !== "code")
    return fail("unsupported_response_type", "Only the authorization code flow is supported.");
  if (
    q.get("code_challenge_method") !== "S256" ||
    !PKCE_CHALLENGE.test(q.get("code_challenge") ?? "")
  )
    return fail(
      "invalid_request",
      "PKCE with S256 is required (code_challenge, code_challenge_method=S256).",
    );
  const resource = q.get("resource") ?? "";
  if (!resourceOf(originOf(c), resource))
    return fail("invalid_target", `resource must be ${originOf(c)}/mcp or ${originOf(c)}/api.`);
  const scopes = [...new Set((q.get("scope") ?? "").split(" ").filter(Boolean))];
  if (scopes.length === 0 || !scopes.every(isPermission))
    return fail("invalid_scope", "scope must name one or more Fyrden permissions.");

  const user = await sessionUser(c);
  if (!user)
    return page(
      c,
      401,
      "Sign in to Fyrden first",
      html(
        `<p>${escapeHtml(client.name ?? "An application")} asks to use your Fyrden account. Sign in, then start again from the application.</p>`,
      ),
    );

  if (!(await c.env.RATE_LIMIT_WRITE.limit({ key: `authorize:${user.userId}` })).success)
    return page(
      c,
      429,
      "Too many sign-in requests",
      html("<p>Wait a minute, then start again from the application.</p>"),
    );
  const id = randomSecret();
  const now = clock();
  // Only while the user has fewer than its share waiting (checked in the insert).
  const inserted = await c.env.DIRECTORY.prepare(
    `INSERT INTO oauth_requests (id, user_id, client_id, redirect_uri, code_challenge, scopes,
       resource, state, expires_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
     WHERE (SELECT count(*) FROM oauth_requests WHERE user_id = ?2 AND code_hash IS NULL
       AND expires_at > ?10) < ?11`,
  )
    .bind(
      id,
      user.userId,
      client.clientId,
      redirectUri,
      q.get("code_challenge"),
      JSON.stringify(scopes),
      resource,
      state,
      now + AUTHORIZE_POLICY.requestTtlMs,
      now,
      AUTHORIZE_POLICY.pendingPerUser,
    )
    .run();
  if ((inserted.meta.changes ?? 0) === 0)
    return page(
      c,
      429,
      "Too many sign-in requests",
      html("<p>Answer or let expire the ones waiting, then start again from the application.</p>"),
    );
  return consentPage(c, client, { id, user: user.handle, scopes, resource, redirectUri });
}

function consentPage(
  c: OAuthContext,
  client: OAuthClient,
  request: { id: string; user: string; scopes: string[]; resource: string; redirectUri: string },
): Response {
  const name = escapeHtml(client.name ?? "An unnamed application");
  const scopes = request.scopes
    .map(
      (s) =>
        `<li><code>${escapeHtml(s)}</code>: ${escapeHtml(PERMISSIONS[s as keyof typeof PERMISSIONS].summary)}</li>`,
    )
    .join("");
  return page(
    c,
    200,
    `Allow ${client.name ?? "this application"} to use your account?`,
    html(`<p><strong>${name}</strong> asks to act as <strong>${escapeHtml(request.user)}</strong> on <code>${escapeHtml(request.resource)}</code>, with:</p>
<ul>${scopes}</ul>
<p>Allowing sends you back to <code>${escapeHtml(new URL(request.redirectUri).origin)}</code>.</p>
<form method="post" action="/oauth/authorize"><input type="hidden" name="request_id" value="${escapeHtml(request.id)}">
<div class="actions"><button class="primary" name="decision" value="allow">Allow</button>
<button name="decision" value="deny">Deny</button></div></form>`),
  );
}

/** `POST /oauth/authorize`: the user's answer. */
export async function authorizeDecision(c: OAuthContext): Promise<Response> {
  // Only a form this origin served answers (with the session cookie, SameSite=Lax).
  if (c.req.header("Origin") !== originOf(c))
    return badRequest(c, "The answer did not come from Fyrden's own page.");
  const params = await formParams(c);
  if (!params || params === "too_large") return badRequest(c, "The answer is malformed.");
  const user = await sessionUser(c);
  const id = params.get("request_id") ?? "";
  const row = await c.env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT user_id, client_id, redirect_uri, state, expires_at, code_hash
       FROM oauth_requests WHERE id = ?`,
    )
    .bind(id)
    .first<{
      user_id: string;
      client_id: string;
      redirect_uri: string;
      state: string | null;
      expires_at: number;
      code_hash: string | null;
    }>();
  if (
    !user ||
    !row ||
    row.user_id !== user.userId ||
    row.code_hash !== null ||
    row.expires_at <= clock()
  )
    return badRequest(
      c,
      "This request has expired or was answered already; start again from the application.",
    );
  const now = clock();
  if (params.get("decision") !== "allow") {
    // The same unanswered state the allow claims: of two answers, one wins.
    const denied = await c.env.DIRECTORY.prepare(
      `UPDATE oauth_requests SET expires_at = 0
       WHERE id = ? AND user_id = ? AND code_hash IS NULL AND expires_at > ?`,
    )
      .bind(id, user.userId, now)
      .run();
    if ((denied.meta.changes ?? 0) === 0)
      return badRequest(c, "This request was answered already; start again from the application.");
    return backToClient(c, row.redirect_uri, {
      error: "access_denied",
      error_description: "The user denied the request.",
      state: row.state,
    });
  }
  const code = randomSecret();
  const issued = await c.env.DIRECTORY.prepare(
    `UPDATE oauth_requests SET code_hash = ?, code_expires_at = ?
     WHERE id = ? AND user_id = ? AND code_hash IS NULL AND expires_at > ?`,
  )
    .bind(await sha256Hex(code), now + AUTHORIZE_POLICY.codeTtlMs, id, user.userId, now)
    .run();
  if ((issued.meta.changes ?? 0) === 0)
    return badRequest(c, "This request was answered already; start again from the application.");
  // In use: kept past the pruning of registrations nobody uses (at most one write an hour).
  await c.env.DIRECTORY.prepare(
    `UPDATE oauth_clients SET last_used_at = ?1 WHERE client_id = ?2
       AND (last_used_at IS NULL OR last_used_at < ?1 - 3600000)`,
  )
    .bind(now, row.client_id)
    .run();
  return backToClient(c, row.redirect_uri, { code, state: row.state });
}
