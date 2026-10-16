import type { PackId } from "@fyrden/git-core";
import type { JobHandler, JobQueue, SliceResult } from "./jobs.js";
import { packObjectKey } from "./keys.js";
import type { RepoGitStorage } from "./repo-git-storage.js";
import { countRowsWritten, first, type GitStorageContext, rows, run } from "./sql.js";

/*
 * The end of a pack's life. This
 * repository is the lifetime authority of its own packs, so it retires
 * them in two phases:
 *
 * 1. Condemn: a superseded pack (or a garbage pack, condemned by garbage
 *    collection) is marked `condemned`, after which no new lease on it is
 *    granted (`PackLeases.grant` refuses).
 * 2. Delete: once every lease that existed before the condemn has expired,
 *    the deletion fence passes, and the retention has passed (30 days from
 *    when the pack left the live set, matching Durable Object point-in-time
 *    recovery, so a restored registry still finds every pack it names), the
 *    R2 objects are deleted, then the row.
 *
 * The same job expires materialised fetch objects some time after their
 * last lease, and removes packs maintenance began but never finished (a
 * merge or repack whose run died) once they are old and unleased.
 *
 * In a fork network, a pack the network shares (a borrowed pack, or an own
 * pack another member borrows) is the network object's to delete: once
 * condemned here and unleased, this repository releases its claim on it
 * and drops its row, and never deletes its bytes (see `NetworkRetire`).
 *
 * Every step is safe to redo: rows change state in a transaction that
 * re-checks leases, R2 deletes come before the row deletes that record
 * them, and a condemned pack can gain no lease, so nothing can start
 * reading it between the last check and the delete.
 */

/** The retire job is one per repository, keyed by this id. */
export const RETIRE_JOB_ID = "retire-packs";

const DAY = 24 * 60 * 60 * 1000;

export interface DeletionFence {
  /**
   * Whether every repository whose view holds the pack has acknowledged it
   * as condemned (refuses new leases on it). A pack only this repository
   * reads needs no other acknowledgement; a fork network's packs are fenced
   * by its network object, which answers for its members.
   */
  acknowledged(packId: PackId): boolean | Promise<boolean>;
}

/** A pack as the network knows it: its id and the network it is stored under. */
export interface NetworkPackRef {
  readonly packId: PackId;
  readonly networkId: string;
}

/**
 * The fork network's side of retiring packs. A pack the network shares has
 * the network object as its lifetime authority.
 */
export interface NetworkRetire {
  /** Of `packs`, the ids their network shares (any member but this one may read them). */
  shared(packs: readonly NetworkPackRef[]): Promise<ReadonlySet<string>>;
  /** Gives up this repository's claims on `packs`: its view no longer holds them. */
  release(packs: readonly NetworkPackRef[]): Promise<void>;
}

export interface PackRetireOptions {
  /**
   * Time after a pack leaves the live set before its bytes may be deleted:
   * 30 days, as Durable Object point-in-time recovery reaches back 30 days
   * (design decision; the recovery window is documented by Cloudflare,
   * unverified here).
   */
  readonly retentionMs?: number;
  /** A materialised fetch object is deleted this long after its last lease. Proposed 1 h. */
  readonly fetchObjectTtlMs?: number;
  /** A maintenance output left unfinished this long (and unleased) is removed. Proposed 24 h. */
  readonly staleOutputTtlMs?: number;
  /** R2 objects deleted per slice. Proposed 100. */
  readonly maxDeletionsPerSlice?: number;
  /** Wall time per slice. Proposed 20 s, under the 30 s of CPU an alarm gets (measured on Workers Free, 2026-10-10). */
  readonly maxSliceMs?: number;
  /** Delay before the next slice of an unfinished pass. Proposed 1 s. */
  readonly continueAfterMs?: number;
  /** Delay before looking again at packs that were leased. Proposed 10 min (a fetch lease's term). */
  readonly recheckMs?: number;
  readonly fence?: DeletionFence;
  /**
   * The repository's fork network. Without it, borrowed packs are never
   * retired here and every condemned own pack is treated as unshared.
   */
  readonly network?: NetworkRetire;
  /**
   * Called in the transaction that deletes a pack's row (after its bytes
   * are deleted, or its claim released): drops what the repository records
   * of it outside the git storage tables.
   */
  readonly forget?: (packId: PackId) => void;
  /**
   * Called after a pack is chosen for deletion and before its bytes are
   * deleted (the gap a network-wide fence must survive). For tests.
   */
  readonly beforeDelete?: (packId: PackId) => Promise<void>;
}

