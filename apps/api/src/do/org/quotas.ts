/*
 * An account's quotas: how many repositories it may have, and how many
 * bytes its repositories' uploads may store. An upload holds storage in
 * two steps, each with a time limit: a reservation while it is stored (the
 * Worker stops at it), then a charge from its commit point until the
 * repository confirms the commit, when the bytes become the repository's
 * usage. A hold that lapses (an upload abandoned, a confirmation late)
 * counts nothing, so nothing is held for ever; the repository keeps a
 * committed upload's confirmation owed until it is taken (and each upload
 * counts once), so a lost one is told again rather than left uncounted.
 *
 * Release assets are counted otherwise: each repository states its total
 * (`setAssets`), and the newest statement replaces the last, so a repeat,
 * a reordering or a retry of any age changes nothing.
 */

/** Why a push is refused at its commit: the account's storage is used up. */
export const STORAGE_QUOTA_EXCEEDED = "the account's storage quota is used up";
/** Why a push is refused at its commit: the account's quota could not be checked. */
export const STORAGE_QUOTA_UNAVAILABLE = "the storage quota could not be checked; try again";

/**
 * How long a charge holds an upload's bytes before its commit is
 * confirmed: past the commit lock's wait and a retried finalize. Proposed.
 */
export const STORAGE_CHARGE_TTL_MS = 30 * 60 * 1000;

/** Limits that apply when the account sets none. Proposed; operators override them. */
export const QUOTA_DEFAULTS = {
  maxRepos: 1_000,
  maxStorageBytes: 1024 * 1024 * 1024,
} as const;

const VARIABLES = {
  maxRepos: "QUOTA_MAX_REPOS",
  maxStorageBytes: "QUOTA_MAX_STORAGE_BYTES",
} as const;

export interface QuotaLimits {
  readonly maxRepos: number;
  readonly maxStorageBytes: number;
}

export interface StorageStatus {
  readonly limits: QuotaLimits;
  /** Bytes the account's repositories' committed uploads and release assets stored. */
  readonly usedBytes: number;
  /** Bytes held by uploads being stored or committed. */
  readonly reservedBytes: number;
}

/** The instance's default limits: `QUOTA_DEFAULTS`, overridden by any Worker variable set. */
export function defaultLimits(env: object): QuotaLimits {
  const vars = env as Partial<Record<string, unknown>>;
  const out: Record<string, number> = { ...QUOTA_DEFAULTS };
  for (const [key, name] of Object.entries(VARIABLES)) {
    const raw = vars[name];
    const value = typeof raw === "string" || typeof raw === "number" ? Number(raw) : Number.NaN;
    if (Number.isSafeInteger(value) && value >= 0) out[key] = value;
  }
  return out as unknown as QuotaLimits;
}

/**
 * How long confirmations are remembered, so a repeated one counts once (a
 * repository gives up an owed one before this; see `STORAGE_OWED_MAX_AGE_MS`).
 */
