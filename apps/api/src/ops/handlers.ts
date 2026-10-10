import { auditStatement } from "@fyrden/adapters-cloudflare/auth";
import { clock, newId, tokenStore } from "../services.js";
import { type Handlers, OperationError } from "./execute.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// D1 reports a unique-index violation in the error message.
const UNIQUE_VIOLATION = /UNIQUE constraint failed/i;

export const handlers: Handlers = {
  "meta.whoami": async ({ auth }) => ({
    id: auth.principalId,
    type: auth.principalType,
    handle: auth.principalHandle,
    is_instance_admin: auth.isInstanceAdmin,
    token: { id: auth.id, type: auth.type, scopes: auth.scopes, expires_at: auth.expiresAt },
  }),

  "admin.users.create": async ({ env, auth, requestId, metrics }, { handle }) => {
    const db = env.DIRECTORY;
    const id = newId("usr");
    const now = clock();
    metrics.count("d1.query", { db: "directory", op: "user_create" }, 2);
    try {
      // The user and its audit row are written together or not at all.
      await db.batch([
        db
          .prepare("INSERT INTO principals (id, type, handle, created_at) VALUES (?, 'user', ?, ?)")
          .bind(id, handle, now),
        auditStatement(db, now, { actorId: auth.principalId, requestId }, "user.create", id, {
          handle,
        }),
      ]);
    } catch (error) {
      // Handles are unique ignoring case, across users, orgs and agents.
      if (error instanceof Error && UNIQUE_VIOLATION.test(error.message))
        throw new OperationError(409, "handle_taken", `The handle ${handle} is already taken.`);
      throw error;
    }
    return { id, handle, type: "user" as const, created_at: now };
  },

  "admin.tokens.create": async (ctx, input) => {
    const { env, auth, requestId, metrics } = ctx;
    // The primary: a user created a moment ago must be found.
    metrics.count("d1.query", { db: "directory", op: "user_lookup" });
    const user = await env.DIRECTORY.withSession("first-primary")
      .prepare("SELECT type, disabled_at FROM principals WHERE id = ?")
      .bind(input.user_id)
      .first<{ type: string; disabled_at: number | null }>();
    if (user?.type !== "user")
      throw new OperationError(404, "user_not_found", `No user has the id ${input.user_id}.`);
    if (user.disabled_at !== null)
      throw new OperationError(409, "user_disabled", "The user is disabled.");

    const store = tokenStore(env, { defer: (p) => ctx.waitUntil(p), metrics });
    const minted = await store.mint({
      principalId: input.user_id,
      type: input.type,
      scopes: input.scopes,
      ttlMs: input.expires_in_days * DAY_MS,
      audit: { actorId: auth.principalId, requestId },
    });
    return {
      id: minted.id,
      token: minted.token,
      type: input.type,
      user_id: input.user_id,
      scopes: input.scopes,
      expires_at: minted.expiresAt,
    };
  },
};