export const PACK_RETIRE_DEFAULTS: Required<
  Omit<PackRetireOptions, "beforeDelete" | "network" | "forget">
> = {
  retentionMs: 30 * DAY,
  fetchObjectTtlMs: 60 * 60 * 1000,
  staleOutputTtlMs: DAY,
  maxDeletionsPerSlice: 100,
  maxSliceMs: 20_000,
  continueAfterMs: 1_000,
  recheckMs: 10 * 60 * 1000,
  fence: { acknowledged: () => true },
};

/** Schedules a retire pass at `at`, or earlier if one is already due sooner. */
export function schedulePackRetire(jobs: JobQueue, at: number): void {
  jobs.ensure("retire_packs", RETIRE_JOB_ID, { runAt: at });
}

type RawPack = {
  pack_id: string;
  network_id: string;
  r2_key: string;
  kind: string;
  state: string;
  origin: string;
};

/** No unexpired lease on the pack. */
const UNLEASED =
  "NOT EXISTS (SELECT 1 FROM leases l WHERE l.pack_id = p.pack_id AND l.expires_at > ?)";
/** Not owned by an upload still in flight (those go with their upload). */
const NO_OPEN_UPLOAD = `NOT EXISTS (SELECT 1 FROM uploads u
  WHERE u.upload_id = p.upload_id AND u.state <> 'committed')`;
const MAINTENANCE_OUTPUTS = "('compact', 'gc', 'garbage')";

/** Where a pack's retention starts: when it left the live set. */
const RETENTION_FROM = "coalesce(p.superseded_at, p.condemned_at)";

export function packRetireHandler(
  git: RepoGitStorage,
  options: PackRetireOptions = {},
): JobHandler {
  const config = { ...PACK_RETIRE_DEFAULTS, ...options };
  const retire = new PackRetire(git, config, options.beforeDelete);
  return { runSlice: () => retire.runSlice() };
}

type RetireConfig = Required<Omit<PackRetireOptions, "beforeDelete" | "network" | "forget">> &
  Pick<PackRetireOptions, "network" | "forget">;

class PackRetire {
  readonly #context: GitStorageContext;

  constructor(
    private readonly git: RepoGitStorage,
    private readonly config: RetireConfig,
    private readonly beforeDelete: ((packId: PackId) => Promise<void>) | undefined,
  ) {
    this.#context = git.context;
  }

  async runSlice(): Promise<SliceResult> {
    const deadline = this.#now() + this.config.maxSliceMs;
    let deletions = 0;
    const skipped = new Set<string>();
    const spent = () => deletions >= this.config.maxDeletionsPerSlice || this.#now() >= deadline;

    this.#condemnSuperseded();
    for (const step of [
      () => this.#nextBorrowed(skipped),
      () => this.#nextFetchObject(skipped),
      () => this.#nextStaleOutput(skipped),
      () => this.#nextDeletable(skipped),
    ]) {
      for (let pack = step(); pack; pack = step()) {
        if (spent()) return { done: false, cursor: null, runAfterMs: this.config.continueAfterMs };
        const removed = await this.#retire(pack);
        if (removed === 0) skipped.add(pack.pack_id);
        deletions += removed;
      }
    }
    return this.#nextPass();
  }

