import type { Input, suspendUser, unsuspendUser } from "@fyrden/api-contract";
import { type OpContext, OperationError } from "../ops/execute.js";
import { clock } from "../services.js";

/*
 * Where a user stands: active, or suspended by an instance administrator
 * (deletion comes later). A transition is one D1 batch: the principal's
 * change, conditioned on the state and generation it was read at, which
 * writes a claim of its own (`lifecycle_claim`), and everything that goes
 * with it, each statement conditioned on that claim, so a request that
 * lost the race changes nothing. Every transition bumps `lifecycle_gen`
 * and is recorded in `principal_lifecycle`.
 *
 * A suspension revokes the user's sessions and OAuth tokens (refresh and
 * access) and ends their unanswered authorization requests and unused
 * codes, so the user signs in again after it. Their personal access
 * tokens, git tokens and delegations, and their agents', are kept:
 * authentication refuses them while the user is disabled, and they work
 * again after an unsuspension, as GitHub Enterprise's do. Checks that
 * begin after the suspension commits refuse; work already authorized may
 * finish (a push holds its decision for up to a minute).
 */

type Lifecycle = "active" | "suspended" | "deleting" | "deleted";

interface Target {
  readonly id: string;
  readonly type: string;
  readonly lifecycle: Lifecycle;
  readonly gen: number;
}

