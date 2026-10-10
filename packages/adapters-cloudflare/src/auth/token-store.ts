import {
  type Clock,
  generateToken,
  hashToken,
  type IdFactory,
  type PrincipalType,
  parseToken,
  type RandomBytes,
  type TokenType,
} from "@fyrden/domain";
import type { Metrics } from "../obs/metrics.js";
import { TokenCache } from "./token-cache.js";

export interface TokenRecord {
  id: string;
  type: TokenType;
  principalId: string;
  principalType: PrincipalType;
  principalHandle: string | null;
  isInstanceAdmin: boolean;
  scopes: string[];
  /** Repos the token is limited to; null means every repo the principal can reach. */
  repoIds: string[] | null;
  expiresAt: number;
  lastUsedAt: number | null;
}

export type VerifyFailure =
  | "malformed"
  | "bad_checksum"
  | "unknown"
  | "expired"
  | "revoked"
  | "disabled";
export type VerifyResult = { ok: true; record: TokenRecord } | { ok: false; reason: VerifyFailure };

/**
 * Read paths may use the isolate cache. Write paths (push, merge, admin, every
 * ref-moving operation) always read the D1 primary, so revocation is
 * immediate for writes.
 */
export type VerifyMode = "read" | "write";

export interface MintInput {
  principalId: string;
  type: TokenType;
  scopes: string[];
  repoIds?: string[] | null;
  ttlMs: number;
  audit: AuditContext;
}

export interface AuditContext {
  actorId: string | null;
  act?: string[];
  requestId?: string;
}

export interface TokenStoreDeps {
  clock: Clock;
  newId: IdFactory;
  randomBytes: RandomBytes;
  /** Defers best-effort writes past the response (ExecutionContext.waitUntil). */
  defer?: (promise: Promise<unknown>) => void;
  cache?: TokenCache<TokenRecord>;
  /** Shared per isolate, like the cache. */
  ledger?: TouchLedger;
  /** Counts D1 statements for the cost dashboard. */
  metrics?: Metrics;
}

/** `last_used_at` is written at most this often per token and isolate. */
export const LAST_USED_INTERVAL_MS = 10 * 60 * 1000;

interface TokenRow {
  id: string;
  type: TokenType;
  principal_id: string;
  principal_type: PrincipalType;
  handle: string | null;
  is_instance_admin: number;
  disabled_at: number | null;
  scopes: string;
  repo_ids: string | null;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

/**
 * When this isolate last scheduled a `last_used_at` write per token id. Kept
 * apart from the record cache so concurrent lookups returning a stale
 * `last_used_at` cannot schedule a second write in the same interval.
 */
export class TouchLedger {
  private readonly touched = new Map<string, number>();

  constructor(private readonly maxEntries = 10_000) {}

  /** Reserves the write; true only for the first caller in an interval. */
  reserve(tokenId: string, now: number, lastUsedAt: number | null): boolean {
    const last = Math.max(
      this.touched.get(tokenId) ?? Number.NEGATIVE_INFINITY,
      lastUsedAt ?? Number.NEGATIVE_INFINITY,
    );
    if (now - last < LAST_USED_INTERVAL_MS) return false;
    this.touched.delete(tokenId);
    this.touched.set(tokenId, now);
    while (this.touched.size > this.maxEntries) {
      const oldest = this.touched.keys().next().value;
      if (oldest === undefined) break;
      this.touched.delete(oldest);
    }
    return true;
  }
}

export class D1TokenStore {
  private readonly cache: TokenCache<TokenRecord>;
  private readonly ledger: TouchLedger;

  constructor(
    private readonly db: D1Database,
    private readonly deps: TokenStoreDeps,
  ) {
    this.cache = deps.cache ?? new TokenCache(deps.clock);
    this.ledger = deps.ledger ?? new TouchLedger();
  }