  #now(): number {
    return this.#context.now();
  }

  /**
   * Superseded packs are condemned at once: this repository reads them no
   * more (a pack its network shares is then released, not deleted, here).
   */
  #condemnSuperseded(): void {
    const { storage } = this.#context;
    const now = this.#now();
    const written = run(
      storage,
      `UPDATE packs SET state = 'condemned', condemned_at = ?, last_touched_at = ?
       WHERE state = 'superseded'`,
      now,
      now,
    );
    countRowsWritten(this.#context, "retire.condemn", written);
    this.#countMetric("condemned", written);
  }

  /** A condemned borrowed pack: its claim is released (only with a network to release it to). */
  #nextBorrowed(skipped: ReadonlySet<string>): RawPack | undefined {
    if (!this.config.network) return undefined;
    return this.#candidate(
      "p.state = 'condemned' AND p.origin = 'borrowed' AND p.last_touched_at <= ?",
      skipped,
      this.#now(),
    );
  }

  #nextFetchObject(skipped: ReadonlySet<string>): RawPack | undefined {
    return this.#candidate(
      `p.kind = 'fetch' AND p.state IN ('pending', 'indexing', 'discarded', 'condemned')
       AND p.last_touched_at <= ?`,
      skipped,
      this.#now() - this.config.fetchObjectTtlMs,
    );
  }

  #nextStaleOutput(skipped: ReadonlySet<string>): RawPack | undefined {
    return this.#candidate(
      `p.kind IN ${MAINTENANCE_OUTPUTS} AND p.state IN ('pending', 'indexing')
       AND p.created_at <= ? AND ${NO_OPEN_UPLOAD}`,
      skipped,
      this.#now() - this.config.staleOutputTtlMs,
    );
  }

  #nextDeletable(skipped: ReadonlySet<string>): RawPack | undefined {
    return this.#candidate(
      `p.state = 'condemned' AND p.origin = 'own' AND p.kind <> 'fetch'
       AND ${RETENTION_FROM} IS NOT NULL AND ${RETENTION_FROM} <= ?`,
      skipped,
      this.#now() - this.config.retentionMs,
    );
  }

  #candidate(where: string, skipped: ReadonlySet<string>, cutoff: number): RawPack | undefined {
    const found = rows<RawPack>(
      this.#context.storage,
      `SELECT p.pack_id, p.network_id, p.r2_key, p.kind, p.state, p.origin FROM packs p
       WHERE ${where} AND ${UNLEASED}
       ORDER BY p.pack_id LIMIT ?`,
      cutoff,
      this.#now(),
      skipped.size + 1,
    );
    return found.find((p) => !skipped.has(p.pack_id));
  }

  /**
   * Deletes one pack's bytes and row. A pack still in use is left alone:
   * returns the R2 objects deleted (0 when it was skipped).
   */
  async #retire(pack: RawPack): Promise<number> {
    const packId = pack.pack_id as PackId;
    if (pack.state === "condemned" && pack.kind !== "fetch" && (await this.#sharedPack(pack)))
      return this.#release(pack);
    const keys = packR2Keys(pack);
    if (!keys) return 0;
    if (pack.state === "condemned" && pack.kind !== "fetch") {
      if (!(await this.config.fence.acknowledged(packId))) return 0;
      await this.beforeDelete?.(packId);
    }
    // Synchronous with the checks: no lease can be granted in between, and
    // a condemned pack gets none afterwards.
    if (!this.#condemnIfUnleased(pack)) return 0;
    await this.git.bucket.delete(keys);
    const written = this.#deleteRow(packId, ["condemned", "discarded"]);
    countRowsWritten(this.#context, "retire.delete", written);
    if (pack.kind === "fetch") this.#countMetric("expired_fetch", 1);
    else if (pack.state === "condemned") this.#countMetric("deleted", 1);
    else this.#countMetric("stale_output", 1);
    return keys.length;
  }

  /** Whether the network shares the pack, so its bytes are the network's to delete. */
  async #sharedPack(pack: RawPack): Promise<boolean> {
    const { network } = this.config;
    if (!network) return false;
    if (pack.origin === "borrowed") return true;
    const ref = { packId: pack.pack_id as PackId, networkId: pack.network_id };
    return (await network.shared([ref])).has(pack.pack_id);
  }

  /**
   * Releases this repository's claim on a condemned pack its network
   * shares, then drops the row; the bytes stay for the network to delete.
   * Returns 1 when the row is gone, 0 when the pack was skipped (leased).
   */
  async #release(pack: RawPack): Promise<number> {
    const network = this.config.network as NetworkRetire;
    if (!this.#condemnIfUnleased(pack)) return 0;
    // Condemned and unleased: no new lease can be granted from here on.
    await network.release([{ packId: pack.pack_id as PackId, networkId: pack.network_id }]);
    const written = this.#deleteRow(pack.pack_id, ["condemned"]);
    countRowsWritten(this.#context, "retire.release", written);
    this.#countMetric("released", 1);
    return 1;
  }

  /**
   * In one transaction: the pack's leases, and its row while it is in one
   * of `states`, with what else records it (`forget`). Returns the rows
   * written.
   */
  #deleteRow(packId: string, states: readonly string[]): number {
    const { storage } = this.#context;
    return storage.transactionSync(() => {
      const leases = run(storage, "DELETE FROM leases WHERE pack_id = ?", packId);
      const row = run(
        storage,
        "DELETE FROM packs WHERE pack_id = ? AND state IN (SELECT value FROM json_each(?))",
        packId,
        JSON.stringify(states),
      );
      if (row > 0) this.config.forget?.(packId as PackId);
      return leases + row;
    });
  }

  /**
   * Re-checks the pack in one transaction: unleased, and still in a state
   * this pass may delete. A condemned pack stays condemned; a fetch object
   * is condemned (no new leases, and no fetch finds it again); a stale
   * output is discarded. False when anything changed.
   */
  #condemnIfUnleased(pack: RawPack): boolean {
    const { storage } = this.#context;
    const now = this.#now();
    return storage.transactionSync(() => {
      const leased = first(
        storage,
        "SELECT 1 AS one FROM leases WHERE pack_id = ? AND expires_at > ?",
        pack.pack_id,
        now,
      );
      if (leased) return false;
      const current = first<{ state: string }>(
        storage,
        "SELECT state FROM packs WHERE pack_id = ?",
        pack.pack_id,
      );
      if (current?.state !== pack.state) return false;
      if (pack.state === "condemned" || pack.state === "discarded") return true;
      const to = pack.kind === "fetch" && pack.state === "indexing" ? "condemned" : "discarded";
      return this.git.registry.transition(pack.pack_id, [pack.state as never], to) > 0;
    });
  }

  /** Schedules the next pass when the earliest remaining candidate comes due; done when none is left. */
  #nextPass(): SliceResult {
    const { storage } = this.#context;
    const now = this.#now();
    const at = (query: string, ...bindings: unknown[]) =>
      first<{ at: number | null }>(storage, query, ...bindings)?.at ?? null;
    const due = [
      at(
        `SELECT min(last_touched_at) + ? AS at FROM packs p WHERE kind = 'fetch'
         AND state IN ('pending', 'indexing', 'discarded', 'condemned')`,
        this.config.fetchObjectTtlMs,
      ),
      at(
        `SELECT min(created_at) + ? AS at FROM packs p WHERE kind IN ${MAINTENANCE_OUTPUTS}
         AND state IN ('pending', 'indexing') AND ${NO_OPEN_UPLOAD}`,
        this.config.staleOutputTtlMs,
      ),
      at(
        `SELECT min(${RETENTION_FROM}) + ? AS at FROM packs p
         WHERE state = 'condemned' AND origin = 'own' AND kind <> 'fetch'`,
        this.config.retentionMs,
      ),
      this.config.network
        ? at(
            `SELECT min(last_touched_at) AS at FROM packs p
             WHERE state = 'condemned' AND origin = 'borrowed'`,
          )
        : null,
    ].filter((t): t is number => t !== null);
    if (due.length === 0) return { done: true };
    const next = Math.min(...due);
    // Due now means it was skipped (leased, or the fence held): look again later.
    return {
      done: false,
      cursor: null,
      runAfterMs: next > now ? next - now : this.config.recheckMs,
    };
  }

  #countMetric(what: string, n: number): void {
    if (n > 0) this.#context.metrics.count("git.maintenance", { job: "retire", what }, n);
  }
}

/**
 * The R2 objects of a pack: its stored object, and its `.idx` when it is a
 * pack under the pack prefix. Undefined for a row whose ids or key are not
 * valid, which is left alone.
 */
export function packR2Keys(
  pack: Pick<RawPack, "pack_id" | "network_id" | "r2_key" | "kind">,
): string[] | undefined {
  try {
    const packKey = packObjectKey(pack.network_id, pack.pack_id, "pack");
    if (pack.r2_key === packKey)
      return [packKey, packObjectKey(pack.network_id, pack.pack_id, "idx")];
    if (pack.kind === "fetch" && pack.r2_key.startsWith(`net/${pack.network_id}/fetch/`))
      return [pack.r2_key];
    return undefined;
  } catch {
    return undefined;
  }
}
