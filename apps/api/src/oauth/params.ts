import type { Context } from "hono";
import { readBoundedBody } from "../http/body.js";
import type { AuthVariables } from "../middleware/auth.js";

/** What the authorization server's endpoints share: their context, answers and request parameters. */

export type OAuthContext = Context<{ Bindings: Env; Variables: AuthVariables }>;

export type OAuthError =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "invalid_scope"
  | "invalid_target"
  | "unsupported_grant_type"
  | "invalid_redirect_uri"
  | "invalid_client_metadata"
  | "invalid_dpop_proof"
  | "slow_down";

/** Token responses are never cached (RFC 6749 §5.1). */
export const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };

/** The largest request body the endpoints read (their requests are a few hundred bytes). */
export const MAX_OAUTH_BODY_BYTES = 16 * 1024;

/** An RFC 6749 §5.2 error answer. */
export function refuse(
  c: OAuthContext,
  error: OAuthError,
  description: string,
  status: 400 | 401 | 413 | 429 = 400,
) {
  return c.json({ error, error_description: description }, status, NO_STORE);
}

/**
 * The request's parameters: a form (RFC 6749) or, for convenience, a JSON
 * object of strings; undefined for anything else, a parameter sent twice
 * (RFC 6749 §3.2), or a body past `MAX_OAUTH_BODY_BYTES` (`"too_large"`).
 */
export async function formParams(
  c: OAuthContext,
): Promise<Map<string, string> | "too_large" | undefined> {
  const body = await readBoundedBody(c.req.raw, MAX_OAUTH_BODY_BYTES);
  if (body === undefined) return "too_large";
  const text = new TextDecoder().decode(body);
  const type = c.req.header("Content-Type") ?? "";
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
  for (const [key, value] of new URLSearchParams(text)) {
    if (params.has(key)) return undefined;
    params.set(key, value);
  }
  return params;
}

/** The deployment's origin, which issues tokens and names its resources. */
export const originOf = (c: OAuthContext): string => new URL(c.req.url).origin;

/** Unpadded base64url of `bytes`. */
export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Lowercase hex SHA-256 of `text`. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A random secret of `bytes` bytes, base64url (codes, request ids). */
export const randomSecret = (bytes = 32): string =>
  base64url(crypto.getRandomValues(new Uint8Array(bytes)));
