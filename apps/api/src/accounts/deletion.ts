import { createLogger } from "@fyrden/adapters-cloudflare/obs";
import type { deleteUser, Input, Output } from "@fyrden/api-contract";
import { type OpContext, OperationError } from "../ops/execute.js";
import { clock } from "../services.js";
import { HANDLE_HOLD_MS } from "./handles.js";
import type { Lifecycle } from "./lifecycle.js";

/*
 * Deleting a user, as GitHub Enterprise does: the user's repositories are
 * deleted with them, and everything else they had (credentials, keys,
 * grants, memberships, collaborator grants, stars, their feed) goes; what
 * they made in others' repositories stays, shown as `ghost`.
 *
 * It begins with one D1 batch (`beginUserDeletion`), claimed like a
 * suspension (each statement after the first runs only if the first made
 * the change): the user, and every agent they own then (the retirement
 * set, `user_retirements`), become `deleting`, so none of them can
 * authenticate or issue anything from then on; their credentials are
 * revoked or removed; their handles are released (the principal's handle
 * becomes its own id, which no one can take: `_` is not allowed in a
 * handle) and held for 90 days (`handle_reservations`); the job is
 * recorded. The rest is the job's (`deletion-runner.ts`).
 */

/** What a deletion's transition is asked to delete, as the caller read it. */
export interface DeletionTarget {
  readonly id: string;
  readonly lifecycle: Lifecycle;
  readonly gen: number;
}

/** Who deletes, for the records. */
export interface DeletionActor {
  readonly principalId: string;
  readonly act: readonly string[];
  readonly requestId?: string;
}

/**
 * Begins deleting `target` (an active or suspended user, read at its
 * generation) in one batch; true when this call made the change (false:
 * the user changed meanwhile, is the last active administrator, or is
 * being deleted already).
 */
