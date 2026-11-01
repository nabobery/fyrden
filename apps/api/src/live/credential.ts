import { parseTokenRestrictions } from "@fyrden/adapters-cloudflare/auth";

/*
 * A live socket's credential, read by its id on the directory's primary
 * without writing anything (no last-use touch): a session, or a token of
 * the principal itself (a delegated token is refused, as notification
 * listings refuse it; so is a DPoP-bound token, and any token whose owner
 * requires DPoP: a socket's upgrade carries no proof of a key). It holds
 * while it is unrevoked and unexpired, its source tokens too, and its
 * principal (and an agent's owner) enabled. With it, the
 * dependencies its authority rests on, as revocations name them:
 * `credential:<id>` for itself and its sources, `principal:<id>:<lifecycle
 * generation>` for its principal and an agent's owner.
 */

export interface LiveCredential {
  readonly id: string;
  readonly principalId: string;
  readonly principalType: "user" | "agent";
  /** When it stops: its own expiry (sources expire on their own and are checked by id). */
  readonly expiresAt: number;
  readonly scopes: readonly string[];
  readonly repoIds: readonly string[] | null;
  readonly dependencies: readonly string[];
}

type TokenRow = {
  id: string;
  principal_id: string;
  principal_type: string;
  lifecycle_gen: number;
  disabled_at: number | null;
  owner_id: string | null;
  owner_gen: number | null;
  owner_disabled_at: number | null;
  owner_require_dpop: number | null;
  scopes: string;
  repo_ids: string | null;
  expires_at: number;
  revoked_at: number | null;
  grant_id: string | null;
  dpop_jkt: string | null;
  source_id: string | null;
  source_source_id: string | null;
};

type SessionRow = {
  id: string;
  user_id: string;
  lifecycle_gen: number;
  expires_at: number;
};

/** A credential by id (a session's `ses_…` or a token's `tok_…`), when it holds at `now`. */
export async function liveCredential(
  db: D1Database,
  credentialId: string,
  now: number,
): Promise<LiveCredential | null> {
  const primary = db.withSession("first-primary");
  if (credentialId.startsWith("ses_")) {
    const row = await primary
      .prepare(
        `SELECT s.id, s.user_id, p.lifecycle_gen, s.expires_at
         FROM sessions s JOIN principals p ON p.id = s.user_id
         WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ?
           AND p.type = 'user' AND p.disabled_at IS NULL`,
      )
      .bind(credentialId, now)
      .first<SessionRow>();
    if (!row) return null;
    return {
      id: row.id,
      principalId: row.user_id,
      principalType: "user",
      expiresAt: row.expires_at,
      scopes: [],
      repoIds: null,
      dependencies: [`credential:${row.id}`, `principal:${row.user_id}:${row.lifecycle_gen}`],
    };
  }
  if (!credentialId.startsWith("tok_")) return null;
  const row = await primary
    .prepare(
      `SELECT t.id, t.principal_id, p.type AS principal_type, p.lifecycle_gen, p.disabled_at,
              p.owner_id, o.lifecycle_gen AS owner_gen, o.disabled_at AS owner_disabled_at,
              o.require_dpop AS owner_require_dpop, t.scopes, t.repo_ids, t.expires_at,
              coalesce(t.revoked_at, s.revoked_at, f.revoked_at) AS revoked_at, t.grant_id,
              t.dpop_jkt, t.source_id, s.source_id AS source_source_id
       FROM tokens t JOIN principals p ON p.id = t.principal_id
       LEFT JOIN principals o ON o.id = p.owner_id
       -- A token minted from another stops with it, and with the one that one came from.
       LEFT JOIN tokens s ON s.id = t.source_id
       LEFT JOIN tokens f ON f.id = s.source_id
       WHERE t.id = ?`,
    )
    .bind(credentialId)
    .first<TokenRow>();
  if (
    !row ||
    row.revoked_at !== null ||
    row.expires_at <= now ||
    row.grant_id !== null ||
    row.disabled_at !== null ||
    row.owner_disabled_at !== null ||
    (row.principal_type !== "user" && row.principal_type !== "agent") ||
    row.owner_require_dpop === 1 ||
    row.dpop_jkt !== null
  )
    return null;
  const restrictions = parseTokenRestrictions(row.scopes, row.repo_ids);
  if (!restrictions) return null;
  const dependencies = [
    `credential:${row.id}`,
    ...(row.source_id ? [`credential:${row.source_id}`] : []),
    ...(row.source_source_id ? [`credential:${row.source_source_id}`] : []),
    `principal:${row.principal_id}:${row.lifecycle_gen}`,
    ...(row.owner_id !== null ? [`principal:${row.owner_id}:${row.owner_gen ?? 0}`] : []),
  ];
  return {
    id: row.id,
    principalId: row.principal_id,
    principalType: row.principal_type,
    expiresAt: row.expires_at,
    scopes: restrictions.scopes,
    repoIds: restrictions.repoIds,
    dependencies,
  };
}
