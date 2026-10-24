import { generateToken, hashToken, parseToken, secureRandomBytes } from "@fyrden/domain";
import { getCookie } from "hono/cookie";
import { clock, newId } from "../services.js";
import type { OAuthContext } from "./params.js";

/**
 * Human sessions: a cookie (`fyrden_ses_…`, only its SHA-256 stored) that
 * names a signed-in user to the authorization server's consent step and,
 * later, the web UI. How a user signs in (and so gets one) is the login's
 * business; this is what everything else reads.
 */

/** `__Host-`: set by this origin only, over HTTPS, for every path. */
export const SESSION_COOKIE = "__Host-fyrden_session";

/** Proposed. */
export const SESSION_POLICY = {
  ttlMs: 30 * 24 * 60 * 60 * 1000,
};

export interface SessionUser {
  readonly sessionId: string;
  readonly userId: string;
  readonly handle: string;
  readonly isInstanceAdmin: boolean;
  /** The user's lifecycle generation (see `TokenRecord.lifecycleGen`). */
  readonly lifecycleGen: number;
  readonly expiresAt: number;
}

/** The signed-in user the request's session cookie names, if it is live and the user enabled. */
export async function sessionUser(c: OAuthContext): Promise<SessionUser | undefined> {
  const cookie = getCookie(c, SESSION_COOKIE);
  if (!cookie || !parseToken(cookie).ok || !cookie.startsWith("fyrden_ses_")) return undefined;
  const row = await c.env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT s.id, s.user_id, p.handle, p.is_instance_admin, p.lifecycle_gen, s.expires_at
       FROM sessions s JOIN principals p ON p.id = s.user_id
       WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
         AND p.type = 'user' AND p.disabled_at IS NULL`,
    )
    .bind(await hashToken(cookie), clock())
    .first<{
      id: string;
      user_id: string;
      handle: string;
      is_instance_admin: number;
      lifecycle_gen: number;
      expires_at: number;
    }>();
  return row
    ? {
        sessionId: row.id,
        userId: row.user_id,
        handle: row.handle,
        isInstanceAdmin: row.is_instance_admin === 1,
        lifecycleGen: row.lifecycle_gen,
        expiresAt: row.expires_at,
      }
    : undefined;
}

/**
 * Starts a session for `userId`, audited, if the user is still active at
 * `lifecycleGen` (the generation it was authenticated at: a suspension
 * since, even one lifted, refuses it); returns the cookie's value, shown
 * once, or undefined when refused.
 */
export async function startSession(
  env: Env,
  userId: string,
  lifecycleGen: number,
  audit: { readonly requestId?: string; readonly via: string },
): Promise<{ cookie: string; sessionId: string; expiresAt: number } | undefined> {
  const cookie = generateToken("ses", secureRandomBytes);
  const sessionId = newId("ses");
  const now = clock();
  const expiresAt = now + SESSION_POLICY.ttlMs;
  const db = env.DIRECTORY;
  const [started] = await db.batch([
    db
      .prepare(
        `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at)
         SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM principals
           WHERE id = ?3 AND type = 'user' AND lifecycle = 'active' AND lifecycle_gen = ?6)`,
      )
      .bind(sessionId, await hashToken(cookie), userId, now, expiresAt, lifecycleGen),
    db
      .prepare(
        `INSERT INTO audit_log (at, actor_id, action, target_id, details, request_id)
         SELECT ?1, ?2, 'session.start', ?3, json_object('via', ?4), ?5
         WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ?3)`,
      )
      .bind(now, userId, sessionId, audit.via, audit.requestId ?? null),
  ]);
  if ((started?.meta.changes ?? 0) === 0) return undefined;
  return { cookie, sessionId, expiresAt };
}
