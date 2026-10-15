import { hashToken, parseToken } from "@fyrden/domain";
import type { Context } from "hono";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { readBoundedBody } from "../http/body.js";
import { NO_STORE } from "../http/cache.js";
import type { AuthVariables } from "../middleware/auth.js";
import { SESSION_COOKIE, type SessionUser, sessionUser, startSession } from "../oauth/session.js";
import { clock, tokenStore } from "../services.js";
import { signInPage } from "./sign-in-page.js";
import {
  base64urlEncode,
  type CoseAlg,
  verifyAssertion,
  verifyRegistration,
  WebAuthnError,
} from "./webauthn.js";

/**
 * Human sign-in: a session (`oauth/session.ts`) started by a passkey, or by
 * a personal access token with the user's full rights (how the first
 * passkey is added, and a way in for a user without one). Every change
 * comes from this origin's own pages (`Origin`), so another site cannot
 * sign a browser in or out, or add a passkey to it.
 */

type Ctx = Context<{ Bindings: Env; Variables: AuthVariables }>;

/** Proposed. */
export const LOGIN_POLICY = {
  challengeTtlMs: 5 * 60 * 1000,
  maxPasskeysPerUser: 20,
  maxBodyBytes: 16 * 1024,
};

const refuse = (
  c: Ctx,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 429,
  code: string,
  detail: string,
) => c.json({ code, detail }, status, NO_STORE);

const originOf = (c: Ctx) => new URL(c.req.url).origin;
const rpIdOf = (c: Ctx) => new URL(c.req.url).hostname;

/** Only this origin's pages change sign-in state (a cross-site form or fetch cannot). */
const sameOrigin = (c: Ctx) => c.req.header("Origin") === originOf(c);

async function jsonBody(c: Ctx): Promise<Record<string, unknown> | "too_large" | undefined> {
  if (!(c.req.header("Content-Type") ?? "").startsWith("application/json")) return undefined;
  const body = await readBoundedBody(c.req.raw, LOGIN_POLICY.maxBodyBytes);
  if (body === undefined) return "too_large";
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(body));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Sets the session cookie: this origin only, HTTPS, no script access, sent on top-level navigation. */
function setSession(c: Ctx, cookie: string, expiresAt: number): void {
  setCookie(c, SESSION_COOKIE, cookie, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    expires: new Date(expiresAt),
  });
}

async function rateLimited(c: Ctx): Promise<boolean> {
  const client = c.req.header("CF-Connecting-IP") ?? "unknown";
  return !(await c.env.RATE_LIMIT_AUTH.limit({ key: client })).success;
}