/** The user a handle names now, whatever its lifecycle (a deleted one's handle is gone). */
async function target(ctx: OpContext, username: string): Promise<Target> {
  ctx.metrics.count("d1.query", { db: "directory", op: "lifecycle_target" });
  const row = await ctx.env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT id, type, lifecycle, lifecycle_gen AS gen FROM principals
       WHERE handle = ? COLLATE NOCASE`,
    )
    .bind(username)
    .first<Target>();
  if (row?.type !== "user")
    throw new OperationError(404, "user_not_found", `No user has the handle ${username}.`);
  return row;
}

/** The `admin.users.suspend` operation. */
export async function suspendUserOperation(
  ctx: OpContext,
  input: Input<typeof suspendUser>,
): Promise<null> {
  const user = await target(ctx, input.username);
  if (user.id === ctx.auth.principalId)
    throw new OperationError(422, "cannot_suspend_self", "You cannot suspend yourself.");
  if (user.lifecycle === "suspended") return null;
  if (user.lifecycle !== "active")
    throw new OperationError(409, "user_deleted", `The user ${input.username} is being deleted.`);
  const db = ctx.env.DIRECTORY;
  const now = clock();
  const claim = crypto.randomUUID();
  // ?1 the user, ?2 this request's claim: each statement after the first runs only if the first
  // made the change.
  const made = `EXISTS (SELECT 1 FROM principals WHERE id = ?1 AND lifecycle_claim = ?2)`;
  ctx.metrics.count("d1.query", { db: "directory", op: "lifecycle_suspend" }, 7);
  const [changed] = await db.batch([
    db
      .prepare(
        // Never the last active instance administrator: decided in the statement, so two
        // administrators suspending each other leave one.
        `UPDATE principals SET lifecycle = 'suspended', lifecycle_gen = ?3, lifecycle_claim = ?2,
           disabled_at = ?4, suspended_at = ?4, suspended_by = ?5, suspended_reason = ?6
         WHERE id = ?1 AND lifecycle = 'active' AND lifecycle_gen = ?7
           AND (is_instance_admin = 0 OR EXISTS (SELECT 1 FROM principals o
             WHERE o.is_instance_admin = 1 AND o.lifecycle = 'active' AND o.id <> ?1))`,
      )
      .bind(
        user.id,
        claim,
        user.gen + 1,
        now,
        ctx.auth.principalId,
        input.reason ?? null,
        user.gen,
      ),
    db
      .prepare(
        `UPDATE sessions SET revoked_at = ?3 WHERE user_id = ?1 AND revoked_at IS NULL AND ${made}`,
      )
      .bind(user.id, claim, now),
    db
      .prepare(
        `UPDATE refresh_tokens SET revoked_at = ?3 WHERE user_id = ?1 AND revoked_at IS NULL
           AND ${made}`,
      )
      .bind(user.id, claim, now),
    // The OAuth access tokens (each of a refresh family).
    db
      .prepare(
        `UPDATE tokens SET revoked_at = ?3 WHERE principal_id = ?1 AND type = 'oat'
           AND revoked_at IS NULL AND ${made}`,
      )
      .bind(user.id, claim, now),
    // Unanswered requests and unused codes: neither can be answered or redeemed any more, even by
    // a consent or a redemption under way (they compare with a time taken before this).
    db
      .prepare(
        `UPDATE oauth_requests SET expires_at = 0,
           code_expires_at = CASE WHEN code_expires_at IS NULL THEN NULL ELSE 0 END
         WHERE user_id = ?1 AND used_at IS NULL AND ${made}`,
      )
      .bind(user.id, claim),
    journal(db, user.id, claim, user.gen + 1, "active", "suspended", now, ctx),
    audit(db, "user.suspend", user.id, claim, now, ctx, input.reason),
  ]);
  if ((changed?.meta.changes ?? 0) > 0) return null;
  return refused(ctx, user, "suspend");
}

/** The `admin.users.unsuspend` operation. */
export async function unsuspendUserOperation(
  ctx: OpContext,
  input: Input<typeof unsuspendUser>,
): Promise<null> {
  const user = await target(ctx, input.username);
  if (user.lifecycle === "active") return null;
  if (user.lifecycle !== "suspended")
    throw new OperationError(409, "user_deleted", `The user ${input.username} is being deleted.`);
  const db = ctx.env.DIRECTORY;
  const now = clock();
  const claim = crypto.randomUUID();
  ctx.metrics.count("d1.query", { db: "directory", op: "lifecycle_unsuspend" }, 3);
  const [changed] = await db.batch([
    db
      .prepare(
        `UPDATE principals SET lifecycle = 'active', lifecycle_gen = ?3, lifecycle_claim = ?2,
           disabled_at = NULL, suspended_at = NULL, suspended_by = NULL, suspended_reason = NULL
         WHERE id = ?1 AND lifecycle = 'suspended' AND lifecycle_gen = ?4`,
      )
      .bind(user.id, claim, user.gen + 1, user.gen),
    journal(db, user.id, claim, user.gen + 1, "suspended", "active", now, ctx),
    audit(db, "user.unsuspend", user.id, claim, now, ctx, input.reason),
  ]);
  if ((changed?.meta.changes ?? 0) > 0) return null;
  return refused(ctx, user, "unsuspend");
}

/**
 * Why a transition read at `user` changed nothing: the user moved on
 * meanwhile (another administrator's change: already where this one would
 * take it, or the request may be sent again), or, for a suspension, it
 * would leave no active administrator.
 */
async function refused(ctx: OpContext, user: Target, verb: "suspend" | "unsuspend"): Promise<null> {
  ctx.metrics.count("d1.query", { db: "directory", op: "lifecycle_target" });
  const now = await ctx.env.DIRECTORY.withSession("first-primary")
    .prepare("SELECT lifecycle, lifecycle_gen AS gen FROM principals WHERE id = ?")
    .bind(user.id)
    .first<{ lifecycle: Lifecycle; gen: number }>();
  if (verb === "suspend" && now?.lifecycle === "suspended") return null;
  if (verb === "unsuspend" && now?.lifecycle === "active") return null;
  if (verb === "suspend" && now?.lifecycle === "active" && now.gen === user.gen)
    throw new OperationError(
      409,
      "last_admin",
      "This is the last active instance administrator: make another one first.",
    );
  throw new OperationError(409, "user_changed", "The user changed meanwhile; try again.");
}

/** The transition's record, written only when this request (`claim`) made it. */
function journal(
  db: D1Database,
  principalId: string,
  claim: string,
  gen: number,
  from: Lifecycle,
  to: Lifecycle,
  now: number,
  ctx: OpContext,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO principal_lifecycle (principal_id, gen, from_state, to_state, at, actor_id,
         request_id)
       SELECT ?1, ?3, ?4, ?5, ?6, ?7, ?8
       WHERE EXISTS (SELECT 1 FROM principals WHERE id = ?1 AND lifecycle_claim = ?2)`,
    )
    .bind(principalId, claim, gen, from, to, now, ctx.auth.principalId, ctx.requestId ?? null);
}

/** The transition's audit row, written only when this request (`claim`) made it. */
function audit(
  db: D1Database,
  action: "user.suspend" | "user.unsuspend",
  principalId: string,
  claim: string,
  now: number,
  ctx: OpContext,
  reason: string | undefined,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_log (at, actor_id, act_chain, action, target_id, details, request_id)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
       WHERE EXISTS (SELECT 1 FROM principals WHERE id = ?5 AND lifecycle_claim = ?8)`,
    )
    .bind(
      now,
      ctx.auth.principalId,
      ctx.auth.act.length > 0 ? JSON.stringify(ctx.auth.act) : null,
      action,
      principalId,
      reason === undefined ? null : JSON.stringify({ reason }),
      ctx.requestId ?? null,
      claim,
    );
}
