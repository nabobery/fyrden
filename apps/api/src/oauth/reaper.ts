import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { METADATA_POLICY } from "./clients.js";

/**
 * Prunes what the authorization server keeps past its use: answered or
 * abandoned authorization requests, expired access tokens (their mints
 * stay in the audit log), refresh token families past their end (90
 * days, Proposed), DPoP proofs past their freshness, sessions, and
 * client ID metadata documents not fetched for longer than they may be used,
 * each a day after it expired (a code or refresh token coming back within
 * that day still revokes its family), and registrations never used within
 * a day, or unused for longer than any refresh token lives. A bounded
 * share per cron run.
 */

/** Proposed. */
export const OAUTH_REAP_POLICY = {
  keepMs: 24 * 60 * 60 * 1000,
  /** A registration unused this long goes (past a refresh token's 30 days). */
  idleClientMs: 90 * 24 * 60 * 60 * 1000,
  perRun: 500,
};

export async function reapOAuth(
  env: Env,
  options: { now: number; metrics?: Metrics },
): Promise<number> {
  const before = options.now - OAUTH_REAP_POLICY.keepMs;
  const limit = OAUTH_REAP_POLICY.perRun;
  const db = env.DIRECTORY;
  options.metrics?.count("d1.query", { db: "directory", op: "oauth_reap" }, 6);
  const results = await db.batch([
    db
      .prepare(
        `DELETE FROM oauth_requests WHERE rowid IN (SELECT rowid FROM oauth_requests
           WHERE expires_at <= ?1 AND (code_expires_at IS NULL OR code_expires_at <= ?1) LIMIT ?2)`,
      )
      .bind(before, limit),
    db
      .prepare(
        // Only families past their end: a used token coming back while its family lives must
        // still be recognized (and revoke it).
        `DELETE FROM refresh_tokens WHERE rowid IN (SELECT rowid FROM refresh_tokens
           WHERE family_expires_at <= ?1 LIMIT ?2)`,
      )
      .bind(before, limit),
    db
      .prepare(
        `DELETE FROM tokens WHERE rowid IN (SELECT rowid FROM tokens
           WHERE type = 'oat' AND expires_at <= ?1 LIMIT ?2)`,
      )
      .bind(before, limit),
    // A proof past its freshness cannot be replayed: its jti is not needed.
    db
      .prepare(
        `DELETE FROM dpop_proofs WHERE rowid IN (SELECT rowid FROM dpop_proofs
           WHERE expires_at <= ?1 LIMIT ?2)`,
      )
      .bind(options.now, limit),
    db
      .prepare(
        `DELETE FROM sessions WHERE rowid IN (SELECT rowid FROM sessions
           WHERE expires_at <= ?1 LIMIT ?2)`,
      )
      .bind(before, limit),
    db
      .prepare(
        `DELETE FROM oauth_clients WHERE rowid IN (SELECT rowid FROM oauth_clients
           WHERE (kind = 'registered' AND (
               (last_used_at IS NULL AND created_at <= ?1) OR last_used_at <= ?2))
             OR (kind = 'metadata_document' AND fetched_at <= ?4)
           LIMIT ?3)`,
      )
      .bind(
        before,
        options.now - OAUTH_REAP_POLICY.idleClientMs,
        limit,
        options.now - METADATA_POLICY.staleMs,
      ),
  ]);
  return results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}
