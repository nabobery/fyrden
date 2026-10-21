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
