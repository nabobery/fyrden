import { generateToken, hashToken, isValidHandle, secureRandomBytes } from "@fyrden/domain";
import { Hono } from "hono";
import { problem } from "../../http/problem.js";
import type { ObsVariables } from "../../middleware/obs.js";
import { clock, newId } from "../../services.js";

/** The first admin token lasts 30 days; mint a narrower one after setup. */
export const BOOTSTRAP_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function sameSecret(a: string, b: string): Promise<boolean> {
  // Compare digests so the comparison takes the same time whatever the input.
  const [x, y] = await Promise.all([hashToken(a), hashToken(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/**
 * First-run setup: creates the instance admin and returns its token once.
 * Requires the deployment's BOOTSTRAP_SECRET, so whoever reaches a fresh
 * deploy first cannot claim it, and works only while no admin exists.
 */
export const bootstrap = new Hono<{ Bindings: Env; Variables: ObsVariables }>().post(
  "/",
  async (c) => {
    const provided = c.req.header("X-Fyrden-Bootstrap-Secret") ?? "";
    if (!c.env.BOOTSTRAP_SECRET || !(await sameSecret(provided, c.env.BOOTSTRAP_SECRET))) {
      return problem(c, 403, "bootstrap_forbidden", "The bootstrap secret is missing or wrong.");
    }
    const body: unknown = await c.req.json<unknown>().catch(() => undefined);
    const handle =
      body !== null &&
      typeof body === "object" &&
      "handle" in body &&
      typeof body.handle === "string"
        ? body.handle
        : "";
    if (!isValidHandle(handle))
      return problem(c, 422, "invalid_handle", "handle must be a valid user name.");

    const db = c.env.DIRECTORY;
    const now = clock();
    const userId = newId("usr");
    const tokenId = newId("tok");
    const token = generateToken("pat", secureRandomBytes);
    // Every statement is conditional on the admin row having been inserted, so
    // two concurrent bootstraps cannot both succeed and nothing is half-written.
    const [created] = await db.batch([
      db
        .prepare(
          `INSERT INTO principals (id, type, handle, is_instance_admin, created_at)
         SELECT ?, 'user', ?, 1, ? WHERE NOT EXISTS (SELECT 1 FROM principals WHERE is_instance_admin = 1)`,
        )
        .bind(userId, handle, now),
      db
        .prepare(
          `INSERT INTO tokens (id, token_hash, type, principal_id, scopes, expires_at, created_at)
         SELECT ?, ?, 'pat', ?, '[]', ?, ? WHERE EXISTS (SELECT 1 FROM principals WHERE id = ?)`,
        )
        .bind(tokenId, await hashToken(token), userId, now + BOOTSTRAP_TOKEN_TTL_MS, now, userId),
      db
        .prepare(
          `INSERT INTO audit_log (at, actor_id, action, target_id, details, request_id)
         SELECT ?, ?, 'instance.bootstrap', ?, ?, ? WHERE EXISTS (SELECT 1 FROM principals WHERE id = ?)`,
        )
        .bind(now, userId, userId, JSON.stringify({ tokenId }), c.get("requestId"), userId),
    ]);
    if ((created?.meta.changes ?? 0) === 0) {
      return problem(c, 409, "already_bootstrapped", "An instance admin already exists.");
    }
    c.get("log").info("instance bootstrapped", { principalId: userId, tokenId });
    return c.json(
      {
        user: { id: userId, handle },
        token,
        token_id: tokenId,
        expires_at: now + BOOTSTRAP_TOKEN_TTL_MS,
      },
      201,
    );
  },
);
