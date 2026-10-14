import { generateToken, hashToken, secureRandomBytes } from "@fyrden/domain";
import { clock, newId } from "../services.js";
import { checkProof, takeJti } from "./dpop.js";
import { base64url, NO_STORE, type OAuthContext, originOf, refuse, sha256Hex } from "./params.js";
import { resourceOf } from "./resources.js";

/**
 * The token endpoint's authorization code and refresh token grants
 * (OAuth 2.1). A code is redeemed once, with its PKCE verifier, by the
 * client and redirect URI it was issued for; a refresh token is used once,
 * replaced by the next in the same batch (exactly one of two concurrent
 * uses wins), and coming back after its use revokes its whole family, the
 * access tokens included. Every issue writes its tokens and its audit row
 * together, each conditional on the claim this request won.
 */

/** Proposed. */
export const ISSUE_POLICY = {
  accessTokenTtlMs: 60 * 60 * 1000,
  refreshTokenTtlMs: 30 * 24 * 60 * 60 * 1000,
  /** The longest a family lives from its first token: the user consents again after it. */
  familyTtlMs: 90 * 24 * 60 * 60 * 1000,
};

const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

interface Issued {
  readonly access: string;
  readonly refresh: string;
  readonly scopes: readonly string[];
  /** Whether the access token is DPoP-bound (its type is then `DPoP`). */
  readonly bound: boolean;
}

/**
 * The statements issuing an access token and a refresh token (`refreshId`)
 * of `family` for `user`, written only `when` (an SQL condition over the
 * bound parameters `?10` claim and `?11` now, true once this request won its claim).
 */
async function issueStatements(
  db: D1Database,
  grant: {
    readonly user: string;
    readonly clientId: string;
    readonly scopes: readonly string[];
    readonly resource: string;
    readonly family: string;
    /** When the family ends: no refresh token of it lives past this. */
    readonly familyExpiresAt: number;
    readonly claim: string;
    readonly refreshId: string;
    readonly now: number;
    readonly requestId: string | undefined;
    readonly via: "authorization_code" | "refresh_token";
    /** The DPoP key the access token is bound to, and the refresh token's (its family's). */
    readonly accessJkt: string | null;
    readonly refreshJkt: string | null;
  },
  when: string,
): Promise<{ statements: D1PreparedStatement[]; issued: Issued }> {
  const access = generateToken("oat", secureRandomBytes);
  const refresh = generateToken("ort", secureRandomBytes);
  const accessId = newId("tok");
  const scopes = JSON.stringify(grant.scopes);
  // ?1 access id, ?2 its hash, ?3 user, ?4 scopes, ?5 its expiry, ?6 resource, ?7 client,
  // ?8 family, ?9 refresh hash, ?10 claim, ?11 now, ?12 refresh id, ?13 its expiry, ?14 request id,
  // ?15 the family's end, ?16 the access token's DPoP key, ?17 the refresh token's.
  const args = [
    accessId,
    await hashToken(access),
    grant.user,
    scopes,
    grant.now + ISSUE_POLICY.accessTokenTtlMs,
    grant.resource,
    grant.clientId,
    grant.family,
    await hashToken(refresh),
    grant.claim,
    grant.now,
    grant.refreshId,
    Math.min(grant.now + ISSUE_POLICY.refreshTokenTtlMs, grant.familyExpiresAt),
    grant.requestId ?? null,
    grant.familyExpiresAt,
    grant.accessJkt,
    grant.refreshJkt,
  ] as const;
  const statements = [
    db
      .prepare(
        `INSERT INTO tokens (id, token_hash, type, principal_id, scopes, expires_at, created_at,
           audience, client_id, family_id, dpop_jkt)
         SELECT ?1, ?2, 'oat', ?3, ?4, ?5, ?11, ?6, ?7, ?8, ?16 WHERE ${when}`,
      )
      // Exactly as many as the statement numbers (D1 checks the count).
      .bind(...args.slice(0, 16)),
    db
      .prepare(
        `INSERT INTO refresh_tokens (id, token_hash, family_id, user_id, client_id, scopes,
           resource, created_at, expires_at, family_expires_at, dpop_jkt)
         SELECT ?12, ?9, ?8, ?3, ?7, ?4, ?6, ?11, ?13, ?15, ?17 WHERE ${when}`,
      )
      .bind(...args),
    db
      .prepare(
        `INSERT INTO audit_log (at, actor_id, action, target_id, details, request_id)
         SELECT ?11, ?3, 'token.mint', ?1,
           json_object('type', 'oat', 'client_id', ?7, 'resource', ?6, 'grant', '${grant.via}'), ?14
         WHERE ${when}`,
      )
      .bind(...args.slice(0, 14)),
  ];
  return {
    statements,
    issued: { access, refresh, scopes: grant.scopes, bound: grant.accessJkt !== null },
  };
}

