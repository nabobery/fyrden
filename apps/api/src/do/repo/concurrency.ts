import type { RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import {
  acquire,
  type ConcurrencyContext,
  concurrencyGroupKey,
  type GroupState,
  type Outcome,
  type OwnerRef,
  type Receipt,
  type ReceiptOutcome,
  release,
  renewScope,
  type SignalKind,
  settle,
  withHold,
} from "@fyrden/domain/ci";

/*
 * Concurrency groups of Fyrden's runs in this repository: the registry the
 * domain's rules (`ci/concurrency.ts`) run against, one transaction per
 * call, with each request's receipt, each run's lease (shared by its
 * scopes) and the signals owed to run objects. Calls hold no await.
 */

/** A lease's length. Proposed: 10 minutes. */
export const CONCURRENCY_LEASE_MS = 10 * 60_000;
/** The longest a signal's delivery backs off. Proposed: 30 minutes. */
export const SIGNAL_BACKOFF_MAX_MS = 30 * 60_000;
/** Signals one slice delivers at most. */
export const SIGNALS_PER_SLICE = 50;

export interface ConcurrencyRequest {
  readonly group: string;
  readonly runId: string;
  readonly ownerKey: string;
  readonly cancelInProgress: boolean;
  readonly holdMs: number;
}

/** A receipt as the run object sees it: with the grant's remaining time while it owns. */
export interface ReceiptAnswer {
  readonly outcome: ReceiptOutcome;
  readonly generation: number | null;
  /** While it owns: how long its grant runs from when the repository answered. */
  readonly leaseRemainingMs: number | null;
  readonly cancelRequested: boolean;
}

export interface RenewScope {
  readonly group: string;
  readonly ownerKey: string;
  readonly generation: number;
  readonly holdMs?: number;
}

export type RenewAnswer =
  | { readonly ok: true; readonly leaseRemainingMs: number; readonly cancelRequested: boolean }
  | { readonly ok: false; readonly receipt: ReceiptAnswer | null };

export interface SignalRow {
  readonly run_id: string;
  readonly owner_key: string;
  readonly group_key: string;
  readonly kind: SignalKind;
  readonly generation: number;
  readonly attempts: number;
}

type GroupRow = {
  group_key: string;
  group_name: string;
  owner_run: string | null;
  owner_key: string | null;
  generation: number | null;
  hold_ms: number | null;
  cancel_requested_at: number | null;
  release_deadline: number | null;
  pending_run: string | null;
  pending_key: string | null;
  pending_since: number | null;
  pending_hold_ms: number | null;
};

const groupKey = concurrencyGroupKey;

export class RepoConcurrency {
  constructor(
    private readonly deps: {
      readonly git: RepoGitStorage;
      /** Wakes the delivery and settling job at `at`. */
      readonly wake: (at: number) => void;
    },
  ) {}

  #sql<T>(query: string, ...bindings: (string | number | null)[]): T[] {
    return this.deps.git.context.storage.sql.exec(query, ...bindings).toArray() as T[];
  }

  #now(): number {
    return this.deps.git.context.now();
  }

  #context(now: number): ConcurrencyContext {
    return {
      now,
      leaseMs: CONCURRENCY_LEASE_MS,
      nextGeneration: () => {
        this.#sql(
          `INSERT INTO ci_meta (id, generation) VALUES (1, 1)
           ON CONFLICT (id) DO UPDATE SET generation = generation + 1`,
        );
        return this.#sql<{ generation: number }>("SELECT generation FROM ci_meta WHERE id = 1")[0]
          ?.generation as number;
      },
      leaseExpiry: (runId) =>
        this.#sql<{ lease_expires_at: number }>(
          "SELECT lease_expires_at FROM concurrency_leases WHERE run_id = ?",
          runId,
        )[0]?.lease_expires_at,
    };
  }

  #load(key: string): GroupState | null {
    const row = this.#sql<GroupRow>("SELECT * FROM concurrency_groups WHERE group_key = ?", key)[0];
    if (!row) return null;
    return {
      key: row.group_key,
      name: row.group_name,
      owner:
        row.owner_run !== null && row.owner_key !== null && row.generation !== null
          ? {
              ref: { runId: row.owner_run, ownerKey: row.owner_key },
              generation: row.generation,
              holdMs: row.hold_ms ?? 0,
              cancelRequestedAt: row.cancel_requested_at,
              releaseDeadline: row.release_deadline,
            }
          : null,
      pending:
        row.pending_run !== null && row.pending_key !== null
          ? {
              ref: { runId: row.pending_run, ownerKey: row.pending_key },
              since: row.pending_since ?? 0,
              holdMs: row.pending_hold_ms ?? 0,
            }
          : null,
    };
  }

  #receipt(key: string, ref: OwnerRef): Receipt | undefined {
    const row = this.#sql<{ outcome: ReceiptOutcome; generation: number | null }>(
      "SELECT outcome, generation FROM concurrency_receipts WHERE group_key = ? AND run_id = ? AND owner_key = ?",
      key,
      ref.runId,
      ref.ownerKey,
    )[0];
    return row ? { outcome: row.outcome, generation: row.generation } : undefined;
  }

  /** Writes an outcome: the group row (or its deletion), receipts, signals, lease grants. */
  #apply(key: string, outcome: Outcome, now: number): void {
    const group = outcome.group;
    if (!group) this.#sql("DELETE FROM concurrency_groups WHERE group_key = ?", key);
    else
      this.#sql(
        `INSERT INTO concurrency_groups (group_key, group_name, owner_run, owner_key, generation,
           hold_ms, cancel_requested_at, release_deadline, pending_run, pending_key, pending_since,
           pending_hold_ms, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (group_key) DO UPDATE SET group_name = excluded.group_name,
           owner_run = excluded.owner_run, owner_key = excluded.owner_key,
           generation = excluded.generation, hold_ms = excluded.hold_ms,
           cancel_requested_at = excluded.cancel_requested_at,
           release_deadline = excluded.release_deadline, pending_run = excluded.pending_run,
           pending_key = excluded.pending_key, pending_since = excluded.pending_since,
           pending_hold_ms = excluded.pending_hold_ms, updated_at = excluded.updated_at`,
        key,
        group.name,
        group.owner?.ref.runId ?? null,
        group.owner?.ref.ownerKey ?? null,
        group.owner?.generation ?? null,
        group.owner?.holdMs ?? null,
        group.owner?.cancelRequestedAt ?? null,
        group.owner?.releaseDeadline ?? null,
        group.pending?.ref.runId ?? null,
        group.pending?.ref.ownerKey ?? null,
        group.pending?.since ?? null,
        group.pending?.holdMs ?? null,
        now,
      );
    for (const { ref, receipt } of outcome.receipts)
      this.#sql(
        `INSERT INTO concurrency_receipts (group_key, run_id, owner_key, outcome, generation, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (group_key, run_id, owner_key) DO UPDATE SET outcome = excluded.outcome,
           generation = excluded.generation, updated_at = excluded.updated_at`,
        key,
        ref.runId,
        ref.ownerKey,
        receipt.outcome,
        receipt.generation,
        now,
      );
    for (const signal of outcome.signals)
      this.#sql(
        `INSERT OR IGNORE INTO concurrency_signals (run_id, owner_key, group_key, kind, generation,
           created_at, next_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        signal.ref.runId,
        signal.ref.ownerKey,
        key,
        signal.kind,
        signal.generation,
        now,
        now,
      );
    for (const runId of outcome.leaseGrants) this.#grant(runId, now);
    this.#wakeAtNext(now);
  }

  /** The run's lease reaches at least `now + lease`. */
  #grant(runId: string, now: number): number {
    this.#sql(
      `INSERT INTO concurrency_leases (run_id, lease_expires_at, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (run_id) DO UPDATE SET
         lease_expires_at = max(lease_expires_at, excluded.lease_expires_at),
         updated_at = excluded.updated_at`,
      runId,
      now + CONCURRENCY_LEASE_MS,
      now,
    );
    return this.#sql<{ lease_expires_at: number }>(
      "SELECT lease_expires_at FROM concurrency_leases WHERE run_id = ?",
      runId,
    )[0]?.lease_expires_at as number;
  }

  #answer(key: string, ref: OwnerRef, now: number): ReceiptAnswer | null {
    const receipt = this.#receipt(key, ref);
    if (!receipt) return null;
    const group = this.#load(key);
    const owner = group?.owner;
    const owns =
      receipt.outcome === "owner" &&
      owner !== undefined &&
      owner !== null &&
      owner.ref.runId === ref.runId &&
      owner.ref.ownerKey === ref.ownerKey;
    if (!owns || !group) return { ...receipt, leaseRemainingMs: null, cancelRequested: false };
    const lease = this.#context(now).leaseExpiry(ref.runId) ?? now;
    const renewed = renewScope(group, ref, owner.generation, lease);
    return {
      ...receipt,
      leaseRemainingMs: renewed.ok ? Math.max(0, renewed.grantedUntil - now) : null,
      cancelRequested: renewed.ok && renewed.cancelRequested,
    };
  }

  /** Settles every group due at `now` (expired leases, passed deadlines). */
  settleDue(now = this.#now()): number {
    const due = this.#sql<{ group_key: string }>(
      `SELECT g.group_key FROM concurrency_groups g
       LEFT JOIN concurrency_leases l ON l.run_id = g.owner_run
       WHERE g.owner_run IS NOT NULL AND (
         (g.release_deadline IS NOT NULL AND g.release_deadline <= ?) OR
         (g.release_deadline IS NULL AND (l.lease_expires_at IS NULL OR l.lease_expires_at <= ?)))`,
      now,
      now,
    );
    for (const { group_key } of due)
      this.#apply(group_key, settle(this.#load(group_key), this.#context(now)), now);
    return due.length;
  }

  /** A request for `group`, answered once per owner identity; repeats return its receipt. */
  acquire(request: ConcurrencyRequest): ReceiptAnswer {
    const now = this.#now();
    const key = groupKey(request.group);
    const ref = { runId: request.runId, ownerKey: request.ownerKey };
    return this.deps.git.context.storage.transactionSync(() => {
      this.settleDue(now);
      const receipt = this.#receipt(key, ref);
      if (!receipt) {
        const outcome = acquire(
          this.#load(key),
          key,
          ref,
          {
            name: request.group,
            cancelInProgress: request.cancelInProgress,
            holdMs: request.holdMs,
          },
          undefined,
          this.#context(now),
        );
        this.#apply(key, outcome, now);
      }
      return this.#answer(key, ref, now) as ReceiptAnswer;
    });
  }

  /** The receipts of `scopes` as they stand; never a new request. */
  status(
    scopes: readonly { group: string; runId: string; ownerKey: string }[],
  ): (ReceiptAnswer | null)[] {
    const now = this.#now();
    return this.deps.git.context.storage.transactionSync(() => {
      this.settleDue(now);
      return scopes.map((s) =>
        this.#answer(groupKey(s.group), { runId: s.runId, ownerKey: s.ownerKey }, now),
      );
    });
  }

  /** Renews the run's lease (one row) and answers each owned scope. */
  renew(runId: string, scopes: readonly RenewScope[]): RenewAnswer[] {
    const now = this.#now();
    return this.deps.git.context.storage.transactionSync(() => {
      this.settleDue(now);
      const answers = scopes.map((scope): RenewAnswer => {
        const key = groupKey(scope.group);
        const ref = { runId, ownerKey: scope.ownerKey };
        const group = this.#load(key);
        const owner = group?.owner;
        if (
          !group ||
          !owner ||
          owner.ref.runId !== runId ||
          owner.ref.ownerKey !== scope.ownerKey ||
          owner.generation !== scope.generation
        )
          return { ok: false, receipt: this.#answer(key, ref, now) };
        if (scope.holdMs !== undefined && scope.holdMs !== owner.holdMs)
          this.#apply(
            key,
            { group: withHold(group, scope.holdMs), receipts: [], signals: [], leaseGrants: [] },
            now,
          );
        return { ok: true, leaseRemainingMs: 0, cancelRequested: false };
      });
      if (!answers.some((a) => a.ok)) return answers;
      const lease = this.#grant(runId, now);
      return answers.map((answer, i) => {
        if (!answer.ok) return answer;
        const scope = scopes[i] as RenewScope;
        const group = this.#load(groupKey(scope.group));
        const renewed = renewScope(
          group,
          { runId, ownerKey: scope.ownerKey },
          scope.generation,
          lease,
        );
        return renewed.ok
          ? {
              ok: true,
              leaseRemainingMs: Math.max(0, renewed.grantedUntil - now),
              cancelRequested: renewed.cancelRequested,
            }
          : { ok: false, receipt: null };
      });
    });
  }

  /** Gives a scope up, by identity: an owner releases, a pending one withdraws; anyone else changes nothing. */
  release(input: {
    group: string;
    runId: string;
    ownerKey: string;
    generation?: number;
  }): ReceiptAnswer | null {
    const now = this.#now();
    const key = groupKey(input.group);
    const ref = { runId: input.runId, ownerKey: input.ownerKey };
    return this.deps.git.context.storage.transactionSync(() => {
      // A release that finds no request is a withdrawal before the request arrived (its call
      // was delayed): a receipt says so, and answers that request when it lands.
      if (!this.#receipt(key, ref))
        this.#apply(
          key,
          {
            group: this.#load(key),
            receipts: [{ ref, receipt: { outcome: "released", generation: null } }],
            signals: [],
            leaseGrants: [],
          },
          now,
        );
      else
        this.#apply(key, release(this.#load(key), ref, input.generation, this.#context(now)), now);
      return this.#answer(key, ref, now);
    });
  }

  /** Signals due for delivery now, oldest first. */
  dueSignals(now = this.#now()): SignalRow[] {
    return this.#sql<SignalRow>(
      "SELECT * FROM concurrency_signals WHERE next_at <= ? ORDER BY next_at, created_at LIMIT ?",
      now,
      SIGNALS_PER_SLICE,
    );
  }

  signalDelivered(signal: SignalRow): void {
    this.#sql(
      "DELETE FROM concurrency_signals WHERE run_id = ? AND owner_key = ? AND group_key = ? AND kind = ? AND generation = ?",
      signal.run_id,
      signal.owner_key,
      signal.group_key,
      signal.kind,
      signal.generation,
    );
  }

  /** A failed delivery: retried later with doubling backoff, never dropped. */
  signalFailed(signal: SignalRow, now = this.#now()): void {
    const delay = Math.min(SIGNAL_BACKOFF_MAX_MS, 1_000 * 2 ** Math.min(signal.attempts, 20));
    this.#sql(
      `UPDATE concurrency_signals SET attempts = attempts + 1, next_at = ?
       WHERE run_id = ? AND owner_key = ? AND group_key = ? AND kind = ? AND generation = ?`,
      now + delay,
      signal.run_id,
      signal.owner_key,
      signal.group_key,
      signal.kind,
      signal.generation,
    );
  }

  /** When the delivery and settling job next has work: a due signal, a deadline or a lease expiry. */
  nextAt(): number | undefined {
    const row = this.#sql<{ at: number | null }>(
      `SELECT min(at) AS at FROM (
         SELECT min(next_at) AS at FROM concurrency_signals
         UNION ALL SELECT min(release_deadline) FROM concurrency_groups WHERE release_deadline IS NOT NULL
         UNION ALL SELECT min(l.lease_expires_at) FROM concurrency_groups g
           JOIN concurrency_leases l ON l.run_id = g.owner_run WHERE g.release_deadline IS NULL)`,
    )[0];
    return row?.at ?? undefined;
  }

  #wakeAtNext(now: number): void {
    const at = this.nextAt();
    if (at !== undefined) this.deps.wake(Math.max(at, now));
  }

  /** Forgets a run erased with the repository's step: its receipts, signals and lease; releases what it holds. */
  forgetRun(runId: string): void {
    const now = this.#now();
    this.deps.git.context.storage.transactionSync(() => {
      const held = this.#sql<{ group_key: string; owner_key: string; pending: number }>(
        `SELECT group_key, owner_key, 0 AS pending FROM concurrency_groups WHERE owner_run = ?
         UNION ALL SELECT group_key, pending_key, 1 FROM concurrency_groups WHERE pending_run = ?`,
        runId,
        runId,
      );
      for (const { group_key, owner_key } of held)
        this.#apply(
          group_key,
          release(
            this.#load(group_key),
            { runId, ownerKey: owner_key },
            undefined,
            this.#context(now),
          ),
          now,
        );
      this.#sql("DELETE FROM concurrency_receipts WHERE run_id = ?", runId);
      this.#sql("DELETE FROM concurrency_signals WHERE run_id = ?", runId);
      this.#sql("DELETE FROM concurrency_leases WHERE run_id = ?", runId);
    });
  }
}