  /**
   * Creates a token and its audit row in one batch. The plaintext token is
   * returned once and never stored.
   */
  async mint(input: MintInput): Promise<{ token: string; id: string; expiresAt: number }> {
    if (!(input.ttlMs > 0)) throw new RangeError("token TTL must be positive");
    const token = generateToken(input.type, this.deps.randomBytes);
    const id = this.deps.newId("tok");
    const now = this.deps.clock();
    const expiresAt = now + input.ttlMs;
    this.countQuery("token_mint", 2);
    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO tokens (id, token_hash, type, principal_id, scopes, repo_ids, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          id,
          await hashToken(token),
          input.type,
          input.principalId,
          JSON.stringify(input.scopes),
          input.repoIds ? JSON.stringify(input.repoIds) : null,
          expiresAt,
          now,
        ),
      auditStatement(this.db, now, input.audit, "token.mint", id, {
        type: input.type,
        principalId: input.principalId,
      }),
    ]);
    return { token, id, expiresAt };
  }

  async verify(token: string, mode: VerifyMode): Promise<VerifyResult> {
    const parsed = parseToken(token);
    if (!parsed.ok) return parsed;
    const hash = await hashToken(token);
    const now = this.deps.clock();

    if (mode === "read") {
      const cached = this.cache.get(hash);
      if (cached)
        return cached.expiresAt > now
          ? this.touch(hash, cached, now)
          : { ok: false, reason: "expired" };
    }

    // Write paths skip the cache and read the primary even if read replicas are on.
    this.countQuery("token_lookup");
    const source = mode === "write" ? this.db.withSession("first-primary") : this.db;
    const row = await source
      .prepare(
        `SELECT t.id, t.type, t.principal_id, p.type AS principal_type, p.handle, p.is_instance_admin,
                p.disabled_at, t.scopes, t.repo_ids, t.expires_at, t.last_used_at, t.revoked_at
         FROM tokens t JOIN principals p ON p.id = t.principal_id
         WHERE t.token_hash = ?`,
      )
      .bind(hash)
      .first<TokenRow>();

    // Judge expiry at the time the answer arrived, not when the lookup began.
    const answeredAt = this.deps.clock();
    const failure: VerifyFailure | undefined = !row
      ? "unknown"
      : row.revoked_at !== null
        ? "revoked"
        : row.disabled_at !== null
          ? "disabled"
          : row.expires_at <= answeredAt
            ? "expired"
            : undefined;
    if (!row || failure) {
      this.cache.delete(hash);
      return { ok: false, reason: failure ?? "unknown" };
    }

    const record: TokenRecord = {
      id: row.id,
      type: row.type,
      principalId: row.principal_id,
      principalType: row.principal_type,
      principalHandle: row.handle,
      isInstanceAdmin: row.is_instance_admin === 1,
      scopes: JSON.parse(row.scopes) as string[],
      repoIds: row.repo_ids === null ? null : (JSON.parse(row.repo_ids) as string[]),
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
    };
    // Freshness counts from `now`, when this lookup started.
    this.cache.set(hash, record, now);
    return this.touch(hash, record, answeredAt);
  }

  /** Revokes a token and records it in the audit log in one batch. */
  async revoke(id: string, audit: AuditContext): Promise<boolean> {
    const now = this.deps.clock();
    this.countQuery("token_revoke", 2);
    const [update] = await this.db.batch([
      this.db
        .prepare("UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .bind(now, id),
      auditStatement(this.db, now, audit, "token.revoke", id, null),
    ]);
    return (update?.meta.changes ?? 0) > 0;
  }

  /** Drops a cached record, e.g. after this isolate revoked the token. */
  forget(token: string): Promise<void> {
    return hashToken(token).then((hash) => this.cache.delete(hash));
  }

  private countQuery(op: string, statements = 1): void {
    this.deps.metrics?.count("d1.query", { db: "directory", op }, statements);
  }

  private touch(hash: string, record: TokenRecord, now: number): VerifyResult {
    if (this.ledger.reserve(record.id, now, record.lastUsedAt)) {
      const touched = { ...record, lastUsedAt: now };
      // update() keeps the entry's original expiry: activity never extends
      // how long a cached authorization stays valid.
      this.cache.update(hash, touched);
      this.countQuery("token_touch");
      const write = this.db
        .prepare(
          "UPDATE tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)",
        )
        .bind(now, record.id, now - LAST_USED_INTERVAL_MS + 1)
        .run();
      if (this.deps.defer) this.deps.defer(write);
      else void write.catch(() => {});
      return { ok: true, record: touched };
    }
    return { ok: true, record };
  }
}

export function auditStatement(
  db: D1Database,
  at: number,
  audit: AuditContext,
  action: string,
  targetId: string | null,
  details: Record<string, unknown> | null,
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO audit_log (at, actor_id, act_chain, action, target_id, details, request_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      at,
      audit.actorId,
      audit.act ? JSON.stringify(audit.act) : null,
      action,
      targetId,
      details ? JSON.stringify(details) : null,
      audit.requestId ?? null,
    );
}