function tokenResponse(c: OAuthContext, issued: Issued, now: number): Response {
  return c.json(
    {
      access_token: issued.access,
      token_type: issued.bound ? "DPoP" : "Bearer",
      expires_in: Math.floor((now + ISSUE_POLICY.accessTokenTtlMs - clock()) / 1000),
      refresh_token: issued.refresh,
      scope: issued.scopes.join(" "),
    },
    200,
    NO_STORE,
  );
}

/**
 * The request's DPoP proof, checked for this token request and taken once:
 * its key's thumbprint; null without one; a refusal for a bad or replayed one.
 */
export async function tokenRequestProof(
  c: OAuthContext,
): Promise<{ ok: true; jkt: string | null } | { ok: false; response: Response }> {
  const proof = c.req.header("DPoP");
  if (proof === undefined) return { ok: true, jkt: null };
  const check = await checkProof(proof, { method: "POST", url: c.req.url, now: clock() });
  if (!check.ok) return { ok: false, response: refuse(c, "invalid_dpop_proof", check.reason) };
  if (!(await takeJti(c.env, check)))
    return { ok: false, response: refuse(c, "invalid_dpop_proof", "The proof was used before.") };
  return { ok: true, jkt: check.jkt };
}

async function userEnabled(env: Env, userId: string): Promise<boolean> {
  const row = await env.DIRECTORY.withSession("first-primary")
    .prepare(
      "SELECT 1 AS one FROM principals WHERE id = ? AND type = 'user' AND disabled_at IS NULL",
    )
    .bind(userId)
    .first();
  return row !== null;
}

/** Revokes a refresh family: its refresh tokens and the access tokens they issued. */
function revokeFamilyStatements(
  db: D1Database,
  family: string,
  now: number,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        "UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL",
      )
      .bind(now, family),
    db
      .prepare("UPDATE tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL")
      .bind(now, family),
  ];
}

