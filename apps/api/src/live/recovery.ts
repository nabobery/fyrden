import { DISCRETIONARY_RESOURCES } from "../effects/discretionary.js";
import {
  isLiveCompletionOf,
  LIVE_NOW,
  type LiveDurationCompletion,
  type LiveEnvelope,
  type LiveGrantResult,
} from "./budget.js";
import { LIVE_ADMISSION } from "./directory.js";

/*
 * Recovery of the live state grants left in feeds' objects: a feed holding
 * granted state has a target in the directory (the grant sequence it must
 * be cleaned through, when it is next due, its backoff, the local cleanup
 * it owes). A coordinator funds each attempt with a fresh cleanup grant,
 * captures the target only then, asks the object (`UserDO.recoverLiveV1`)
 * to clean a bounded page, and retires the target with its debt only on
 * an acknowledgement of exactly what was captured as clean; anything else
 * backs off. Recovery never makes more for itself to recover. Production
 * wires this with the funded maintenance (later); nothing calls it yet.
 */

const N = LIVE_NOW;
const R = DISCRETIONARY_RESOURCES;

export interface LiveRecoveryRequest {
  readonly protocol: 1;
  readonly nonce: string;
  readonly feed: string;
  readonly incarnation: string;
  readonly throughSeq: number;
  readonly coverage: LiveEnvelope;
}

export type LiveRecoveryReply =
  | {
      readonly protocol: 1;
      readonly nonce: string;
      readonly feed: string;
      readonly incarnation: string;
      readonly throughSeq: number;
      readonly status: "pending" | "clean";
      readonly completion: LiveDurationCompletion;
    }
  | {
      readonly protocol: 1;
      readonly nonce: string;
      readonly feed: string;
      readonly status: "refused";
      readonly reason: "invalid" | "expired" | "fenced";
    };

export interface LiveRecoveryTarget {
  readonly feed: string;
  readonly incarnation: string;
  readonly throughSeq: number;
  readonly attempts: number;
  readonly nextAttemptAt: number;
}

/** The feeds whose recovery is due, earliest first (identities only: captured once funded). */
export async function dueLiveRecoveryFeeds(
  db: D1Database,
  limit: number,
): Promise<readonly string[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIVE_ADMISSION.deliveries)
    throw new RangeError(`limit ${limit}`);
  const { results } = await db
    .withSession("first-primary")
    .prepare(
      `SELECT feed FROM live_recovery_targets INDEXED BY live_recovery_targets_due
       WHERE next_attempt_at <= ${N} ORDER BY next_attempt_at, feed LIMIT ?`,
    )
    .bind(limit)
    .all<{ feed: string }>();
  return results.map((r) => r.feed);
}

/** A feed's target under the ledger's incarnation, as it is now. */
export async function captureLiveRecoveryTarget(
  db: D1Database,
  feed: string,
): Promise<LiveRecoveryTarget | null> {
  const row = await db
    .withSession("first-primary")
    .prepare(
      `SELECT feed, incarnation, through_seq, attempts, next_attempt_at FROM live_recovery_targets
       WHERE feed = ? AND incarnation = (SELECT incarnation FROM live_budget_state WHERE id = 1)`,
    )
    .bind(feed)
    .first<{
      feed: string;
      incarnation: string;
      through_seq: number;
      attempts: number;
      next_attempt_at: number;
    }>();
  return row
    ? {
        feed: row.feed,
        incarnation: row.incarnation,
        throughSeq: row.through_seq,
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at,
      }
    : null;
}

/**
 * Retires a target cleaned through exactly its captured sequence: its
 * local debt (read from the target, never the acknowledgement) leaves the
 * ledger in the same batch. A newer grant (another sequence) or a second
 * acknowledgement finds nothing. Whether it was retired.
 */
