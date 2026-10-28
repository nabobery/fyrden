import { createLogger, type Metrics } from "@fyrden/adapters-cloudflare/obs";
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
export type Refusal = "allowance" | "daily";

/**
 * Admits a socket in one batch: its pending lease (until confirmed, at most
 * `pendingMs`) and its dependency rows, only while the deployment has room
 * and the principal has opened fewer than `perDay` today. Null when
 * admitted, else why not.
 */
export async function admit(
  db: D1Database,
  socket: { id: string; ticketId: string; feed: string; expiresAt: number },
  credential: LiveCredential,
  allowance: number,
  now: number,
): Promise<Refusal | null> {
  const day = Math.floor(now / DAY);
  const [lease] = await db.batch([
    db
      .prepare(
        `INSERT INTO live_sockets (socket_id, ticket_id, feed, credential_id, state, pending_until,
           expires_at)
         SELECT ?1, ?2, ?3, ?4, 'pending', ?5, ?6
         WHERE (SELECT count(*) FROM live_sockets WHERE expires_at > ?7
             AND (state = 'open' OR pending_until > ?7)) < ?8
           AND coalesce((SELECT n FROM live_admissions WHERE principal_id = ?3 AND day = ?9), 0)
             < ?10`,
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
  const daily = await db
    .withSession("first-primary")
    .prepare("SELECT n FROM live_admissions WHERE principal_id = ? AND day = ?")
    .bind(socket.feed, day)
    .first<{ n: number }>();
  return (daily?.n ?? 0) >= LIVE_ADMISSION.perDay ? "daily" : "allowance";
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

/**
 * Reaps leases whose release was lost (pending past its wait, or past its
 * expiry), with their dependency rows; told revocations past their keep;
 * admission counts before yesterday.
 */
export function reaping(db: D1Database, now: number): D1PreparedStatement[] {
  const stale = `SELECT socket_id FROM live_sockets INDEXED BY live_sockets_expiry
    WHERE expires_at <= ?1 ORDER BY expires_at LIMIT ?2`;
  const lapsed = `SELECT socket_id FROM live_sockets INDEXED BY live_sockets_pending
    WHERE state = 'pending' AND pending_until <= ?1 ORDER BY pending_until LIMIT ?2`;
  return [
    db
      .prepare(
        `DELETE FROM live_socket_deps WHERE socket_id IN (${stale}) OR socket_id IN (${lapsed})`,
      )
      .bind(now, LIVE_ADMISSION.reapRows),
    db
      .prepare(`DELETE FROM live_sockets WHERE socket_id IN (${stale}) OR socket_id IN (${lapsed})`)
      .bind(now, LIVE_ADMISSION.reapRows),
    db
      .prepare(
        `DELETE FROM revocations WHERE seq IN (SELECT seq FROM revocations INDEXED BY revocations_at
           WHERE at < ?1 AND expanded = 1
             AND NOT EXISTS (SELECT 1 FROM revocation_targets t WHERE t.seq = revocations.seq)
           ORDER BY at LIMIT ?2)`,
      )
      .bind(now - LIVE_ADMISSION.keepMs, LIVE_ADMISSION.reapRows),
    db.prepare("DELETE FROM live_admissions WHERE day < ?").bind(Math.floor(now / DAY) - 1),
  ];
}

/** Tells one feed's object that dependencies were revoked; resolves when it applied them. */
export type Teller = (feed: string, dependencies: readonly string[]) => Promise<void>;

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
): Promise<{ expanded: number; told: number; failed: number }> {
  const primary = db.withSession("first-primary");
  const { results: open } = await primary
    .prepare(
      `SELECT seq, subject, cursor FROM revocations INDEXED BY revocations_open
       WHERE expanded = 0 ORDER BY seq LIMIT ?`,
    )
    .bind(LIVE_ADMISSION.revocations)
    .all<{ seq: number; subject: string; cursor: string | null }>();
  let scanned = 0;
  let expanded = 0;
  for (const revocation of open) {
    const room = LIVE_ADMISSION.scanRows - scanned;
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
    .bind(now, LIVE_ADMISSION.deliveries)
    .all<{ seq: number; feed: string; attempts: number; subject: string }>();
  let told = 0;
  let failed = 0;
  for (let i = 0; i < due.length; i += 8) {
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
    for (const outcome of outcomes)
      if (outcome.status === "fulfilled") told++;
      else failed++;
    metrics?.count("d1.query", { db: "directory", op: "live_told" }, statements.length);
    await db.batch(statements);
  }
  if (failed > 0) createLogger({ op: "live.sweep" }).warn("revocations not told yet", { failed });
  return { expanded, told, failed };
}