/** `grant_type=authorization_code`. */
export async function codeGrant(c: OAuthContext, params: Map<string, string>): Promise<Response> {
  const code = params.get("code") ?? "";
  const verifier = params.get("code_verifier") ?? "";
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  if (!code || !clientId || !redirectUri || !VERIFIER.test(verifier))
    return refuse(
      c,
      "invalid_request",
      "code, client_id, redirect_uri and code_verifier are required.",
    );
  const db = c.env.DIRECTORY;
  const row = await db
    .withSession("first-primary")
    .prepare(
      `SELECT id, user_id, client_id, redirect_uri, code_challenge, scopes, resource,
         code_expires_at, used_at, family_id, dpop_jkt
       FROM oauth_requests WHERE code_hash = ?`,
    )
    .bind(await sha256Hex(code))
    .first<{
      id: string;
      user_id: string;
      client_id: string;
      redirect_uri: string;
      code_challenge: string;
      scopes: string;
      resource: string;
      code_expires_at: number;
      used_at: number | null;
      family_id: string | null;
      dpop_jkt: string | null;
    }>();
  const now = clock();
  if (!row) return refuse(c, "invalid_grant", "The code is not valid.");
  // A code redeemed again: what it issued is revoked (RFC 9700 §4.5.3.1 asks as much).
  if (row.used_at !== null) {
    if (row.family_id) await db.batch(revokeFamilyStatements(db, row.family_id, now));
    return refuse(c, "invalid_grant", "The code was already used.");
  }
  if (row.client_id !== clientId || row.redirect_uri !== redirectUri || row.code_expires_at <= now)
    return refuse(c, "invalid_grant", "The code is not valid for this client, or it expired.");
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  if (challenge !== row.code_challenge)
    return refuse(c, "invalid_grant", "The code verifier does not match the code challenge.");
  const resource = params.get("resource");
  if (resource !== undefined && resource !== row.resource)
    return refuse(c, "invalid_target", "resource differs from the one the code was issued for.");
  if (!(await userEnabled(c.env, row.user_id)))
    return refuse(c, "invalid_grant", "The user is disabled.");
  // A proof binds the tokens to its key; a code bound at authorization takes only that key's.
  const proof = await tokenRequestProof(c);
  if (!proof.ok) return proof.response;
  if (row.dpop_jkt !== null && proof.jkt !== row.dpop_jkt)
    return refuse(c, "invalid_dpop_proof", "The code is bound to another DPoP key.");

  const claim = crypto.randomUUID();
  const family = crypto.randomUUID();
  const { statements, issued } = await issueStatements(
    db,
    {
      user: row.user_id,
      clientId,
      scopes: JSON.parse(row.scopes) as string[],
      resource: row.resource,
      family,
      familyExpiresAt: now + ISSUE_POLICY.familyTtlMs,
      claim,
      refreshId: newId("tok"),
      now,
      requestId: c.get("requestId"),
      via: "authorization_code",
      accessJkt: proof.jkt,
      refreshJkt: proof.jkt,
    },
    `EXISTS (SELECT 1 FROM oauth_requests WHERE used_by = ?10)`,
  );
  const [claimed] = await db.batch([
    db
      .prepare(
        `UPDATE oauth_requests SET used_at = ?1, used_by = ?2, family_id = ?3
         WHERE id = ?4 AND used_at IS NULL AND code_expires_at > ?1`,
      )
      .bind(now, claim, family, row.id),
    ...statements,
  ]);
  if ((claimed?.meta.changes ?? 0) === 0) {
    // Another redemption won it at the same moment: one of the two holds a copy, so what the
    // winner got is revoked too (RFC 9700 §4.5.3.1).
    const winner = await db
      .withSession("first-primary")
      .prepare("SELECT family_id FROM oauth_requests WHERE id = ?")
      .bind(row.id)
      .first<{ family_id: string | null }>();
    if (winner?.family_id) await db.batch(revokeFamilyStatements(db, winner.family_id, now));
    return refuse(c, "invalid_grant", "The code was already used.");
  }
  return tokenResponse(c, issued, now);
}

