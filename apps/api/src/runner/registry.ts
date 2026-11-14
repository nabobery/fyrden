// Self-hosted runners in the D1 directory: registration tokens, runners and
// their credentials (each stored as its SHA-256 only).

import type { Metrics } from "@fyrden/adapters-cloudflare/obs";

/** A runner as its credentials prove it. */
export interface AuthenticatedRunner {
  readonly id: number;
  readonly uuid: string;
  readonly accountId: string;
  readonly name: string;
  readonly version: string;
  readonly labels: readonly string[];
  readonly ephemeral: boolean;
}

/** A runner as the list operation shows it. */
export interface ListedRunner {
  readonly id: number;
  readonly name: string;
  readonly labels: string[];
  readonly version: string;
  readonly ephemeral: boolean;
  readonly createdAt: number;
  readonly declaredAt: number | null;
  readonly revokedAt: number | null;
}

interface RunnerRow {
  id: number;
  uuid: string;
  account_id: string;
  token_hash: string;
  name: string;
  version: string;
  labels: string;
  ephemeral: number;
  created_at: number;
  declared_at: number | null;
  revoked_at: number | null;
  expires_at: number | null;
}

const count = (metrics: Metrics | undefined, op: string) =>
  metrics?.count("d1.query", { db: "directory", op });

/** Records a registration token (by its hash) that registers one runner for `accountId` until `expiresAt`. */
export async function createRegistration(
  db: D1Database,
  registration: {
    tokenHash: string;
    accountId: string;
    createdBy: string;
    now: number;
    expiresAt: number;
  },
  metrics?: Metrics,
): Promise<void> {
  count(metrics, "runner_registration_create");
  await db
    .prepare(
      `INSERT INTO ci_runner_registrations (token_hash, account_id, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      registration.tokenHash,
      registration.accountId,
      registration.createdBy,
      registration.now,
      registration.expiresAt,
    )
    .run();
}

/**
 * Consumes the registration token whose hash is `registrationHash`, if it is
 * unused and unexpired at `now`, and registers the runner for its account,
 * in one batch: the consumption stamps the registration with `nonce`, and the
 * runner is inserted only from the row bearing it, so a batch that lost a race
 * for the token inserts nothing. Undefined when the token was unknown, spent
 * or expired.
 */
export async function registerRunner(
  db: D1Database,
  runner: {
    registrationHash: string;
    nonce: string;
    now: number;
    uuid: string;
    tokenHash: string;
    name: string;
    version: string;
    labels: readonly string[];
    ephemeral: boolean;
  },
  metrics?: Metrics,
): Promise<{ id: number; accountId: string } | undefined> {
  count(metrics, "runner_register");
  const [, inserted] = await db.batch([
    db
      .prepare(
        `UPDATE ci_runner_registrations SET consumed_at = ?1, consume_nonce = ?2
         WHERE token_hash = ?3 AND consumed_at IS NULL AND expires_at > ?1`,
      )
      .bind(runner.now, runner.nonce, runner.registrationHash),
    db
      .prepare(
        `INSERT INTO ci_runners (uuid, account_id, token_hash, name, version, labels, ephemeral, created_at)
         SELECT ?1, account_id, ?2, ?3, ?4, ?5, ?6, ?7 FROM ci_runner_registrations
         WHERE token_hash = ?8 AND consume_nonce = ?9
         RETURNING id, account_id`,
      )
      .bind(
        runner.uuid,
        runner.tokenHash,
        runner.name,
        runner.version,
        JSON.stringify(runner.labels),
        runner.ephemeral ? 1 : 0,
        runner.now,
        runner.registrationHash,
        runner.nonce,
      ),
  ]);
  const row = inserted?.results[0] as { id: number; account_id: string } | undefined;
  return row && { id: row.id, accountId: row.account_id };
}

/**
 * The runner `uuid` whose credential hashes to `tokenHash`, if it is neither
 * revoked nor past its end at `now`: one read of the primary, so a deletion
 * takes effect on the runner's next call.
 */
export async function authenticateRunner(
  db: D1Database,
  credentials: { uuid: string; tokenHash: string; now: number },
  metrics?: Metrics,
): Promise<AuthenticatedRunner | undefined> {
  count(metrics, "runner_authenticate");
  const row = await db
    .withSession("first-primary")
    .prepare(
      `SELECT id, uuid, account_id, token_hash, name, version, labels, ephemeral, revoked_at, expires_at
       FROM ci_runners WHERE uuid = ?`,
    )
    .bind(credentials.uuid)
    .first<RunnerRow>();
  if (!row || !sameHash(row.token_hash, credentials.tokenHash)) return undefined;
  if (row.revoked_at !== null) return undefined;
  if (row.expires_at !== null && row.expires_at <= credentials.now) return undefined;
  return {
    id: row.id,
    uuid: row.uuid,
    accountId: row.account_id,
    name: row.name,
    version: row.version,
    labels: parseLabels(row.labels),
    ephemeral: row.ephemeral === 1,
  };
}

/** Compares two hex hashes in time that does not depend on where they differ. */
function sameHash(stored: string, presented: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(stored);
  const b = encoder.encode(presented);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

/** Records what a runner declared when its daemon started. */
export async function declareRunner(
  db: D1Database,
  declared: { id: number; version: string; labels: readonly string[]; now: number },
  metrics?: Metrics,
): Promise<void> {
  count(metrics, "runner_declare");
  await db
    .prepare("UPDATE ci_runners SET version = ?, labels = ?, declared_at = ? WHERE id = ?")
    .bind(declared.version, JSON.stringify(declared.labels), declared.now, declared.id)
    .run();
}

/** Up to `limit` of an account's runners after the runner `afterId`, oldest first. */
export async function listRunners(
  db: D1Database,
  page: { accountId: string; afterId: number; limit: number },
  metrics?: Metrics,
): Promise<ListedRunner[]> {
  count(metrics, "runners_list");
  const { results } = await db
    .withSession("first-primary")
    .prepare(
      `SELECT id, name, labels, version, ephemeral, created_at, declared_at, revoked_at
       FROM ci_runners WHERE account_id = ? AND id > ? ORDER BY id LIMIT ?`,
    )
    .bind(page.accountId, page.afterId, page.limit)
    .all<Omit<RunnerRow, "uuid" | "account_id" | "token_hash" | "expires_at">>();
  return results.map((row) => ({
    id: row.id,
    name: row.name,
    labels: parseLabels(row.labels),
    version: row.version,
    ephemeral: row.ephemeral === 1,
    createdAt: row.created_at,
    declaredAt: row.declared_at,
    revokedAt: row.revoked_at,
  }));
}

/**
 * Revokes the account's runner `id` at `now` (a runner revoked already keeps
 * its first time). False when the account has no such runner.
 */
export async function revokeRunner(
  db: D1Database,
  revoked: { accountId: string; id: number; now: number },
  metrics?: Metrics,
): Promise<boolean> {
  count(metrics, "runner_revoke");
  const result = await db
    .prepare(
      "UPDATE ci_runners SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND account_id = ?",
    )
    .bind(revoked.now, revoked.id, revoked.accountId)
    .run();
  return result.meta.changes > 0;
}

function parseLabels(json: string): string[] {
  const labels: unknown = JSON.parse(json);
  return Array.isArray(labels) ? labels.filter((l): l is string => typeof l === "string") : [];
}
