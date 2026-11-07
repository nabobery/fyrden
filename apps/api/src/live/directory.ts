import { createLogger, type Metrics } from "@fyrden/adapters-cloudflare/obs";
import { LIVE_NOW } from "./budget.js";
import type { LiveCredential } from "./credential.js";

/*
 * The directory's side of live sockets: admission (a pending lease and the
 * dependency index, within the deployment's allowance and a principal's
 * daily admissions), confirmation (pending to open, only while the lease
 * stands), release (one idempotent path for disconnect, expiry,
 * retirement, revocation and a failed confirmation), the reaper of leases
 * whose release was lost, and the revocation sweep (each revocation's
 * sockets found through the index, their feeds told, failures retried
 * behind the others).
 */

export const LIVE_ADMISSION = {
  /** How long an admission waits for its feed's object to confirm it. */
  pendingMs: 60_000,
  /** Sockets a principal may open a UTC day. */
  perDay: 60,
  /** Leases and revocation rows reaped, index rows scanned, feeds told and revocations taken a run at most. */
  reapRows: 1_000,
  scanRows: 1_000,
  deliveries: 200,
  revocations: 50,
  /** How long fully told revocations are kept. */
  keepMs: 7 * 24 * 60 * 60_000,
  /**
   * How long past a socket's renewal deadline its lease holds: a lease
   * lapses unless renewals extend it, so a socket gone without a word stops
   * counting by then.
   */
  leaseMarginMs: 2 * 60_000,
} as const;

const DAY = 24 * 60 * 60_000;

/** The deployment's live allowance (`FYRDEN_LIVE_SOCKETS`, default 50); null while live sockets are off. */
export function liveAllowance(env: object): number | null {
  const vars = env as { FYRDEN_LIVE?: unknown; FYRDEN_LIVE_SOCKETS?: unknown };
  if (vars.FYRDEN_LIVE !== "on") return null;
  const value = vars.FYRDEN_LIVE_SOCKETS;
  if (value === undefined || value === "") return 50;
  return typeof value === "string" && /^[1-9]\d{0,5}$/.test(value) ? Number(value) : null;
}

/** Why an admission was refused. */
export type Refusal = "allowance" | "daily" | "funding";

/**
 * Admits a socket in one batch: its pending lease (until confirmed, at most
 * `pendingMs`) and its dependency rows, only while the deployment has room,
 * the principal has opened fewer than `perDay` today, and the admission's
 * grant (`fundingId`) still holds in the ledger (unexpired, unsettled, by
 * D1's time): the lease records it, so no lease stands without the grant
 * that pays for it. Null when admitted, else why not.
 */
export async function admit(
  db: D1Database,
  socket: { id: string; ticketId: string; feed: string; expiresAt: number },
  credential: LiveCredential,
  allowance: number,
  now: number,
  fundingId: string,
): Promise<Refusal | null> {
  const day = Math.floor(now / DAY);
  const [lease] = await db.batch([
    db
      .prepare(
        `INSERT INTO live_sockets (socket_id, ticket_id, feed, credential_id, state, pending_until,
           expires_at, funding_operation_id)
         SELECT ?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?11
         WHERE (SELECT count(*) FROM live_sockets WHERE expires_at > ?7
             AND (state = 'open' OR pending_until > ?7)) < ?8
           AND coalesce((SELECT n FROM live_admissions WHERE principal_id = ?3 AND day = ?9), 0)
             < ?10
           AND EXISTS (SELECT 1 FROM live_budget_receipts WHERE operation_id = ?11
             AND settled_at IS NULL AND valid_until > ${LIVE_NOW})`,
      )
      .bind(
        socket.id,
        socket.ticketId,
        socket.feed,
        credential.id,
        now + LIVE_ADMISSION.pendingMs,
        socket.expiresAt,
        now,
        allowance,
        day,
        LIVE_ADMISSION.perDay,
        fundingId,
      ),
    db
      .prepare(
        `INSERT INTO live_socket_deps (dependency, socket_id)
         SELECT value, ?1 FROM json_each(?2)
         WHERE EXISTS (SELECT 1 FROM live_sockets WHERE socket_id = ?1)
         ON CONFLICT DO NOTHING`,
      )
      .bind(socket.id, JSON.stringify([...new Set(credential.dependencies)])),
    db
      .prepare(
        `INSERT INTO live_admissions (principal_id, day, n)
         SELECT ?1, ?2, 1 WHERE EXISTS (SELECT 1 FROM live_sockets WHERE socket_id = ?3)
         ON CONFLICT (principal_id, day) DO UPDATE SET n = n + 1`,
      )
      .bind(socket.feed, day, socket.id),
  ]);
  if ((lease?.meta.changes ?? 0) > 0) return null;
  const why = await db
    .withSession("first-primary")
    .prepare(
      `SELECT (SELECT n FROM live_admissions WHERE principal_id = ?1 AND day = ?2) AS n,
         EXISTS (SELECT 1 FROM live_budget_receipts WHERE operation_id = ?3
           AND settled_at IS NULL AND valid_until > ${LIVE_NOW}) AS funded`,
    )
    .bind(socket.feed, day, fundingId)
    .first<{ n: number | null; funded: number }>();
  if ((why?.n ?? 0) >= LIVE_ADMISSION.perDay) return "daily";
  return why?.funded === 1 ? "allowance" : "funding";
}