/** `grant_type=refresh_token`. */
export async function refreshGrant(
  c: OAuthContext,
  params: Map<string, string>,
): Promise<Response> {
  const token = params.get("refresh_token") ?? "";
  const clientId = params.get("client_id") ?? "";
  if (!token || !clientId)
    return refuse(c, "invalid_request", "refresh_token and client_id are required.");
  const db = c.env.DIRECTORY;
  const row = await db
    .withSession("first-primary")
    .prepare(
      `SELECT id, family_id, user_id, client_id, scopes, resource, expires_at, used_at, revoked_at,
         family_expires_at, dpop_jkt
       FROM refresh_tokens WHERE token_hash = ?`,
    )
    .bind(await hashToken(token))
    .first<{
      id: string;
      family_id: string;
      user_id: string;
      client_id: string;
      scopes: string;
      resource: string;
      expires_at: number;
      used_at: number | null;
      revoked_at: number | null;
      family_expires_at: number;
      dpop_jkt: string | null;
    }>();
  const now = clock();
  if (!row || row.client_id !== clientId)
    return refuse(c, "invalid_grant", "The refresh token is not valid.");
  // Used before: someone holds a copy. The whole family goes (RFC 9700 §4.14.2).
  if (row.used_at !== null && row.revoked_at === null) {
    await db.batch([
      ...revokeFamilyStatements(db, row.family_id, now),
      db
        .prepare(
          `INSERT INTO audit_log (at, actor_id, action, target_id, details, request_id)
           VALUES (?, ?, 'token.refresh_reuse', ?, json_object('client_id', ?), ?)`,
        )
        .bind(now, row.user_id, row.family_id, clientId, c.get("requestId") ?? null),
    ]);
    return refuse(c, "invalid_grant", "The refresh token was already used; its family is revoked.");
  }
  if (row.revoked_at !== null || row.expires_at <= now)
    return refuse(c, "invalid_grant", "The refresh token is revoked or expired.");
  const resource = params.get("resource");
  if (resource !== undefined && resource !== row.resource)
    return refuse(c, "invalid_target", "resource differs from the one the token was issued for.");
  if (!resourceOf(originOf(c), row.resource))
    return refuse(c, "invalid_target", "The token's resource is not served here.");
  // Narrower scopes on request (RFC 6749 §6), never wider.
  const granted = JSON.parse(row.scopes) as string[];
  const asked = params.get("scope");
  const scopes = asked === undefined ? granted : [...new Set(asked.split(" ").filter(Boolean))];
  if (scopes.length === 0 || !scopes.every((s) => granted.includes(s)))
    return refuse(c, "invalid_scope", "The scopes exceed those first granted.");
  if (!(await userEnabled(c.env, row.user_id)))
    return refuse(c, "invalid_grant", "The user is disabled.");
  // A bound family is used only with a proof by its key (RFC 9449 §5); a proof binds the access token.
  const proof = await tokenRequestProof(c);
  if (!proof.ok) return proof.response;
  if (row.dpop_jkt !== null && proof.jkt !== row.dpop_jkt)
    return refuse(c, "invalid_dpop_proof", "The refresh token is bound to another DPoP key.");

  // The claim is the replacing token's id: only this request knows it.
  const refreshId = newId("tok");
  const { statements, issued } = await issueStatements(
    db,
    {
      user: row.user_id,
      clientId,
      scopes,
      resource: row.resource,
      family: row.family_id,
      familyExpiresAt: row.family_expires_at,
      claim: refreshId,
      refreshId,
      now,
      requestId: c.get("requestId"),
      via: "refresh_token",
      accessJkt: proof.jkt,
      refreshJkt: row.dpop_jkt,
    },
    `EXISTS (SELECT 1 FROM refresh_tokens WHERE replaced_by = ?10)`,
  );
  const [claimed] = await db.batch([
    db
      .prepare(
        `UPDATE refresh_tokens SET used_at = ?1, replaced_by = ?2
         WHERE id = ?3 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?1`,
      )
      .bind(now, refreshId, row.id),
    ...statements,
    // In use: kept past the pruning of registrations nobody uses (at most one write an hour).
    db
      .prepare(
        `UPDATE oauth_clients SET last_used_at = ?1 WHERE client_id = ?2
           AND (last_used_at IS NULL OR last_used_at < ?1 - 3600000)
           AND EXISTS (SELECT 1 FROM refresh_tokens WHERE replaced_by = ?3)`,
      )
      .bind(now, clientId, refreshId),
  ]);
  if ((claimed?.meta.changes ?? 0) === 0) {
    // Used at the same moment by another request: one of the two holds a copy, so the family
    // goes, as for any reuse (RFC 9700 §4.14.2).
    await db.batch(revokeFamilyStatements(db, row.family_id, now));
    return refuse(c, "invalid_grant", "The refresh token was already used; its family is revoked.");
  }
  return tokenResponse(c, issued, now);
}

/** `POST /oauth/revoke` (RFC 7009): a refresh token revokes its family; an access token, itself. */
export async function revokeToken(c: OAuthContext, params: Map<string, string>): Promise<Response> {
  const token = params.get("token") ?? "";
  const clientId = params.get("client_id") ?? "";
  const db = c.env.DIRECTORY;
  const hash = token ? await hashToken(token).catch(() => "") : "";
  const now = clock();
  if (hash && clientId) {
    const refresh = await db
      .withSession("first-primary")
      .prepare("SELECT family_id FROM refresh_tokens WHERE token_hash = ? AND client_id = ?")
      .bind(hash, clientId)
      .first<{ family_id: string }>();
    if (refresh) await db.batch(revokeFamilyStatements(db, refresh.family_id, now));
    else
      await db
        .prepare(
          `UPDATE tokens SET revoked_at = ? WHERE token_hash = ? AND client_id = ?
             AND revoked_at IS NULL`,
        )
        .bind(now, hash, clientId)
        .run();
  }
  // The same answer whether or not the token was known (RFC 7009 §2.2).
  return c.body(null, 200, NO_STORE);
}