/** A single-use challenge for `purpose`, kept a few minutes. */
async function issueChallenge(
  env: Env,
  purpose: "register" | "sign_in",
  userId: string | null,
): Promise<{ id: string; challenge: string }> {
  const id = crypto.randomUUID();
  const challenge = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  await env.DIRECTORY.prepare(
    `INSERT INTO webauthn_challenges (id, challenge, purpose, user_id, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, challenge, purpose, userId, clock() + LOGIN_POLICY.challengeTtlMs)
    .run();
  return { id, challenge };
}

/** Takes challenge `id` for `purpose` (and `userId`), once: its value, or undefined. */
async function takeChallenge(
  env: Env,
  id: string,
  purpose: "register" | "sign_in",
  userId: string | null,
): Promise<string | undefined> {
  const now = clock();
  const row = await env.DIRECTORY.prepare(
    `UPDATE webauthn_challenges SET used_at = ?1
     WHERE id = ?2 AND purpose = ?3 AND user_id IS ?4 AND used_at IS NULL AND expires_at > ?1
     RETURNING challenge`,
  )
    .bind(now, id, purpose, userId)
    .first<{ challenge: string }>();
  return row?.challenge;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

export const authRouter = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

authRouter.get("/sign-in", signInPage);

/** `GET /auth/session`: the signed-in user, or 401. */
authRouter.get("/session", async (c) => {
  const user = await sessionUser(c);
  if (!user) return refuse(c, 401, "unauthenticated", "Not signed in.");
  return c.json({ user: { id: user.userId, handle: user.handle } }, 200, NO_STORE);
});

/** `POST /auth/token`: signs in with a personal access token with the user's full rights. */
authRouter.post("/token", async (c) => {
  if (!sameOrigin(c)) return refuse(c, 403, "cross_origin", "Sign in from Fyrden's own pages.");
  if (await rateLimited(c))
    return refuse(c, 429, "rate_limited", "Too many attempts; wait a minute.");
  const body = await jsonBody(c);
  if (body === "too_large") return refuse(c, 413, "body_too_large", "The body is too large.");
  const token = str(body?.token);
  const verified = token ? await tokenStore(c.env).verify(token, "write") : undefined;
  const record = verified?.ok ? verified.record : undefined;
  // A session acts with the user's full rights: only a token with them starts one.
  if (
    record?.type !== "pat" ||
    record.principalType !== "user" ||
    record.act.length > 0 ||
    record.scopes.length > 0 ||
    record.repoIds !== null
  )
    return refuse(
      c,
      401,
      "invalid_token",
      "Use a valid personal access token of yours with no scopes or repository limits.",
    );
  const session = await startSession(c.env, record.principalId, {
    via: "token",
    ...(c.get("requestId") !== undefined && { requestId: c.get("requestId") }),
  });
  setSession(c, session.cookie, session.expiresAt);
  return c.json(
    { user: { id: record.principalId, handle: record.principalHandle } },
    200,
    NO_STORE,
  );
});

/** `POST /auth/logout`: ends the session. */
authRouter.post("/logout", async (c) => {
  if (!sameOrigin(c)) return refuse(c, 403, "cross_origin", "Sign out from Fyrden's own pages.");
  const cookie = getCookie(c, SESSION_COOKIE);
  if (cookie && parseToken(cookie).ok)
    await c.env.DIRECTORY.prepare(
      "UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
    )
      .bind(clock(), await hashToken(cookie))
      .run();
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
  return c.body(null, 204, NO_STORE);
});

async function signedIn(c: Ctx): Promise<SessionUser | Response> {
  if (!sameOrigin(c)) return refuse(c, 403, "cross_origin", "Use Fyrden's own pages.");
  return (await sessionUser(c)) ?? refuse(c, 401, "unauthenticated", "Sign in first.");
}

/** `POST /auth/passkeys/registration-options`: what the browser needs to create a passkey. */
authRouter.post("/passkeys/registration-options", async (c) => {
  const user = await signedIn(c);
  if (user instanceof Response) return user;
  const { results } = await c.env.DIRECTORY.prepare("SELECT id FROM passkeys WHERE user_id = ?")
    .bind(user.userId)
    .all<{ id: string }>();
  if (results.length >= LOGIN_POLICY.maxPasskeysPerUser)
    return refuse(
      c,
      409,
      "too_many_passkeys",
      `A user has ${LOGIN_POLICY.maxPasskeysPerUser} passkeys at most.`,
    );
  const { id, challenge } = await issueChallenge(c.env, "register", user.userId);
  return c.json(
    {
      challenge_id: id,
      publicKey: {
        challenge,
        rp: { id: rpIdOf(c), name: "Fyrden" },
        user: {
          id: base64urlEncode(new TextEncoder().encode(user.userId)),
          name: user.handle,
          displayName: user.handle,
        },
        pubKeyCredParams: [
          { type: "public-key", alg: -8 },
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        attestation: "none",
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        excludeCredentials: results.map((r) => ({ type: "public-key", id: r.id })),
        timeout: LOGIN_POLICY.challengeTtlMs,
      },
    },
    200,
    NO_STORE,
  );
});

/** `POST /auth/passkeys/registration`: the created passkey, checked and kept. */
authRouter.post("/passkeys/registration", async (c) => {
  const user = await signedIn(c);
  if (user instanceof Response) return user;
  const body = await jsonBody(c);
  if (body === "too_large") return refuse(c, 413, "body_too_large", "The body is too large.");
  const credential = (body?.credential ?? {}) as Record<string, unknown>;
  const response = (credential.response ?? {}) as Record<string, unknown>;
  const challenge = await takeChallenge(c.env, str(body?.challenge_id), "register", user.userId);
  if (!challenge)
    return refuse(c, 400, "challenge_expired", "Start again: the challenge expired or was used.");
  let verified: Awaited<ReturnType<typeof verifyRegistration>>;
  try {
    verified = await verifyRegistration(
      {
        clientDataJSON: str(response.clientDataJSON),
        attestationObject: str(response.attestationObject),
        rawId: str(credential.rawId),
      },
      { challenge, origin: originOf(c), rpId: rpIdOf(c) },
    );
  } catch (error) {
    if (error instanceof WebAuthnError) return refuse(c, 400, "invalid_passkey", error.message);
    throw error;
  }
  const name = str(body?.name).slice(0, 100) || null;
  const now = clock();
  let added: D1Result | undefined;
  try {
    [added] = await c.env.DIRECTORY.batch([
      // Only while the user has fewer than its share (checked in the insert).
      c.env.DIRECTORY.prepare(
        `INSERT INTO passkeys (id, user_id, public_key, alg, sign_count, name, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
         WHERE (SELECT count(*) FROM passkeys WHERE user_id = ?2) < ?8`,
      ).bind(
        verified.id,
        user.userId,
        JSON.stringify(verified.jwk),
        verified.alg,
        verified.signCount,
        name,
        now,
        LOGIN_POLICY.maxPasskeysPerUser,
      ),
      c.env.DIRECTORY.prepare(
        `INSERT INTO audit_log (at, actor_id, action, target_id, details, request_id)
         SELECT ?1, ?2, 'passkey.add', ?3, json_object('name', ?4), ?5
         WHERE EXISTS (SELECT 1 FROM passkeys WHERE id = ?3 AND created_at = ?1)`,
      ).bind(now, user.userId, verified.id, name, c.get("requestId") ?? null),
    ]);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message))
      return refuse(c, 409, "passkey_exists", "That passkey is added already.");
    throw error;
  }
  if ((added?.meta.changes ?? 0) === 0)
    return refuse(
      c,
      409,
      "too_many_passkeys",
      `A user has ${LOGIN_POLICY.maxPasskeysPerUser} passkeys at most.`,
    );
  return c.json({ id: verified.id, name, created_at: now }, 201, NO_STORE);
});

/** `POST /auth/passkeys/sign-in-options`: a challenge for a discoverable passkey. */
authRouter.post("/passkeys/sign-in-options", async (c) => {
  if (!sameOrigin(c)) return refuse(c, 403, "cross_origin", "Sign in from Fyrden's own pages.");
  if (await rateLimited(c))
    return refuse(c, 429, "rate_limited", "Too many attempts; wait a minute.");
  const { id, challenge } = await issueChallenge(c.env, "sign_in", null);
  return c.json(
    {
      challenge_id: id,
      publicKey: {
        challenge,
        rpId: rpIdOf(c),
        userVerification: "required",
        timeout: LOGIN_POLICY.challengeTtlMs,
      },
    },
    200,
    NO_STORE,
  );
});

/** `POST /auth/passkeys/sign-in`: the passkey's assertion, checked; a session. */
authRouter.post("/passkeys/sign-in", async (c) => {
  if (!sameOrigin(c)) return refuse(c, 403, "cross_origin", "Sign in from Fyrden's own pages.");
  if (await rateLimited(c))
    return refuse(c, 429, "rate_limited", "Too many attempts; wait a minute.");
  const body = await jsonBody(c);
  if (body === "too_large") return refuse(c, 413, "body_too_large", "The body is too large.");
  const credential = (body?.credential ?? {}) as Record<string, unknown>;
  const response = (credential.response ?? {}) as Record<string, unknown>;
  const challenge = await takeChallenge(c.env, str(body?.challenge_id), "sign_in", null);
  const fail = () => refuse(c, 401, "invalid_passkey", "The passkey could not be verified.");
  if (!challenge)
    return refuse(c, 400, "challenge_expired", "Start again: the challenge expired or was used.");
  const stored = await c.env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT k.id, k.user_id, k.public_key, k.alg, k.sign_count FROM passkeys k
       JOIN principals p ON p.id = k.user_id
       WHERE k.id = ? AND p.type = 'user' AND p.disabled_at IS NULL`,
    )
    .bind(str(credential.rawId))
    .first<{ id: string; user_id: string; public_key: string; alg: CoseAlg; sign_count: number }>();
  if (!stored) return fail();
  // A discoverable passkey's assertion names its user: it must be the passkey's own.
  if (str(response.userHandle) !== base64urlEncode(new TextEncoder().encode(stored.user_id)))
    return fail();
  let signCount: number;
  try {
    ({ signCount } = await verifyAssertion(
      {
        clientDataJSON: str(response.clientDataJSON),
        authenticatorData: str(response.authenticatorData),
        signature: str(response.signature),
      },
      {
        jwk: JSON.parse(stored.public_key) as JsonWebKey,
        alg: stored.alg,
        signCount: stored.sign_count,
      },
      { challenge, origin: originOf(c), rpId: rpIdOf(c) },
    ));
  } catch (error) {
    if (error instanceof WebAuthnError) return fail();
    throw error;
  }
  // The counter moves only forward: two sign-ins with the same count cannot both pass.
  const moved = await c.env.DIRECTORY.prepare(
    `UPDATE passkeys SET sign_count = ?1, last_used_at = ?2
     WHERE id = ?3 AND (sign_count < ?1 OR (sign_count = 0 AND ?1 = 0))`,
  )
    .bind(signCount, clock(), stored.id)
    .run();
  if ((moved.meta.changes ?? 0) === 0) return fail();
  const session = await startSession(c.env, stored.user_id, {
    via: "passkey",
    ...(c.get("requestId") !== undefined && { requestId: c.get("requestId") }),
  });
  setSession(c, session.cookie, session.expiresAt);
  return c.json({ user: { id: stored.user_id } }, 200, NO_STORE);
});