/** Confirms a pending lease, only while it stands; whether it did. */
export async function confirm(db: D1Database, socketId: string, now: number): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE live_sockets SET state = 'open'
       WHERE socket_id = ? AND state = 'pending' AND pending_until > ? AND expires_at > ?
       RETURNING socket_id`,
    )
    .bind(socketId, now, now)
    .first<{ socket_id: string }>();
  return row !== null;
}

/**
 * Extends an open lease to `until` (never shortens one): a renewal's, so a
 * lease holds while its socket is renewed. Whether the lease is there.
 */
export async function extendLease(
  db: D1Database,
  socketId: string,
  until: number,
  now: number = Date.now(),
): Promise<boolean> {
  // Only a lease still held, by this Worker's clock and D1's own as it runs: one lapsed
  // meanwhile stays lapsed (its place may be another's).
  const row = await db
    .prepare(
      `UPDATE live_sockets SET expires_at = max(expires_at, ?2)
       WHERE socket_id = ?1 AND state = 'open' AND expires_at > max(?3, ${LIVE_NOW})
       RETURNING socket_id`,
    )
    .bind(socketId, until, now)
    .first<{ socket_id: string }>();
  return row !== null;
}

/** Releases a socket's lease and dependency rows (again: nothing). */
export async function release(db: D1Database, socketIds: readonly string[]): Promise<void> {
  if (socketIds.length === 0) return;
  const ids = JSON.stringify(socketIds);
  await db.batch([
    db
      .prepare("DELETE FROM live_socket_deps WHERE socket_id IN (SELECT value FROM json_each(?))")
      .bind(ids),
    db
      .prepare("DELETE FROM live_sockets WHERE socket_id IN (SELECT value FROM json_each(?))")
      .bind(ids),
  ]);
}

/** What one reaping removes of each kind at most (a number: as many of each). */
export interface LiveReapPages {
  /** Leases whose release was lost, each with its dependency rows. */
  readonly leases: number;
  /** Told revocations past their keep. */
  readonly revocations: number;
  /** Admission counts, and ticket counts, before yesterday (as many of each). */
  readonly counts: number;
  /** Tickets' transports past their expiry. */
  readonly transports: number;
}

/**
 * Reaps leases whose release was lost (pending past its wait, or past its
 * expiry), with their dependency rows, the earliest due first; told
 * revocations past their keep; admission and ticket counts before
 * yesterday; tickets' transports past their expiry: each a page of its own.
 */
export function reaping(
  db: D1Database,
  now: number,
  pages: number | LiveReapPages = LIVE_ADMISSION.reapRows,
): D1PreparedStatement[] {
  const page =
    typeof pages === "number"
      ? { leases: pages, revocations: pages, counts: pages, transports: pages }
      : pages;
  const rows = page.leases;
  // Each kind read through its own index (a run's at most), then the earliest due of both: the
  // same choice for both deletes (the dependency rows go first, the leases still there).
  const due = `SELECT socket_id FROM (
      SELECT * FROM (SELECT socket_id, expires_at AS due FROM live_sockets
        INDEXED BY live_sockets_expiry WHERE expires_at <= ?1 ORDER BY expires_at LIMIT ?2)
      UNION ALL
      SELECT * FROM (SELECT socket_id, pending_until AS due FROM live_sockets
        INDEXED BY live_sockets_pending WHERE state = 'pending' AND pending_until <= ?1
        ORDER BY pending_until LIMIT ?2))
    GROUP BY socket_id ORDER BY min(due), socket_id LIMIT ?2`;
  return [
    db.prepare(`DELETE FROM live_socket_deps WHERE socket_id IN (${due})`).bind(now, rows),
    db.prepare(`DELETE FROM live_sockets WHERE socket_id IN (${due})`).bind(now, rows),
    db
      .prepare(
        `DELETE FROM revocations WHERE seq IN (SELECT seq FROM revocations INDEXED BY revocations_at
           WHERE at < ?1 AND expanded = 1
             AND NOT EXISTS (SELECT 1 FROM revocation_targets t WHERE t.seq = revocations.seq)
           ORDER BY at LIMIT ?2)`,
      )
      .bind(now - LIVE_ADMISSION.keepMs, page.revocations),
    db
      .prepare(
        `DELETE FROM live_admissions WHERE (principal_id, day) IN (
           SELECT principal_id, day FROM live_admissions INDEXED BY live_admissions_day
           WHERE day < ?1 ORDER BY day, principal_id LIMIT ?2)`,
      )
      .bind(Math.floor(now / DAY) - 1, page.counts),
    // Tickets' day counts before yesterday, and transports past their expiry, a run's at most.
    db
      .prepare(
        `DELETE FROM live_ticket_days WHERE (principal_id, day) IN (
           SELECT principal_id, day FROM live_ticket_days INDEXED BY live_ticket_days_day
           WHERE day < ?1 ORDER BY day, principal_id LIMIT ?2)`,
      )
      .bind(Math.floor(now / DAY) - 1, page.counts),
    reapingTransports(db, now, page.transports),
  ];
}

/** A page of ticket transports past their expiry removed. */
export function reapingTransports(db: D1Database, now: number, rows: number): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM live_ticket_transports WHERE ticket_hash IN (
         SELECT ticket_hash FROM live_ticket_transports INDEXED BY live_ticket_transports_expiry
         WHERE expires_at <= ?1 ORDER BY expires_at, ticket_hash LIMIT ?2)`,
    )
    .bind(now, rows);
}