export async function beginUserDeletion(
  db: D1Database,
  target: DeletionTarget,
  actor: DeletionActor,
  now: number,
): Promise<boolean> {
  const claim = crypto.randomUUID();
  // ?1 the user, ?2 this request's claim: each statement after the first runs only if the first
  // made the change. The set, once recorded, by `IN (SELECT …)`.
  const made = "EXISTS (SELECT 1 FROM principals WHERE id = ?1 AND lifecycle_claim = ?2)";
  const set = "(SELECT principal_id FROM user_retirements WHERE user_id = ?1)";
  const stmt = (sql: string, ...args: unknown[]) => db.prepare(sql).bind(target.id, claim, ...args);
  const [changed] = await db.batch([
    // The user, never the last active instance administrator (decided here, so two
    // administrators deleting each other leave one).
    stmt(
      `UPDATE principals SET lifecycle = 'deleting', lifecycle_gen = ?3, lifecycle_claim = ?2,
         disabled_at = coalesce(disabled_at, ?4)
       WHERE id = ?1 AND type = 'user' AND lifecycle IN ('active', 'suspended')
         AND lifecycle_gen = ?5
         AND (is_instance_admin = 0 OR EXISTS (SELECT 1 FROM principals o
           WHERE o.is_instance_admin = 1 AND o.lifecycle = 'active' AND o.id <> ?1))`,
      target.gen + 1,
      now,
      target.gen,
    ),
    // The job, with the last account recorded before it began and the handles released.
    stmt(
      `INSERT INTO user_deletions (user_id, step, requested_by, request_id, scan_until,
         next_attempt_at, released_handles, created_at, updated_at)
       SELECT ?1, 'repositories', ?3, ?4, (SELECT coalesce(max(rowid), 0) FROM source_epochs),
         ?5, (SELECT json_group_array(json_object('id', id, 'handle', handle)) FROM principals
           WHERE id = ?1 OR (owner_id = ?1 AND type = 'agent'
             AND lifecycle IN ('active', 'suspended'))),
         ?5, ?5
       WHERE ${made}`,
      actor.principalId,
      actor.requestId ?? null,
      now,
    ),
    // The retirement set: the user, then the agents they own now (none can be made after:
    // the user can no longer issue anything).
    stmt(
      `INSERT INTO user_retirements (user_id, principal_id, ord)
       SELECT ?1, id, CASE WHEN id = ?1 THEN 0 ELSE row_number() OVER (ORDER BY id) END
       FROM principals
       WHERE (id = ?1 OR (owner_id = ?1 AND type = 'agent' AND lifecycle IN ('active', 'suspended')))
         AND ${made}`,
    ),
    stmt(
      `UPDATE principals SET lifecycle = 'deleting', lifecycle_gen = lifecycle_gen + 1,
         disabled_at = coalesce(disabled_at, ?3)
       WHERE id IN ${set} AND id <> ?1 AND ${made}`,
      now,
    ),
    // Credentials, all of them: tokens of every type, sessions, OAuth refresh tokens,
    // unanswered requests and unused codes, passkeys, signing keys; grants from or to the set.
    stmt(
      `UPDATE tokens SET revoked_at = ?3 WHERE principal_id IN ${set} AND revoked_at IS NULL
         AND ${made}`,
      now,
    ),
    stmt(
      `UPDATE sessions SET revoked_at = ?3 WHERE user_id IN ${set} AND revoked_at IS NULL
         AND ${made}`,
      now,
    ),
    stmt(
      `UPDATE refresh_tokens SET revoked_at = ?3 WHERE user_id IN ${set} AND revoked_at IS NULL
         AND ${made}`,
      now,
    ),
    stmt(
      `UPDATE oauth_requests SET expires_at = 0,
         code_expires_at = CASE WHEN code_expires_at IS NULL THEN NULL ELSE 0 END
       WHERE user_id IN ${set} AND used_at IS NULL AND ${made}`,
    ),
    stmt(`DELETE FROM passkeys WHERE user_id IN ${set} AND ${made}`),
    stmt(`DELETE FROM ssh_signing_keys WHERE principal_id IN ${set} AND ${made}`),
    stmt(
      `UPDATE grants SET revoked_at = ?3
       WHERE (grantor_id IN ${set} OR agent_id IN ${set}) AND revoked_at IS NULL AND ${made}`,
      now,
    ),
    // Each handle held for 90 days (a reservation still running cannot exist: the set holds
    // these handles), then released.
    stmt(
      `INSERT INTO handle_reservations (handle, principal_id, until)
       SELECT handle, id, ?3 FROM principals WHERE id IN ${set} AND ${made}
       ON CONFLICT (handle) DO UPDATE SET principal_id = excluded.principal_id,
         until = excluded.until
       WHERE handle_reservations.until <= ?4`,
      now + HANDLE_HOLD_MS,
      now,
    ),
    stmt(`UPDATE principals SET handle = id WHERE id IN ${set} AND ${made}`),
    // The transition's records: the user's journal row and the audit row.
    stmt(
      `INSERT INTO principal_lifecycle (principal_id, gen, from_state, to_state, at, actor_id,
         request_id)
       SELECT ?1, ?3, ?4, 'deleting', ?5, ?6, ?7 WHERE ${made}`,
      target.gen + 1,
      target.lifecycle,
      now,
      actor.principalId,
      actor.requestId ?? null,
    ),
    stmt(
      `INSERT INTO audit_log (at, actor_id, act_chain, action, target_id, details, request_id)
       SELECT ?3, ?4, ?5, 'user.delete', ?1,
         json_object('principals', (SELECT json_group_array(principal_id) FROM user_retirements
           WHERE user_id = ?1)), ?6
       WHERE ${made}`,
      now,
      actor.principalId,
      actor.act.length > 0 ? JSON.stringify(actor.act) : null,
      actor.requestId ?? null,
    ),
  ]);
  return (changed?.meta.changes ?? 0) > 0;
}

type Deletion = Output<typeof deleteUser>;

