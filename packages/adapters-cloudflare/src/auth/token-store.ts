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
  /** Whose rights the token uses: its principal, or for a delegated token the user acted for. */
  principalId: string;
  /**
   * The type of the principal making the call: for a delegated token,
   * `agent` (principal-type rules apply to the agent, never to the user).
   */
  principalType: PrincipalType;
  principalHandle: string | null;
  isInstanceAdmin: boolean;
  scopes: string[];
  /** Repos the token is limited to; null means every repo the principal can reach. */
  repoIds: string[] | null;
  expiresAt: number;
  lastUsedAt: number | null;
  /**
   * For a delegated token: the agents acting, the current one first (an
   * RFC 8693 `act` chain); empty otherwise.
   */
  act: string[];
  /** For a delegated token, the delegation grant it was issued under; null otherwise. */
  grantId: string | null;
  /**
   * Owners of the agents acting (an agent's own token, or every agent of a
   * delegated token's chain): each one's rights cap the token's.
   */
  ceilingIds: string[];
}

export type VerifyFailure =
  | "malformed"
  | "bad_checksum"
  | "unknown"
  | "expired"
  | "revoked"
  | "disabled";
export type VerifyResult =
  | { ok: true; record: TokenRecord }
  | {
      ok: false;
      reason: VerifyFailure;
      /**
       * For a token found expired on the D1 primary, what it holds now: a
       * commit that started before the expiry is judged on it.
       */
      expiredRecord?: TokenRecord;
    };

/**
 * A token's stored scopes and repository list (JSON columns), or undefined
 * when either is not a list of strings: such a row grants nothing, rather
 * than reading as "no scopes" (the principal's full rights).
 */
export function parseTokenRestrictions(
  scopes: string,
  repoIds: string | null,
): { scopes: string[]; repoIds: string[] | null } | undefined {
  const list = (json: string): string[] | undefined => {
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      return undefined;
    }
    return Array.isArray(value) && value.every((v) => typeof v === "string") ? value : undefined;
  };
  const parsedScopes = list(scopes);
  const parsedRepoIds = repoIds === null ? null : list(repoIds);
  if (parsedScopes === undefined || parsedRepoIds === undefined) return undefined;
  return { scopes: parsedScopes, repoIds: parsedRepoIds };
}

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
  /** The latest the token may expire (Unix ms), whatever `ttlMs` says. */
  notAfter?: number;
  audit: AuditContext;
  /** A delegated token: the grant it is issued under and the agents acting (the current one first). */
  delegation?: { readonly grantId: string; readonly act: readonly string[] };
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
  owner_id: string | null;
  owner_disabled_at: number | null;
  scopes: string;
  repo_ids: string | null;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  grant_id: string | null;
  act_chain: string | null;
}

/** One grant of a delegated token's chain, with its agent and the agent's owner. */
export interface GrantLink {
  id: string;
  agent_id: string;
  parent_id: string | null;
  expires_at: number;
  revoked_at: number | null;
  agent_disabled_at: number | null;
  owner_id: string;
  owner_disabled_at: number | null;
}

/** A grant and its parent (a delegated token's chain), with their agents and owners. */
export async function readGrantLinks(
  source: D1Database | D1DatabaseSession,
  grantId: string,
): Promise<GrantLink[]> {
  const { results } = await source
    .prepare(
      `SELECT g.id, g.agent_id, g.parent_id, g.expires_at, g.revoked_at,
              a.disabled_at AS agent_disabled_at, a.owner_id, o.disabled_at AS owner_disabled_at
       FROM grants g JOIN principals a ON a.id = g.agent_id
       JOIN principals o ON o.id = a.owner_id
       WHERE g.id = ?1 OR g.id = (SELECT parent_id FROM grants WHERE id = ?1)`,
    )
    .bind(grantId)
    .all<GrantLink>();
  return results;
}

/** What a delegated token's grants add to its record, or undefined when the chain no longer holds. */
export type Delegation = { act: string[]; grantId: string; ceilingIds: string[] };

function toRecord(
  row: TokenRow,
  restrictions: { scopes: string[]; repoIds: string[] | null },
  delegation: Delegation | null,
): TokenRecord {
  return {
    id: row.id,
    type: row.type,
    principalId: row.principal_id,
    principalType: delegation ? "agent" : row.principal_type,
    principalHandle: row.handle,
    // Never delegated.
    isInstanceAdmin: !delegation && row.is_instance_admin === 1,
    ...restrictions,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    act: delegation?.act ?? [],
    grantId: delegation?.grantId ?? null,
    ceilingIds: delegation?.ceilingIds ?? (row.owner_id === null ? [] : [row.owner_id]),
  };
}