/** `GET /auth/passkeys`: the signed-in user's passkeys. */
authRouter.get("/passkeys", async (c) => {
  const user = await sessionUser(c);
  if (!user) return refuse(c, 401, "unauthenticated", "Sign in first.");
  const { results } = await c.env.DIRECTORY.prepare(
    "SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at",
  )
    .bind(user.userId)
    .all();
  return c.json({ passkeys: results }, 200, NO_STORE);
});

/** `DELETE /auth/passkeys/:id`: removes one of the signed-in user's passkeys. */
authRouter.delete("/passkeys/:id", async (c) => {
  const user = await signedIn(c);
  if (user instanceof Response) return user;
  const id = c.req.param("id");
  const now = clock();
  // The audit row and the removal together: written only for a passkey of this user.
  const [, removed] = await c.env.DIRECTORY.batch([
    c.env.DIRECTORY.prepare(
      `INSERT INTO audit_log (at, actor_id, action, target_id, details, request_id)
       SELECT ?1, ?2, 'passkey.remove', ?3, NULL, ?4
       WHERE EXISTS (SELECT 1 FROM passkeys WHERE id = ?3 AND user_id = ?2)`,
    ).bind(now, user.userId, id, c.get("requestId") ?? null),
    c.env.DIRECTORY.prepare("DELETE FROM passkeys WHERE id = ? AND user_id = ?").bind(
      id,
      user.userId,
    ),
  ]);
  if ((removed?.meta.changes ?? 0) === 0)
    return refuse(c, 404, "passkey_not_found", "No such passkey of yours.");
  return c.body(null, 204, NO_STORE);
});