/** A deletion as its job stands; undefined for a user never being deleted. */
async function deletionOf(ctx: OpContext, userId: string): Promise<Deletion | undefined> {
  ctx.metrics.count("d1.query", { db: "directory", op: "user_deletion_read" });
  const row = await ctx.env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT d.user_id AS id, p.lifecycle AS state, d.step, d.blocked, d.created_at, d.updated_at
       FROM user_deletions d JOIN principals p ON p.id = d.user_id WHERE d.user_id = ?`,
    )
    .bind(userId)
    .first<Deletion>();
  return row ?? undefined;
}

/**
 * Who `username` names: the user with that handle now, else, while a
 * deletion holds it, the user it was released by.
 */
async function deletionTarget(
  ctx: OpContext,
  username: string,
): Promise<(DeletionTarget & { readonly type: string }) | undefined> {
  const db = ctx.env.DIRECTORY.withSession("first-primary");
  ctx.metrics.count("d1.query", { db: "directory", op: "lifecycle_target" });
  const row = await db
    .prepare(
      `SELECT id, type, lifecycle, lifecycle_gen AS gen FROM principals
       WHERE handle = ?1 COLLATE NOCASE
       UNION ALL
       SELECT p.id, p.type, p.lifecycle, p.lifecycle_gen FROM handle_reservations r
         JOIN principals p ON p.id = r.principal_id
       WHERE r.handle = ?1 AND r.until > ?2
         AND NOT EXISTS (SELECT 1 FROM principals WHERE handle = ?1 COLLATE NOCASE)
       LIMIT 1`,
    )
    .bind(username, clock())
    .first<DeletionTarget & { type: string }>();
  return row ?? undefined;
}

/** The `admin.users.delete` operation (see the module's description). */
export async function deleteUserOperation(
  ctx: OpContext,
  input: Input<typeof deleteUser>,
): Promise<Output<typeof deleteUser>> {
  const target = await deletionTarget(ctx, input.username);
  if (target?.type !== "user")
    throw new OperationError(404, "user_not_found", `No user has the handle ${input.username}.`);
  if (target.id === ctx.auth.principalId)
    throw new OperationError(422, "cannot_delete_self", "You cannot delete yourself.");
  if (target.lifecycle === "active" || target.lifecycle === "suspended") {
    ctx.metrics.count("d1.query", { db: "directory", op: "user_deletion_begin" }, 15);
    const began = await beginUserDeletion(
      ctx.env.DIRECTORY,
      target,
      {
        principalId: ctx.auth.principalId,
        act: ctx.auth.act,
        ...(ctx.requestId !== undefined && { requestId: ctx.requestId }),
      },
      clock(),
    );
    if (began) {
      // Its runner, at once; if this is lost, the deletions' recovery cron sets it.
      ctx.metrics.count("do.request", { class: "DeletionDO", method: "arm" });
      await ctx.env.DELETION.getByName(target.id)
        .arm(clock())
        .catch((error: unknown) =>
          createLogger({ op: "users.delete", userId: target.id }).warn(
            "arming the deletion failed",
            { error },
          ),
        );
    }
  }
  const deletion = await deletionOf(ctx, target.id);
  if (deletion) return deletion;
  // Not begun, and no deletion: why.
  ctx.metrics.count("d1.query", { db: "directory", op: "lifecycle_target" });
  const now = await ctx.env.DIRECTORY.withSession("first-primary")
    .prepare("SELECT lifecycle_gen AS gen, lifecycle FROM principals WHERE id = ?")
    .bind(target.id)
    .first<{ gen: number; lifecycle: Lifecycle }>();
  if (now?.gen === target.gen && now.lifecycle === target.lifecycle)
    throw new OperationError(
      409,
      "last_admin",
      "This is the last active instance administrator: make another one first.",
    );
  throw new OperationError(409, "user_changed", "The user changed meanwhile; try again.");
}