export async function retireLiveTarget(
  db: D1Database,
  acknowledgement: Extract<LiveRecoveryReply, { status: "pending" | "clean" }>,
): Promise<boolean> {
  if (acknowledgement.status !== "clean") return false;
  const target = `feed = ?1 AND incarnation = ?2 AND through_seq = ?3`;
  const args = [acknowledgement.feed, acknowledgement.incarnation, acknowledgement.throughSeq];
  const [, deleted] = await db.batch([
    db
      .prepare(
        `UPDATE live_budget_state SET ${R.map(
          (r) =>
            `debt_${r} = debt_${r} - coalesce((SELECT CAST(json_extract(local_cleanup_debt, '$.${r}') AS INTEGER)
               FROM live_recovery_targets WHERE ${target}), 0)`,
        ).join(", ")}
         WHERE id = 1 AND incarnation = ?2`,
      )
      .bind(...args),
    db
      .prepare(
        `DELETE FROM live_recovery_targets WHERE ${target}
           AND ?2 = (SELECT incarnation FROM live_budget_state WHERE id = 1)
         RETURNING feed`,
      )
      .bind(...args),
  ]);
  return (deleted?.results.length ?? 0) > 0;
}

/** Backs a target off after a failed, pending or stale attempt (once per captured attempt). */
export async function backoffLiveTarget(
  db: D1Database,
  captured: LiveRecoveryTarget,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE live_recovery_targets
       SET attempts = min(attempts + 1, 7),
         next_attempt_at = ${N} + CASE attempts WHEN 0 THEN 60000 WHEN 1 THEN 120000
           WHEN 2 THEN 240000 WHEN 3 THEN 480000 WHEN 4 THEN 960000 WHEN 5 THEN 1920000
           ELSE 3600000 END
       WHERE feed = ? AND incarnation = ? AND attempts = ? AND next_attempt_at = ?`,
    )
    .bind(captured.feed, captured.incarnation, captured.attempts, captured.nextAttemptAt)
    .run();
  return result.meta.changes > 0;
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Whether `reply` acknowledges exactly `request`, with a well-formed completion of its coverage. */
function acknowledges(
  request: LiveRecoveryRequest,
  reply: unknown,
): reply is Extract<LiveRecoveryReply, { status: "pending" | "clean" }> {
  if (typeof reply !== "object" || reply === null) return false;
  const r = reply as Record<string, unknown>;
  return (
    r.protocol === 1 &&
    r.nonce === request.nonce &&
    r.feed === request.feed &&
    r.incarnation === request.incarnation &&
    r.throughSeq === request.throughSeq &&
    (r.status === "pending" || r.status === "clean") &&
    isLiveCompletionOf(request.coverage, r.completion)
  );
}

/**
 * Recovers due targets in order, each attempt funded by a fresh grant
 * first (a refusal stops the run: nothing after it is attempted or backed
 * off), the target captured only once funded and dispatched to its feed;
 * a clean acknowledgement of exactly what was captured retires it, and any
 * other outcome backs it off. The caller pays for its own work.
 */
export async function recoverLiveTargets(
  db: D1Database,
  options: {
    readonly limit: number;
    readonly reserveTarget: (feed: string) => Promise<LiveGrantResult>;
    readonly tell: (request: LiveRecoveryRequest) => Promise<LiveRecoveryReply>;
  },
): Promise<{
  readonly attempted: number;
  readonly retired: number;
  readonly pending: number;
  readonly failed: number;
}> {
  const counts = { attempted: 0, retired: 0, pending: 0, failed: 0 };
  for (const feed of await dueLiveRecoveryFeeds(db, options.limit)) {
    const funded = await options.reserveTarget(feed);
    if (funded.status !== "granted") break;
    const captured = await captureLiveRecoveryTarget(db, feed);
    // Gone since it was selected: its funding is kept charged.
    if (!captured) continue;
    const request: LiveRecoveryRequest = {
      protocol: 1,
      nonce: hex(crypto.getRandomValues(new Uint8Array(16))),
      feed,
      incarnation: captured.incarnation,
      throughSeq: captured.throughSeq,
      coverage: funded.grant,
    };
    counts.attempted++;
    let reply: unknown;
    try {
      reply = await options.tell(request);
    } catch {
      reply = null;
    }
    if (
      acknowledges(request, reply) &&
      reply.status === "clean" &&
      (await retireLiveTarget(db, reply))
    ) {
      counts.retired++;
      continue;
    }
    if (acknowledges(request, reply) && reply.status === "pending") counts.pending++;
    else counts.failed++;
    await backoffLiveTarget(db, captured);
  }
  return counts;
}

/** What a recovery call may take: its D1 read, then a bounded synchronous page. */
export const LIVE_RECOVERY_DURATION = { pendingMs: 60_000, tailMs: 1_000 } as const;
