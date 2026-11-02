import type { LiveEnvelope } from "./budget.js";

/*
 * Live tickets' transports in the directory (migration 0040): what the
 * Worker finds of a ticket before it wakes the feed's object, so the
 * redemption is paid for first. A transport is the ticket's hash (never the
 * ticket), the feed and credential it binds, when it expires and the grant
 * funding its redemption; it is claimed once (a claim's retry, by its own
 * claim id, finds it again; any other finds nothing), and removed by its
 * expiry, in order, a bounded page at a time.
 */

export interface LiveTransport {
  readonly ticketHash: string;
  readonly feed: string;
  readonly credentialId: string;
  readonly expiresAt: number;
  readonly operationId: string;
  /** Its grant, as the redemption hands it on (null for one recorded without it). */
  readonly envelope: LiveEnvelope | null;
}

/** Expired transports a call removes at most. */
export const LIVE_TRANSPORT_PAGE = 100;

/** Records `transport`; false when its ticket already has one. */
export async function recordTransport(db: D1Database, transport: LiveTransport): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO live_ticket_transports (ticket_hash, feed, credential_id, expires_at,
         operation_id, envelope_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (ticket_hash) DO NOTHING`,
    )
    .bind(
      transport.ticketHash,
      transport.feed,
      transport.credentialId,
      transport.expiresAt,
      transport.operationId,
      transport.envelope === null ? null : JSON.stringify(transport.envelope),
    )
    .run();
  return result.meta.changes > 0;
}

/**
 * Claims the transport of `ticketHash` for `credentialId` as `claimId`,
 * while unexpired at `now`: once (the same claim again finds it; another
 * claim, another credential's or an expired one finds nothing).
 */
export async function claimTransport(
  db: D1Database,
  ticketHash: string,
  credentialId: string,
  claimId: string,
  now: number,
): Promise<LiveTransport | null> {
  const row = await db
    .prepare(
      `UPDATE live_ticket_transports SET claimed_at = coalesce(claimed_at, ?4), claim_id = ?3
       WHERE ticket_hash = ?1 AND credential_id = ?2 AND expires_at > ?4
         AND (claim_id IS NULL OR claim_id = ?3)
       RETURNING ticket_hash, feed, credential_id, expires_at, operation_id, envelope_json`,
    )
    .bind(ticketHash, credentialId, claimId, now)
    .first<{
      ticket_hash: string;
      feed: string;
      credential_id: string;
      expires_at: number;
      operation_id: string;
      envelope_json: string | null;
    }>();
  if (!row) return null;
  return {
    ticketHash: row.ticket_hash,
    feed: row.feed,
    credentialId: row.credential_id,
    expiresAt: row.expires_at,
    operationId: row.operation_id,
    envelope: row.envelope_json === null ? null : (JSON.parse(row.envelope_json) as LiveEnvelope),
  };
}

/** Removes transports expired by `now`, oldest first, `limit` at most: how many went. */
export async function expireTransports(
  db: D1Database,
  now: number,
  limit = LIVE_TRANSPORT_PAGE,
): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM live_ticket_transports WHERE ticket_hash IN (
         SELECT ticket_hash FROM live_ticket_transports WHERE expires_at <= ?1
         ORDER BY expires_at, ticket_hash LIMIT ?2)`,
    )
    .bind(now, limit)
    .run();
  return result.meta.changes;
}