/**
 * Tells one feed's object that dependencies were revoked; resolves when it
 * applied them, with the sockets it closed (their leases are released here).
 */
export type Teller = (
  feed: string,
  dependencies: readonly string[],
) => Promise<readonly string[] | void>;

/**
 * One sweep run: expands revocations (each one's sockets through the
 * dependency index, from its cursor, a feed a target), then tells the
 * feeds due earliest, 8 at a time, deleting a target told and moving a
 * failed one back by a back-off (1 minute, doubling, at most an hour).
 */
export async function sweep(
  db: D1Database,
  tell: Teller,
  now: number,
  metrics?: Metrics,
  limits: {
    readonly deliveries?: number;
    readonly revocations?: number;
    /** Dependency rows the expansion scans at most. */
    readonly scan?: number;
    /** Whether to go on to the next group of deliveries (false once the caller gave up). */
    readonly proceed?: () => boolean;
  } = {},
): Promise<{ expanded: number; told: number; failed: number }> {
  const primary = db.withSession("first-primary");
  const { results: open } = await primary
    .prepare(
      `SELECT seq, subject, cursor FROM revocations INDEXED BY revocations_open
       WHERE expanded = 0 ORDER BY seq LIMIT ?`,
    )
    .bind(limits.revocations ?? LIVE_ADMISSION.revocations)
    .all<{ seq: number; subject: string; cursor: string | null }>();
  let scanned = 0;
  let expanded = 0;
  for (const revocation of open) {
    const room = (limits.scan ?? LIVE_ADMISSION.scanRows) - scanned;
    if (room <= 0) break;
    const { results: rows } = await primary
      .prepare(
        `SELECT d.socket_id, s.feed FROM live_socket_deps d
           JOIN live_sockets s ON s.socket_id = d.socket_id
         WHERE d.dependency = ?1 AND d.socket_id > ?2 ORDER BY d.socket_id LIMIT ?3`,
      )
      .bind(revocation.subject, revocation.cursor ?? "", room)
      .all<{ socket_id: string; feed: string }>();
    scanned += rows.length;
    const done = rows.length < room;
    const feeds = [...new Set(rows.map((r) => r.feed))];
    metrics?.count("d1.query", { db: "directory", op: "live_expand" }, 2);
    await db.batch([
      db
        .prepare(
          `INSERT INTO revocation_targets (seq, feed, attempts, next_attempt_at)
           SELECT ?1, value, 0, ?2 FROM json_each(?3) WHERE true
           ON CONFLICT (seq, feed) DO NOTHING`,
        )
        .bind(revocation.seq, now, JSON.stringify(feeds)),
      db
        .prepare("UPDATE revocations SET cursor = ?2, expanded = ?3 WHERE seq = ?1")
        .bind(revocation.seq, rows.at(-1)?.socket_id ?? revocation.cursor, done ? 1 : 0),
    ]);
    if (done) expanded++;
  }
  const { results: due } = await primary
    .prepare(
      `SELECT t.seq, t.feed, t.attempts, r.subject FROM revocation_targets t
         INDEXED BY revocation_targets_due JOIN revocations r ON r.seq = t.seq
       WHERE t.next_attempt_at <= ? ORDER BY t.next_attempt_at, t.seq, t.feed LIMIT ?`,
    )
    .bind(now, limits.deliveries ?? LIVE_ADMISSION.deliveries)
    .all<{ seq: number; feed: string; attempts: number; subject: string }>();
  let told = 0;
  let failed = 0;
  for (let i = 0; i < due.length; i += 8) {
    if (limits.proceed && !limits.proceed()) break;
    const slice = due.slice(i, i + 8);
    const outcomes = await Promise.allSettled(slice.map((t) => tell(t.feed, [t.subject])));
    const statements = slice.map((t, j) =>
      outcomes[j]?.status === "fulfilled"
        ? db
            .prepare("DELETE FROM revocation_targets WHERE seq = ? AND feed = ?")
            .bind(t.seq, t.feed)
        : db
            .prepare(
              `UPDATE revocation_targets SET attempts = attempts + 1, next_attempt_at = ?3
               WHERE seq = ?1 AND feed = ?2`,
            )
            .bind(t.seq, t.feed, now + Math.min(60 * 60_000, 60_000 * 2 ** t.attempts)),
    );
    // The sockets each feed closed: their leases go with its target.
    const closed = outcomes.flatMap((o) =>
      o.status === "fulfilled" && o.value ? [...o.value] : [],
    );
    if (closed.length > 0)
      statements.push(
        db
          .prepare(
            "DELETE FROM live_socket_deps WHERE socket_id IN (SELECT value FROM json_each(?))",
          )
          .bind(JSON.stringify(closed)),
        db
          .prepare("DELETE FROM live_sockets WHERE socket_id IN (SELECT value FROM json_each(?))")
          .bind(JSON.stringify(closed)),
      );
    for (const outcome of outcomes)
      if (outcome.status === "fulfilled") told++;
      else failed++;
    metrics?.count("d1.query", { db: "directory", op: "live_told" }, statements.length);
    await db.batch(statements);
  }
  if (failed > 0) createLogger({ op: "live.sweep" }).warn("revocations not told yet", { failed });
  return { expanded, told, failed };
}
