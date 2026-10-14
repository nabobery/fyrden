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
}

/** The signed-in user the request's session cookie names, if it is live and the user enabled. */
export async function sessionUser(c: OAuthContext): Promise<SessionUser | undefined> {
  const cookie = getCookie(c, SESSION_COOKIE);
  if (!cookie || !parseToken(cookie).ok || !cookie.startsWith("fyrden_ses_")) return undefined;
  const row = await c.env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT s.id, s.user_id, p.handle FROM sessions s JOIN principals p ON p.id = s.user_id
       WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
         AND p.type = 'user' AND p.disabled_at IS NULL`,
    )
    .bind(await hashToken(cookie), clock())
    .first<{ id: string; user_id: string; handle: string }>();
  return row ? { sessionId: row.id, userId: row.user_id, handle: row.handle } : undefined;
}

/** Starts a session for `userId`, audited; returns the cookie's value, shown once. */
export async function startSession(
  env: Env,
  userId: string,
  audit: { readonly requestId?: string; readonly via: string },
): Promise<{ cookie: string; sessionId: string; expiresAt: number }> {
  const cookie = generateToken("ses", secureRandomBytes);
  const sessionId = newId("ses");
  const now = clock();
  const expiresAt = now + SESSION_POLICY.ttlMs;
  const db = env.DIRECTORY;
  await db.batch([
    db
      .prepare(
        "INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(sessionId, await hashToken(cookie), userId, now, expiresAt),
    db
      .prepare(
        `INSERT INTO audit_log (at, actor_id, action, target_id, details, request_id)
         VALUES (?, ?, 'session.start', ?, json_object('via', ?), ?)`,
      )
      .bind(now, userId, sessionId, audit.via, audit.requestId ?? null),
  ]);
  return { cookie, sessionId, expiresAt };
}
