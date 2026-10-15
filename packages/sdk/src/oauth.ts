/**
 * Getting tokens from Fyrden's OAuth 2.1 authorization server: the
 * authorization code flow with PKCE (S256) and a resource indicator
 * (RFC 8707), refresh, and token exchange for an agent acting under a
 * delegation grant (RFC 8693). With a DPoP key, each token comes bound
 * to it (RFC 9449); use the same key with `FyrdenClient`.
 */

import { base64url } from "./base64url.js";
import { FyrdenError, refuseRedirect } from "./client.js";
import type { DpopKey } from "./dpop.js";

export interface TokenResponse {
  readonly access_token: string;
  /** `DPoP` when bound to a key, else `Bearer`. */
  readonly token_type: string;
  readonly expires_in: number;
  readonly refresh_token?: string;
  readonly scope?: string;
}

/** What a token exchange answers (RFC 8693): what kind of token it issued, too. */
export interface ExchangedTokenResponse extends TokenResponse {
  readonly issued_token_type: string;
}

export interface TokenOptions {
  /** Binds the tokens to this key, sending a proof to the token endpoint. */
  readonly dpop?: DpopKey;
  /** Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}

/** A PKCE verifier and its S256 challenge (RFC 7636). */
export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/** Where to send the user to sign in and consent: `origin`'s `/oauth/authorize` with these parameters. */
export function authorizationUrl(
  origin: string,
  request: {
    readonly clientId: string;
    readonly redirectUri: string;
    /** From `createPkce`. */
    readonly codeChallenge: string;
    /** The API or MCP server the token is for (`<origin>/api` or `<origin>/mcp`). */
    readonly resource: string;
    readonly state: string;
    /** Space-separated permissions; the client's defaults when absent. */
    readonly scope?: string;
    /** Binds the code to a DPoP key's thumbprint (`dpop_jkt`). */
    readonly dpopJkt?: string;
  },
): string {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    code_challenge: request.codeChallenge,
    code_challenge_method: "S256",
    resource: request.resource,
    state: request.state,
    ...(request.scope !== undefined && { scope: request.scope }),
    ...(request.dpopJkt !== undefined && { dpop_jkt: request.dpopJkt }),
  });
  return `${new URL("/oauth/authorize", origin).href}?${query}`;
}

/** Exchanges the code the redirect brought back (with the PKCE verifier) for tokens. */
export function exchangeCode(
  origin: string,
  request: {
    readonly clientId: string;
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
    readonly resource: string;
  },
  options: TokenOptions = {},
): Promise<TokenResponse> {
  return tokenRequest(
    origin,
    {
      grant_type: "authorization_code",
      client_id: request.clientId,
      code: request.code,
      code_verifier: request.codeVerifier,
      redirect_uri: request.redirectUri,
      resource: request.resource,
    },
    options,
  );
}

/**
 * A new access token, and the next refresh token, from a refresh token.
 * Each refresh token is used once: keep the new one in place of the old,
 * refresh one at a time, and do not resend one whose answer was lost (its
 * reuse revokes the whole family).
 */
export function refreshToken(
  origin: string,
  request: { readonly clientId: string; readonly refreshToken: string; readonly resource?: string },
  options: TokenOptions = {},
): Promise<TokenResponse> {
  return tokenRequest(
    origin,
    {
      grant_type: "refresh_token",
      client_id: request.clientId,
      refresh_token: request.refreshToken,
      ...(request.resource !== undefined && { resource: request.resource }),
    },
    options,
  );
}

/**
 * An agent's token for acting for a user under `grantId` (RFC 8693): the
 * agent's own token as the subject; scopes and resource within the grant.
 */
export function exchangeToken(
  origin: string,
  request: {
    readonly subjectToken: string;
    readonly grantId: string;
    readonly scope?: string;
    readonly resource?: string;
  },
  options: TokenOptions = {},
): Promise<ExchangedTokenResponse> {
  return tokenRequest<ExchangedTokenResponse>(
    origin,
    {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: request.subjectToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      grant_id: request.grantId,
      ...(request.scope !== undefined && { scope: request.scope }),
      ...(request.resource !== undefined && { resource: request.resource }),
    },
    options,
    ["issued_token_type"],
  );
}

async function tokenRequest<T extends TokenResponse = TokenResponse>(
  origin: string,
  params: Record<string, string>,
  options: TokenOptions,
  /** Fields its answer must hold besides `access_token` and `token_type` (non-empty strings). */
  required: readonly string[] = [],
): Promise<T> {
  const url = new URL("/oauth/token", origin);
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (options.dpop) headers.DPoP = await options.dpop.proof("POST", url);
  const run = options.fetch ?? ((...args) => fetch(...args));
  const response = await run(url, {
    method: "POST",
    headers,
    body: new URLSearchParams(params).toString(),
    // A redirect would carry the code, refresh token or subject token elsewhere:
    // never followed ("error" is not offered everywhere, Workers among them).
    redirect: "manual",
    ...(options.signal && { signal: options.signal }),
  });
  refuseRedirect(response);
  const body = parseObject(await response.text());
  if (!response.ok)
    // An OAuth error (RFC 6749 §5.2): its code and description; anything else, its status.
    throw new FyrdenError(
      response.status,
      typeof body?.error === "string" ? body.error : "http_error",
      typeof body?.error_description === "string"
        ? body.error_description
        : `${response.status} ${response.statusText}`.trim(),
      undefined,
      undefined,
    );
  // Never a token without one (a proxy's page, an empty answer).
  const present = (field: string) => typeof body?.[field] === "string" && body[field] !== "";
  if (!["access_token", "token_type", ...required].every(present))
    throw new FyrdenError(
      response.status,
      "invalid_token_response",
      "The token endpoint answered without a token.",
      undefined,
      undefined,
    );
  return body as unknown as T;
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