export const CONFIRMED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export class AccountQuotas {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly defaults: QuotaLimits,
    private readonly now: () => number,
  ) {}

  /** The limits in force: the account's own, else the instance's. */
  limits(): QuotaLimits {
    const row = this.#limitsRow();
    return {
      maxRepos: row?.max_repos ?? this.defaults.maxRepos,
      maxStorageBytes: row?.max_storage_bytes ?? this.defaults.maxStorageBytes,
    };
  }

  /**
   * Sets the account's limits (null: the instance's again; absent: kept)
   * and runs `alongside` in the same transaction (its audit row).
   */
  setLimits(
    change: { readonly maxRepos?: number | null; readonly maxStorageBytes?: number | null },
    alongside: () => void,
  ): QuotaLimits {
    this.storage.transactionSync(() => {
      const keep = this.#limitsRow();
      this.storage.sql.exec(
        `INSERT INTO quota_limits (id, max_repos, max_storage_bytes, updated_at) VALUES (1, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET max_repos = excluded.max_repos,
           max_storage_bytes = excluded.max_storage_bytes, updated_at = excluded.updated_at`,
        change.maxRepos === undefined ? (keep?.max_repos ?? null) : change.maxRepos,
        change.maxStorageBytes === undefined
          ? (keep?.max_storage_bytes ?? null)
          : change.maxStorageBytes,
        this.now(),
      );
      alongside();
    });
    return this.limits();
  }

  status(): StorageStatus {
    return {
      limits: this.limits(),
      usedBytes: this.#used(),
      reservedBytes: this.#held(this.now(), []),
    };
  }

  /**
   * Reserves storage for an upload being stored: `bytes`, or with
   * `partial` as much of it as is free. Reserving again replaces the
   * upload's reservation; an upload already charged keeps its charge.
   * Returns the bytes reserved (0 when none are free).
   */
  reserve(input: {
    readonly uploadId: string;
    readonly repoId: string;
    readonly bytes: number;
    readonly ttlMs: number;
    readonly partial?: boolean;
  }): { reserved: number; freeBytes: number } {
    return this.storage.transactionSync(() => {
      const now = this.now();
      this.#dropLapsed(now);
      const free = this.#free(now, input.uploadId);
      const reserved = input.partial
        ? Math.min(input.bytes, free)
        : input.bytes <= free
          ? input.bytes
          : 0;
      if (reserved > 0)
        this.storage.sql.exec(
          `INSERT INTO quota_holds (upload_id, repo_id, kind, bytes, expires_at)
           VALUES (?, ?, 'reserved', ?, ?)
           ON CONFLICT (upload_id) DO UPDATE SET bytes = excluded.bytes,
             expires_at = excluded.expires_at WHERE kind = 'reserved'`,
          input.uploadId,
          input.repoId,
          reserved,
          now + input.ttlMs,
        );
      return { reserved, freeBytes: free };
    });
  }

  /**
   * At an upload's commit point: holds its stored bytes until the commit
   * is confirmed (its reservation becomes the charge). Charging again, or
   * after the confirmation, changes nothing. False when the bytes do not
   * fit (the upload's hold is dropped; the upload is refused).
   */
  charge(input: {
    readonly uploadId: string;
    readonly repoId: string;
    readonly bytes: number;
    readonly ttlMs: number;
  }): boolean {
    return this.storage.transactionSync(() => {
      const now = this.now();
      if (this.#confirmed(input.uploadId)) return true;
      this.#dropLapsed(now);
      const hold = this.#sql<{ kind: string }>(
        "SELECT kind FROM quota_holds WHERE upload_id = ?",
        input.uploadId,
      )[0];
      if (hold?.kind === "charged") return true;
      if (input.bytes > this.#free(now, input.uploadId)) {
        this.storage.sql.exec("DELETE FROM quota_holds WHERE upload_id = ?", input.uploadId);
        return false;
      }
      this.storage.sql.exec(
        `INSERT INTO quota_holds (upload_id, repo_id, kind, bytes, expires_at)
         VALUES (?, ?, 'charged', ?, ?)
         ON CONFLICT (upload_id) DO UPDATE SET kind = 'charged', bytes = excluded.bytes,
           expires_at = excluded.expires_at`,
        input.uploadId,
        input.repoId,
        input.bytes,
        now + input.ttlMs,
      );
      return true;
    });
  }

  /**
   * The upload committed: its bytes become its repository's usage, once
   * (whether or not its charge is still held).
   */
  confirm(input: {
    readonly uploadId: string;
    readonly repoId: string;
    readonly bytes: number;
  }): void {
    this.storage.transactionSync(() => {
      const now = this.now();
      // Counted already: any hold made for it since (a transfer's charge) holds nothing.
      if (this.#confirmed(input.uploadId)) {
        this.storage.sql.exec("DELETE FROM quota_holds WHERE upload_id = ?", input.uploadId);
        return;
      }
      this.storage.sql.exec(
        "INSERT INTO quota_confirmed (upload_id, confirmed_at) VALUES (?, ?)",
        input.uploadId,
        now,
      );
      this.storage.sql.exec(
        `INSERT INTO quota_usage (repo_id, bytes) VALUES (?, ?)
         ON CONFLICT (repo_id) DO UPDATE SET bytes = bytes + excluded.bytes`,
        input.repoId,
        input.bytes,
      );
      this.storage.sql.exec("DELETE FROM quota_holds WHERE upload_id = ?", input.uploadId);
      this.storage.sql.exec(
        "DELETE FROM quota_confirmed WHERE confirmed_at < ?",
        now - CONFIRMED_KEEP_MS,
      );
    });
  }

  /**
   * Holds `holds` together or not at all (a repository arriving by
   * transfer: its usage, reserved, and a charge for each upload it still
   * owes a confirmation of, which `confirm` turns into usage); false, with
   * nothing held, when they do not fit together.
   */
  holdAll(
    holds: readonly {
      readonly uploadId: string;
      readonly repoId: string;
      readonly kind: "reserved" | "charged";
      readonly bytes: number;
      readonly expiresAt: number;
    }[],
  ): boolean {
    return this.storage.transactionSync(() => {
      const now = this.now();
      this.#dropLapsed(now);
      const live = holds.filter((h) => h.bytes > 0);
      if (live.reduce((n, h) => n + h.bytes, 0) > this.#free(now, null)) return false;
      for (const h of live)
        this.storage.sql.exec(
          `INSERT INTO quota_holds (upload_id, repo_id, kind, bytes, expires_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (upload_id) DO UPDATE SET kind = excluded.kind, bytes = excluded.bytes,
             expires_at = excluded.expires_at`,
          h.uploadId,
          h.repoId,
          h.kind,
          h.bytes,
          h.expiresAt,
        );
      return true;
    });
  }

  /** An upload ended without committing: what it holds is free again. */
  release(uploadId: string): void {
    this.storage.sql.exec("DELETE FROM quota_holds WHERE upload_id = ?", uploadId);
  }

  /**
   * A repository's statement of its release assets' total: `stale` when an
   * older tuple than the last one taken (newer generation first, then
   * number); with `mustFit`, `no_room` when the account's other usage, its
   * holds but `dropReservations`', and `bytes` together exceed the limit (the
   * total, not the growth, is tested: an unchecked statement may have
   * carried these bytes already). Otherwise the total replaces the last
   * one, and `dropReservations`' holds go, in one transaction: the
   * sessions whose bytes the total counts.
   */
  setAssets(input: {
    readonly repoId: string;
    readonly bytes: number;
    readonly epochGen: number;
    readonly seq: number;
    readonly mustFit: boolean;
    readonly dropReservations?: readonly string[];
  }): "stale" | "no_room" | "ok" {
    return this.storage.transactionSync(() => {
      const last = this.#sql<{ bytes: number; epoch_gen: number; seq: number }>(
        "SELECT bytes, epoch_gen, seq FROM quota_assets WHERE repo_id = ?",
        input.repoId,
      )[0];
      if (
        last &&
        (last.epoch_gen > input.epochGen ||
          (last.epoch_gen === input.epochGen && last.seq > input.seq))
      )
        return "stale";
      if (input.mustFit) {
        const others =
          this.#used() - (last?.bytes ?? 0) + this.#held(this.now(), input.dropReservations ?? []);
        if (others + input.bytes > this.limits().maxStorageBytes) return "no_room";
      }
      this.storage.sql.exec(
        `INSERT INTO quota_assets (repo_id, bytes, epoch_gen, seq) VALUES (?, ?, ?, ?)
         ON CONFLICT (repo_id) DO UPDATE SET bytes = excluded.bytes,
           epoch_gen = excluded.epoch_gen, seq = excluded.seq`,
        input.repoId,
        input.bytes,
        input.epochGen,
        input.seq,
      );
      for (const holdId of input.dropReservations ?? []) this.release(holdId);
      return "ok";
    });
  }

  /**
   * An arriving repository's asset total, as its arrival stored it: taken
   * unless a newer tuple is here already, so a late, older total changes
   * nothing. In the transaction that ends the arrival's hold.
   */
  adoptAssets(
    repoId: string,
    total: { readonly bytes: number; readonly epochGen: number; readonly seq: number },
  ): void {
    this.storage.sql.exec(
      `INSERT INTO quota_assets (repo_id, bytes, epoch_gen, seq) VALUES (?, ?, ?, ?)
       ON CONFLICT (repo_id) DO UPDATE SET bytes = excluded.bytes,
         epoch_gen = excluded.epoch_gen, seq = excluded.seq
       WHERE (excluded.epoch_gen, excluded.seq) > (quota_assets.epoch_gen, quota_assets.seq)`,
      repoId,
      total.bytes,
      total.epochGen,
      total.seq,
    );
  }

  /** The bytes repository `repoId` last stated its release assets hold. */
  assetBytes(repoId: string): number {
    return (
      this.#sql<{ bytes: number }>("SELECT bytes FROM quota_assets WHERE repo_id = ?", repoId)[0]
        ?.bytes ?? 0
    );
  }

  /** A deleted repository's storage is free again. */
  forgetRepo(repoId: string): void {
    this.storage.sql.exec("DELETE FROM quota_usage WHERE repo_id = ?", repoId);
    this.storage.sql.exec("DELETE FROM quota_assets WHERE repo_id = ?", repoId);
    this.storage.sql.exec("DELETE FROM quota_holds WHERE repo_id = ?", repoId);
  }

  #limitsRow() {
    return this.#sql<{ max_repos: number | null; max_storage_bytes: number | null }>(
      "SELECT max_repos, max_storage_bytes FROM quota_limits WHERE id = 1",
    )[0];
  }

  #confirmed(uploadId: string): boolean {
    return (
      this.#sql("SELECT 1 AS one FROM quota_confirmed WHERE upload_id = ?", uploadId).length > 0
    );
  }

  /** Bytes free now, not counting what `exceptUpload` itself holds. */
  #free(now: number, exceptUpload: string | null): number {
    const { maxStorageBytes } = this.limits();
    const except = exceptUpload === null ? [] : [exceptUpload];
    return Math.max(0, maxStorageBytes - this.#used() - this.#held(now, except));
  }

  /** Bytes of committed uploads and release assets: a row of each per repository. */
  #used(): number {
    return (
      this.#sql<{ n: number }>(
        `SELECT (SELECT coalesce(sum(bytes), 0) FROM quota_usage)
           + (SELECT coalesce(sum(bytes), 0) FROM quota_assets) AS n`,
      )[0]?.n ?? 0
    );
  }

  /** Bytes live holds keep (uploads being stored or committed), but `except`'s. */
  #held(now: number, except: readonly string[]): number {
    return (
      this.#sql<{ n: number }>(
        `SELECT coalesce(sum(bytes), 0) AS n FROM quota_holds
         WHERE expires_at > ? AND upload_id NOT IN (SELECT value FROM json_each(?))`,
        now,
        JSON.stringify(except),
      )[0]?.n ?? 0
    );
  }

  #dropLapsed(now: number): void {
    this.storage.sql.exec("DELETE FROM quota_holds WHERE expires_at <= ?", now);
  }

  #sql<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): T[] {
    return this.storage.sql.exec<T>(query, ...bindings).toArray();
  }
}