/**
 * A delegated token's chain, checked against its grants: every grant live
 * (not revoked, not expired at `now`), every agent and owner enabled, and
 * the act chain the grants' agents (the token's grant's first, then its
 * parent's). Undefined when any of that fails.
 */
export function delegationOf(
  grantId: string,
  actChain: string,
  links: readonly GrantLink[],
  now: number,
): Delegation | undefined {
  let act: unknown;
  try {
    act = JSON.parse(actChain);
  } catch {
    return undefined;
  }
  if (!Array.isArray(act) || !act.every((a) => typeof a === "string")) return undefined;
  const chain: GrantLink[] = [];
  let next: string | null = grantId;
  while (next !== null) {
    const link = links.find((l) => l.id === next);
    if (!link || chain.includes(link)) return undefined;
    chain.push(link);
    next = link.parent_id;
  }
  const live = chain.every(
    (l) =>
      l.revoked_at === null &&
      l.expires_at > now &&
      l.agent_disabled_at === null &&
      l.owner_disabled_at === null,
  );
  if (!live || act.length !== chain.length) return undefined;
  if (chain.some((l, i) => l.agent_id !== act[i])) return undefined;
  return { act, grantId, ceilingIds: chain.map((l) => l.owner_id) };
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
    const expiresAt = Math.min(now + input.ttlMs, input.notAfter ?? Number.POSITIVE_INFINITY);
    if (expiresAt <= now) throw new RangeError("the token would expire before it is issued");
    this.countQuery("token_mint", 2);
    const { delegation } = input;
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO tokens (id, token_hash, type, principal_id, scopes, repo_ids, expires_at,
             created_at, grant_id, act_chain) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          delegation?.grantId ?? null,
          delegation ? JSON.stringify(delegation.act) : null,
        ),
      auditStatement(this.db, now, input.audit, "token.mint", id, {
        type: input.type,
        principalId: input.principalId,
        ...(delegation && { grantId: delegation.grantId, act: delegation.act }),
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
                p.disabled_at, p.owner_id, o.disabled_at AS owner_disabled_at, t.scopes,
                t.repo_ids, t.expires_at, t.last_used_at, t.revoked_at, t.grant_id, t.act_chain
         FROM tokens t JOIN principals p ON p.id = t.principal_id
         LEFT JOIN principals o ON o.id = p.owner_id
         WHERE t.token_hash = ?`,
      )
      .bind(hash)
      .first<TokenRow>();
    // A delegated token holds only while its grants and agents do.
    const links =
      row?.grant_id && row.revoked_at === null ? await this.grantLinks(source, row.grant_id) : [];

    // Judge expiry at the time the answer arrived, not when the lookup began.
    const answeredAt = this.deps.clock();
    const restrictions = row && parseTokenRestrictions(row.scopes, row.repo_ids);
    const delegation =
      row?.grant_id && row.act_chain !== null
        ? delegationOf(row.grant_id, row.act_chain, links, answeredAt)
        : null;
    const failure: VerifyFailure | undefined = !row
      ? "unknown"
      : row.revoked_at !== null || delegation === undefined
        ? "revoked"
        : row.disabled_at !== null || row.owner_disabled_at !== null
          ? "disabled"
          : !restrictions
            ? "unknown"
            : row.expires_at <= answeredAt
              ? "expired"
              : undefined;
    if (!row || !restrictions || delegation === undefined || failure) {
      this.cache.delete(hash);
      return failure === "expired" &&
        mode === "write" &&
        row &&
        restrictions &&
        delegation !== undefined
        ? { ok: false, reason: failure, expiredRecord: toRecord(row, restrictions, delegation) }
        : { ok: false, reason: failure ?? "unknown" };
    }

    const record = toRecord(row, restrictions, delegation);
    // Freshness counts from `now`, when this lookup started.
    this.cache.set(hash, record, now);
    return this.touch(hash, record, answeredAt);
  }

  /** A grant and its parent (a delegated token's chain), with their agents and owners. */
  private grantLinks(
    source: D1Database | D1DatabaseSession,
    grantId: string,
  ): Promise<GrantLink[]> {
    this.countQuery("token_grants");
    return readGrantLinks(source, grantId);
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
