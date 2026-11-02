import { DISCRETIONARY_RESOURCES, type ResourceVector } from "../../effects/discretionary.js";
import {
  canonicalCompletion,
  canonicalPlan,
  canonicalVector,
  type LiveDurationCompletion,
  type LiveEnvelope,
  type LiveGrantRequest,
} from "../../live/budget.js";
import { paysToday } from "../../live/funding.js";
import { LIVE_PRICES, type LiveManifestEntry } from "../../live/manifest.js";
import type { LiveOwnerRef } from "../../live/owners.js";

/**
 * Whether a turn's grant pays for a turn of its kind (a pump, or one of
 * renewals only) at today's prices (one made before a rise does not).
 */
const turnPaid = (envelope: LiveEnvelope) => {
  const kind = envelope.plan.kind;
  if (kind !== "pump" && kind !== "renewal") return false;
  return paysToday(envelope, LIVE_PRICES[kind] as LiveManifestEntry, {
    recipientType: "UserDO",
    recipient: envelope.plan.recipient,
    kind,
    class: "ordinary",
  });
};

/*
 * Live budgets in a feed's object (call within its transactions): the fence
 * (the epoch and ledger incarnation its credit was granted under, the
 * generation that invalidates authorization results captured before an
 * await, and the grant sequence cleaned through), the pending identity of
 * each kind of installation, balances of granted credit (one row a grant
 * and day, so a refill never extends older credit), terminal provisions,
 * ordinary duration completions, and every live row's stamp: the grant
 * that paid for it. A restore or a new ledger incarnation moves the fence,
 * so everything held before is invalid at once; deleting it is recovery's,
 * a bounded page at a time, after which the watermark refuses anything
 * granted up to it.
 */

const R = DISCRETIONARY_RESOURCES;
/** A balance with nothing left (its canonical JSON): drained, it no longer counts in its pool. */
const EMPTY = JSON.stringify(
  canonicalVector(Object.fromEntries(R.map((r) => [r, 0])) as ResourceVector),
);
const DAY = 86_400_000;

/** Rows a recovery call inspects at most, across every table. */
export const LIVE_RECOVERY_ROWS = 64;

export interface LiveFence {
  readonly epoch: number;
  readonly incarnation: string;
  readonly authorizationGen: number;
  readonly cleanupThrough: number;
}

/** The grant that paid for a row. */
export interface LiveFundingStamp {
  readonly epoch: number;
  readonly incarnation: string;
  readonly seq: number;
  readonly validUntil: number;
}

type PendingKind = "install" | "control_refill" | "mark_refill" | "renewal";

/** The feed's one execution turn: its grant, its phase, when it is due, and its dispatch. */
export interface LiveTurn {
  readonly operationId: string;
  readonly envelope: LiveEnvelope;
  readonly phase: "prepared" | "claimed" | "dispatched";
  readonly intendedAt: number;
  readonly ownerId: string | null;
  readonly instance: string | null;
}

/** The kinds queued once and dispatched with an owner. */
export type QueuedKind = "control_refill" | "mark_refill" | "renewal";

/** A queued live installation: its local identity, request, phase, owner and funding. */
export interface LivePending {
  readonly identity: string;
  readonly intendedAt: number;
  readonly phase: "queued" | "dispatched";
  readonly request: LiveGrantRequest | null;
  readonly ownerId: string | null;
  readonly instance: string | null;
  readonly funding: LiveFundingStamp;
}

/** A request's canonical bytes (stored once; a retry sends the same). */
const requestText = (request: LiveGrantRequest) =>
  JSON.stringify({
    operationId: request.operationId,
    nonce: request.nonce,
    plan: JSON.parse(canonicalPlan(request.plan)),
  });

/** The live tables recovery cleans, in order (a socket's dependencies before the socket), each by its primary key. */
const RECOVERY_TABLES: readonly { readonly table: string; readonly key: readonly string[] }[] = [
  { table: "live_local_deps", key: ["socket_id", "dependency"] },
  { table: "live_local", key: ["socket_id"] },
  { table: "live_tickets", key: ["ticket_hash"] },
  { table: "live_budget_pending", key: ["kind"] },
  { table: "live_turn", key: ["id"] },
  { table: "live_budget_balances", key: ["operation_id", "day"] },
  { table: "live_budget_terminal", key: ["socket_id", "day"] },
  { table: "live_budget_completions", key: ["operation_id"] },
  { table: "live_candidates", key: ["stream", "conversation"] },
  { table: "live_dirty", key: ["stream"] },
  { table: "live_revoked", key: ["dependency"] },
];

type Stamped = Record<string, string | number> & {
  budget_epoch: number;
  budget_incarnation: string;
  budget_seq: number;
  budget_valid_until: number;
};

/**
 * The grants a pool of credit (a kind's, a day's) holds at most that can be
 * spent: its current block and one installed successor. Another refill
 * waits until one drains or is retired, so spending reads two at most.
 */
export const LIVE_POOL_GRANTS = 2;

/** A pool's expired balances an installation removes at most (its own work kept bounded). */
export const LIVE_EXPIRED_PRUNE = 4;

export class LiveBudget {
  constructor(private readonly sql: SqlStorage) {}

  fence(): LiveFence {
    const row = this.sql
      .exec<{
        epoch: number;
        incarnation: string;
        authorization_gen: number;
        cleanup_through: number;
      }>(
        "SELECT epoch, incarnation, authorization_gen, cleanup_through FROM live_budget_fence WHERE id = 1",
      )
      .one();
    return {
      epoch: row.epoch,
      incarnation: row.incarnation,
      authorizationGen: row.authorization_gen,
      cleanupThrough: row.cleanup_through,
    };
  }

  /**
   * The ledger's time (D1's) by this object's clock `local`, at the latest
   * it may be: as far ahead as the ledger may have been when a funding was
   * last checked. Its credit's times (validity, the day spent from) are the
   * ledger's, so they are judged by it, late rather than early (credit ends
   * no later than it does; work past a midnight is never yesterday's).
   */
  ledgerNow(local: number): number {
    return local + this.#clock().high;
  }

  /**
   * The UTC day the ledger is on by this object's clock `local`, or null
   * when it cannot be told (the ledger's time may be either side of a
   * midnight): nothing is spent then.
   */
  ledgerDay(local: number): number | null {
    const { high, width } = this.#clock();
    const day = Math.floor((local + high) / DAY);
    return Math.floor((local + high - width) / DAY) === day ? day : null;
  }

  /**
   * The ledger's time by this object's clock `local`, at the earliest it
   * may be, in D1's whole seconds (what a grant may start at: never after
   * D1's own time).
   */
  ledgerEarliest(local: number): number {
    const { high, width } = this.#clock();
    return Math.floor((local + high - width) / 1_000) * 1_000;
  }

  /** The days the ledger may be on by `local`: the later first (one, away from a midnight). */
  ledgerDays(local: number): number[] {
    const { high, width } = this.#clock();
    const later = Math.floor((local + high) / DAY);
    const earlier = Math.floor((local + high - width) / DAY);
    return later === earlier ? [later] : [later, earlier];
  }

  #clock(): { high: number; width: number } {
    const row = this.sql
      .exec<{ ledger_offset_ms: number; ledger_uncertainty_ms: number }>(
        "SELECT ledger_offset_ms, ledger_uncertainty_ms FROM live_budget_fence WHERE id = 1",
      )
      .one();
    return { high: row.ledger_offset_ms, width: row.ledger_uncertainty_ms };
  }

  /**
   * Records the ledger's time `ledgerAt` (D1's, whole seconds) as answered
   * to a request this object's clock sent at `sent` and heard back at
   * `received`: the ledger was then between `ledgerAt` (as received) and a
   * second past it (as sent). A sample older than the one kept is not
   * recorded.
   */
  noteLedger(ledgerAt: number, sent: number, received: number): void {
    this.sql.exec(
      `UPDATE live_budget_fence SET ledger_offset_ms = ?1, ledger_uncertainty_ms = ?2,
         ledger_sampled_at = ?3
       WHERE id = 1 AND ledger_sampled_at <= ?3`,
      ledgerAt + 1_000 - sent,
      1_000 + Math.max(0, received - sent),
      sent,
    );
  }

  /**
   * Moves the fence to the feed's epoch and the ledger's incarnation when
   * either changed: every credit, pending installation and captured
   * authorization result before is invalid at once (and the live alarm
   * dropped); a new incarnation starts its watermark over. Whether it moved
   * (an object learning the ledger's incarnation the first time is not).
   */
  takeEpoch(epoch: number, incarnation: string): boolean {
    const fence = this.fence();
    if (epoch <= fence.epoch && incarnation === fence.incarnation) return false;
    // The ledger's incarnation first learned (an object migrated, or new): nothing was granted
    // under another, so nothing is invalidated.
    if (epoch <= fence.epoch && fence.incarnation === "") {
      this.sql.exec("UPDATE live_budget_fence SET incarnation = ? WHERE id = 1", incarnation);
      return false;
    }
    this.sql.exec(
      `UPDATE live_budget_fence SET epoch = max(epoch, ?1), incarnation = ?2,
         authorization_gen = authorization_gen + 1,
         cleanup_through = CASE WHEN incarnation = ?2 THEN cleanup_through ELSE 0 END
       WHERE id = 1`,
      epoch,
      incarnation,
    );
    this.sql.exec("DELETE FROM user_schedule WHERE kind = 'live'");
    return true;
  }

  /** Whether a grant is under the current fence, after the watermark. */
  #fenced(stamp: Omit<LiveFundingStamp, "validUntil">): boolean {
    const fence = this.fence();
    return (
      stamp.epoch !== fence.epoch ||
      stamp.incarnation !== fence.incarnation ||
      stamp.seq <= fence.cleanupThrough
    );
  }

  /**
   * Records the identity an installation of `kind` will be granted as,
   * paid for by `funding`, under the current authorization generation (a
   * newer one of the kind replaces it, unless that one is prepared or
   * dispatched). False when the funding is not current, or nothing was replaced.
   */
  begin(
    kind: PendingKind,
    operationId: string,
    intendedAt: number,
    funding: LiveFundingStamp,
    now: number,
  ): boolean {
    if (this.#fenced(funding) || now >= funding.validUntil) return false;
    return (
      this.sql.exec(
        `INSERT INTO live_budget_pending (kind, operation_id, intended_at, authorization_gen,
         budget_epoch, budget_incarnation, budget_seq, budget_valid_until)
       SELECT ?1, ?2, ?3, authorization_gen, ?4, ?5, ?6, ?7 FROM live_budget_fence WHERE id = 1
       ON CONFLICT (kind) DO UPDATE SET operation_id = excluded.operation_id,
         intended_at = excluded.intended_at, authorization_gen = excluded.authorization_gen,
         budget_epoch = excluded.budget_epoch, budget_incarnation = excluded.budget_incarnation,
         budget_seq = excluded.budget_seq, budget_valid_until = excluded.budget_valid_until
       -- Never one prepared or dispatched (its request and owner are its own).
       WHERE live_budget_pending.phase = 'queued' AND live_budget_pending.request_json IS NULL`,
        kind,
        operationId,
        intendedAt,
        funding.epoch,
        funding.incarnation,
        funding.seq,
        funding.validUntil,
      ).rowsWritten > 0
    );
  }

  /**
   * Installs a granted credit as balances (a row a charged day), only for
   * the identity still pending for `kind` under the same fence and
   * authorization generation, granted after the watermark and still valid;
   * the pending identity goes with it. A second installation changes
   * nothing (what was spent stays spent).
   */
  /** The feed's execution turn, as stored (null when none is prepared or running). */
  turn(): LiveTurn | null {
    const row = this.sql
      .exec<{
        operation_id: string;
        envelope_json: string;
        phase: LiveTurn["phase"];
        intended_at: number;
        owner_id: string | null;
        dispatch_instance: string | null;
      }>(
        "SELECT operation_id, envelope_json, phase, intended_at, owner_id, dispatch_instance FROM live_turn WHERE id = 1",
      )
      .toArray()[0];
    if (!row) return null;
    return {
      operationId: row.operation_id,
      envelope: JSON.parse(row.envelope_json) as LiveEnvelope,
      phase: row.phase,
      intendedAt: row.intended_at,
      ownerId: row.owner_id,
      instance: row.dispatch_instance,
    };
  }

  /**
   * Prepares the feed's next turn, paid for by `envelope` (an admission's,
   * or the turn finishing in the same transaction: `finishTurn`), due at
   * `intendedAt`: only when none is held, its grant current and valid now.
   * Preparing never dispatches it.
   */
  prepareTurn(envelope: LiveEnvelope, intendedAt: number, now: number): boolean {
    const plan = envelope.plan;
    const stamp = { epoch: plan.epoch, incarnation: plan.incarnation, seq: envelope.seq };
    if (this.#fenced(stamp) || now < plan.validFrom || now >= plan.validUntil) return false;
    if (!turnPaid(envelope)) return false;
    // A prepared turn its grant pays too little for today (granted before a price rose) can never
    // run: it gives way like an expired one.
    const held = this.turn();
    if (held?.phase === "prepared" && !turnPaid(held.envelope))
      this.sql.exec("DELETE FROM live_turn WHERE id = 1 AND operation_id = ?", held.operationId);
    return (
      this.sql.exec(
        // A prepared turn that can no longer run (expired, or fenced since) gives way; one held
        // otherwise stays.
        `INSERT INTO live_turn (id, operation_id, envelope_json, phase, intended_at,
           budget_epoch, budget_incarnation, budget_seq, budget_valid_until)
         VALUES (1, ?1, ?2, 'prepared', ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (id) DO UPDATE SET operation_id = excluded.operation_id,
           envelope_json = excluded.envelope_json, intended_at = excluded.intended_at,
           budget_epoch = excluded.budget_epoch, budget_incarnation = excluded.budget_incarnation,
           budget_seq = excluded.budget_seq, budget_valid_until = excluded.budget_valid_until,
           owner_id = NULL, dispatch_instance = NULL
         WHERE live_turn.phase = 'prepared' AND (live_turn.budget_valid_until <= ?8
           OR EXISTS (SELECT 1 FROM live_budget_fence f WHERE f.id = 1
             AND (live_turn.budget_epoch <> f.epoch OR live_turn.budget_incarnation <> f.incarnation
               OR live_turn.budget_seq <= f.cleanup_through)))`,
        envelope.operationId,
        JSON.stringify(envelope),
        intendedAt,
        plan.epoch,
        plan.incarnation,
        envelope.seq,
        plan.validUntil,
        now,
      ).rowsWritten > 0
    );
  }

  /**
   * The prepared turn that can run by this object's clock `local` (current,
   * still valid on the ledger's clock): when it is due, and when it lapses
   * (on this object's clock); null for none.
   */
  runnableTurn(local: number): { intendedAt: number; validUntil: number; seq: number } | null {
    const turn = this.turn();
    if (!turn || turn.phase !== "prepared") return null;
    const plan = turn.envelope.plan;
    const now = this.ledgerNow(local);
    if (
      this.#fenced({ epoch: plan.epoch, incarnation: plan.incarnation, seq: turn.envelope.seq }) ||
      now >= plan.validUntil ||
      !turnPaid(turn.envelope)
    )
      return null;
    return {
      intendedAt: turn.intendedAt,
      validUntil: plan.validUntil - (now - local),
      seq: turn.envelope.seq,
    };
  }

  /** Brings the prepared turn's due time to `at` at the latest (whether one is prepared). */
  bringTurn(at: number): boolean {
    return (
      this.sql.exec(
        "UPDATE live_turn SET intended_at = min(intended_at, ?) WHERE id = 1 AND phase = 'prepared'",
        at,
      ).rowsWritten > 0
    );
  }

  /**
   * Puts a claimed turn that never dispatched back as prepared, due at
   * `intendedAt` (its owner was not admitted: nothing of it ran).
   */
  unclaimTurn(operationId: string, intendedAt: number): boolean {
    return (
      this.sql.exec(
        `UPDATE live_turn SET phase = 'prepared', intended_at = ?2, dispatch_instance = NULL
         WHERE id = 1 AND phase = 'claimed' AND operation_id = ?1`,
        operationId,
        intendedAt,
      ).rowsWritten > 0
    );
  }

  /**
   * Claims the prepared turn, once: its envelope, when it is still
   * current and valid now (else null, the turn left as it was: an expired
   * one pays for nothing, its successor included).
   */
  claimTurn(now: number, instance = ""): LiveEnvelope | null {
    const turn = this.turn();
    if (!turn || turn.phase !== "prepared") return null;
    const plan = turn.envelope.plan;
    if (
      this.#fenced({ epoch: plan.epoch, incarnation: plan.incarnation, seq: turn.envelope.seq }) ||
      now < plan.validFrom ||
      now >= plan.validUntil ||
      !turnPaid(turn.envelope)
    )
      return null;
    // Claimed by this instance: another finding it claimed knows it was not its own.
    const claimed = this.sql.exec(
      `UPDATE live_turn SET phase = 'claimed', dispatch_instance = ?2
       WHERE id = 1 AND phase = 'prepared' AND operation_id = ?1`,
      turn.operationId,
      instance,
    ).rowsWritten;
    return claimed > 0 ? turn.envelope : null;
  }

  /**
   * Records the claimed turn dispatched with its owner by `instance`,
   * before any awaited work: a turn lost or uncertain after this is never
   * prepared again (recovery quarantines its owner).
   */
  dispatchTurn(operationId: string, ownerId: string, instance: string): boolean {
    return (
      this.sql.exec(
        `UPDATE live_turn SET phase = 'dispatched', owner_id = ?2, dispatch_instance = ?3
         WHERE id = 1 AND phase = 'claimed' AND operation_id = ?1`,
        operationId,
        ownerId,
        instance,
      ).rowsWritten > 0
    );
  }

  /**
   * Ends the running turn `operationId` (claimed, or dispatched once its
   * owner was accounted), and, when it is still current and valid now,
   * prepares `successor`, paid for by it, in the same transaction (an
   * expired, fenced or exhausted turn names none). False when it is not the
   * running turn, or its owner is not accounted yet.
   */
  finishTurn(
    operationId: string,
    now: number,
    options: {
      /** A dispatched turn's owner observed and accounted in the directory: only then it goes. */
      readonly ownerAccounted?: boolean;
      readonly successor?: { readonly envelope: LiveEnvelope; readonly intendedAt: number };
    } = {},
  ): boolean {
    const turn = this.turn();
    if (!turn || turn.operationId !== operationId || turn.phase === "prepared") return false;
    // Its owner's reference is what recovery quarantines by: kept until it was accounted.
    if (turn.phase === "dispatched" && !options.ownerAccounted) return false;
    this.sql.exec("DELETE FROM live_turn WHERE id = 1 AND operation_id = ?", operationId);
    const plan = turn.envelope.plan;
    const current = !this.#fenced({
      epoch: plan.epoch,
      incarnation: plan.incarnation,
      seq: turn.envelope.seq,
    });
    // A successor only from a turn still current and valid: a fenced or expired one pays for none.
    if (options.successor && current && now < plan.validUntil)
      this.prepareTurn(options.successor.envelope, options.successor.intendedAt, now);
    return true;
  }

  /**
   * The days of `plan`'s whose pool of `balance` credit has room for it
   * (fewer than its most spendable grants), once a few of each pool's
   * expired balances are removed (an expired grant is never installed
   * again: its balance protects nothing more, and leaving it would slow
   * every spend of its day).
   */
  #roomyDays(balance: "control" | "mark", plan: LiveEnvelope["plan"], now: number): number[] {
    for (const charge of plan.charges)
      this.sql.exec(
        `DELETE FROM live_budget_balances WHERE (operation_id, day) IN (
           SELECT operation_id, day FROM live_budget_balances INDEXED BY live_budget_balances_live
           WHERE kind = ?1 AND day = ?2 AND remaining <> '${EMPTY}' AND budget_valid_until <= ?3
           ORDER BY budget_seq, operation_id LIMIT ?4)`,
        balance,
        charge.day,
        now,
        LIVE_EXPIRED_PRUNE,
      );
    return plan.charges
      .filter(
        (charge) =>
          this.sql
            .exec<{ n: number }>(
              `SELECT count(*) AS n FROM (SELECT 1 FROM live_budget_balances b
                 INDEXED BY live_budget_balances_live JOIN live_budget_fence f ON f.id = 1
               WHERE b.kind = ?1 AND b.day = ?2 AND b.remaining <> '${EMPTY}'
                 AND b.budget_epoch = f.epoch AND b.budget_incarnation = f.incarnation
                 AND b.budget_seq > f.cleanup_through AND b.budget_valid_until > ?3
               LIMIT ?4)`,
              balance,
              charge.day,
              now,
              LIVE_POOL_GRANTS,
            )
            .one().n < LIVE_POOL_GRANTS,
      )
      .map((charge) => charge.day);
  }

  /** Installs `grant`'s block into `balance`'s pool on `days` (each a day it is charged to). */
  #installOn(balance: "control" | "mark", grant: LiveEnvelope, days: readonly number[]): void {
    const plan = grant.plan;
    for (const charge of plan.charges)
      if (days.includes(charge.day))
        this.sql.exec(
          `INSERT INTO live_budget_balances (operation_id, day, kind, remaining, budget_epoch,
             budget_incarnation, budget_seq, budget_valid_until)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
          grant.operationId,
          charge.day,
          balance,
          JSON.stringify(canonicalVector(charge.resources)),
          plan.epoch,
          plan.incarnation,
          grant.seq,
          plan.validUntil,
        );
  }

  install(
    kind: PendingKind,
    grant: LiveEnvelope,
    now: number,
  ): "installed" | "duplicate" | "refused" | "full" {
    const plan = grant.plan;
    const installed = this.sql
      .exec("SELECT 1 FROM live_budget_balances WHERE operation_id = ? LIMIT 1", grant.operationId)
      .toArray().length;
    if (installed > 0) return "duplicate";
    if (!plan.producesLocal || plan.recipientType !== "UserDO") return "refused";
    const pending = this.sql
      .exec(
        `SELECT 1 FROM live_budget_pending p JOIN live_budget_fence f ON f.id = 1
         WHERE p.kind = ?1 AND p.operation_id = ?2 AND p.budget_epoch = f.epoch
           AND p.budget_incarnation = f.incarnation AND p.authorization_gen = f.authorization_gen
           AND ?3 = f.epoch AND ?4 = f.incarnation AND ?5 > f.cleanup_through AND ?6 < ?7`,
        kind,
        grant.operationId,
        plan.epoch,
        plan.incarnation,
        grant.seq,
        now,
        plan.validUntil,
      )
      .toArray().length;
    if (pending === 0) return "refused";
    const balance = kind === "mark_refill" ? "mark" : "control";
    const days = this.#roomyDays(balance, plan, now);
    if (days.length < plan.charges.length) return "full";
    this.#installOn(balance, grant, days);
    this.sql.exec(
      "DELETE FROM live_budget_pending WHERE kind = ? AND operation_id = ?",
      kind,
      grant.operationId,
    );
    return "installed";
  }

  /**
   * Queues `kind` once (call within the caller's transaction): `existing`
   * when one is queued or dispatched (its identity and time kept), `refused`
   * when its funding is not current. Nothing is asked of the ledger here.
   */
  queueOnce(
    kind: QueuedKind,
    identity: string,
    intendedAt: number,
    funding: LiveFundingStamp,
    now: number,
  ): "queued" | "existing" | "refused" {
    if (this.sql.exec("SELECT 1 FROM live_budget_pending WHERE kind = ?", kind).toArray().length)
      return "existing";
    if (this.#fenced(funding) || now >= funding.validUntil) return "refused";
    this.sql.exec(
      `INSERT INTO live_budget_pending (kind, operation_id, intended_at, authorization_gen,
         budget_epoch, budget_incarnation, budget_seq, budget_valid_until, phase)
       SELECT ?1, ?2, ?3, authorization_gen, ?4, ?5, ?6, ?7, 'queued'
       FROM live_budget_fence WHERE id = 1`,
      kind,
      identity,
      intendedAt,
      funding.epoch,
      funding.incarnation,
      funding.seq,
      funding.validUntil,
    );
    return "queued";
  }

  /**
   * Stores a queued item's exact request once (its dates and nonce kept on
   * every retry); true when it is that request's (stored now or before).
   */
  preparePending(kind: QueuedKind, identity: string, request: LiveGrantRequest): boolean {
    const text = requestText(request);
    const row = this.sql
      .exec<{ phase: string; request_json: string | null }>(
        "SELECT phase, request_json FROM live_budget_pending WHERE kind = ? AND operation_id = ?",
        kind,
        identity,
      )
      .toArray()[0];
    if (!row) return false;
    if (row.request_json !== null) return row.request_json === text;
    if (row.phase !== "queued") return false;
    this.sql.exec(
      "UPDATE live_budget_pending SET request_json = ? WHERE kind = ? AND operation_id = ?",
      text,
      kind,
      identity,
    );
    return true;
  }

  /**
   * Marks a prepared item dispatched, with its owner (bound once) and the
   * instance holding its work; never back to queued. False otherwise.
   */
  dispatchPending(
    kind: QueuedKind,
    identity: string,
    owner: LiveOwnerRef,
    instance: string,
  ): boolean {
    // An instance always names itself: an empty one would match any other.
    if (instance.length === 0) return false;
    return (
      this.sql.exec(
        `UPDATE live_budget_pending SET phase = 'dispatched', owner_id = ?3, dispatch_instance = ?4
         WHERE kind = ?1 AND operation_id = ?2 AND phase = 'queued' AND request_json IS NOT NULL
           AND owner_id IS NULL`,
        kind,
        identity,
        owner.ownerId,
        instance,
      ).rowsWritten > 0
    );
  }

  /** The owners of dispatched installations and turns (their work may still run). */
  dispatchedOwners(): string[] {
    return this.sql
      .exec<{ owner_id: string }>(
        `SELECT owner_id FROM live_budget_pending WHERE phase = 'dispatched' AND owner_id IS NOT NULL
         UNION ALL
         SELECT owner_id FROM live_turn WHERE phase = 'dispatched' AND owner_id IS NOT NULL`,
      )
      .toArray()
      .map((row) => row.owner_id);
  }

  /** The item queued as `kind`, if any. */
  pending(kind: QueuedKind): LivePending | null {
    const row = this.sql
      .exec<{
        operation_id: string;
        intended_at: number;
        phase: "queued" | "dispatched";
        request_json: string | null;
        owner_id: string | null;
        dispatch_instance: string | null;
        budget_epoch: number;
        budget_incarnation: string;
        budget_seq: number;
        budget_valid_until: number;
      }>("SELECT * FROM live_budget_pending WHERE kind = ?", kind)
      .toArray()[0];
    if (!row) return null;
    return {
      identity: row.operation_id,
      intendedAt: row.intended_at,
      phase: row.phase,
      request:
        row.request_json === null ? null : (JSON.parse(row.request_json) as LiveGrantRequest),
      ownerId: row.owner_id,
      instance: row.dispatch_instance,
      funding: {
        epoch: row.budget_epoch,
        incarnation: row.budget_incarnation,
        seq: row.budget_seq,
        validUntil: row.budget_valid_until,
      },
    };
  }

  /** Removes the item queued as `kind` with `identity`; whether it was there. */
  /**
   * Puts a dispatched installation back as queued, its exact request kept
   * (its grant's answer was lost: the next attempt sends the same request,
   * and gets the same grant if it was made).
   */
  requeuePending(kind: QueuedKind, identity: string, retryAt: number): boolean {
    return (
      this.sql.exec(
        `UPDATE live_budget_pending SET phase = 'queued', owner_id = NULL, dispatch_instance = NULL,
           intended_at = ?3
         WHERE kind = ?1 AND operation_id = ?2 AND phase = 'dispatched'`,
        kind,
        identity,
        retryAt,
      ).rowsWritten > 0
    );
  }

  /**
   * Puts back as queued every installation dispatched under `ownerId` (its
   * turn dealt with: nothing of it runs any more), each with its exact
   * request kept, due at `retryAt`.
   */
  requeueOwnedPending(ownerId: string, retryAt: number): number {
    return this.sql.exec(
      `UPDATE live_budget_pending SET phase = 'queued', owner_id = NULL, dispatch_instance = NULL,
         intended_at = ?2
       WHERE phase = 'dispatched' AND owner_id = ?1`,
      ownerId,
      retryAt,
    ).rowsWritten;
  }

  /** Forgets the turn (one an instance gone left claimed or dispatched, once dealt with). */
  dropTurn(operationId: string): boolean {
    return (
      this.sql.exec("DELETE FROM live_turn WHERE id = 1 AND operation_id = ?", operationId)
        .rowsWritten > 0
    );
  }

  /** Whether live work goes before notification email the next time both are due. */
  liveFirst(): boolean {
    return (
      this.sql
        .exec<{ f: number }>("SELECT alarm_live_first AS f FROM live_budget_fence WHERE id = 1")
        .one().f === 1
    );
  }

  setLiveFirst(first: boolean): void {
    this.sql.exec("UPDATE live_budget_fence SET alarm_live_first = ? WHERE id = 1", first ? 1 : 0);
  }

  finishPending(kind: QueuedKind, identity: string): boolean {
    return (
      this.sql.exec(
        "DELETE FROM live_budget_pending WHERE kind = ? AND operation_id = ?",
        kind,
        identity,
      ).rowsWritten > 0
    );
  }

  /**
   * Installs a refill's grant for the item queued as `kind` with
   * `identity`: only once dispatched by this `instance`, only the grant
   * its prepared request asked for (the same operation, of the refill's
   * kind), for this feed, under the current fence and authorization
   * generation, after the watermark, valid now; the item goes with it.
   * A renewal's grant never becomes balance.
   */
  installPending(
    kind: "control_refill" | "mark_refill",
    identity: string,
    grant: LiveEnvelope,
    now: number,
    recipient: string,
    instance: string,
  ): "installed" | "duplicate" | "refused" | "full" {
    if (
      this.sql
        .exec(
          "SELECT 1 FROM live_budget_balances WHERE operation_id = ? LIMIT 1",
          grant.operationId,
        )
        .toArray().length > 0
    )
      return "duplicate";
    const pending = this.pending(kind);
    const plan = grant.plan;
    const fence = this.fence();
    const row = this.sql
      .exec<{ authorization_gen: number }>(
        "SELECT authorization_gen FROM live_budget_pending WHERE kind = ? AND operation_id = ?",
        kind,
        identity,
      )
      .toArray()[0];
    if (
      !pending ||
      !row ||
      instance.length === 0 ||
      pending.identity !== identity ||
      // Dispatched by this instance (a new one never adopts an old one's continuation).
      pending.phase !== "dispatched" ||
      pending.instance !== instance ||
      pending.request?.operationId !== grant.operationId ||
      plan.kind !== (kind === "mark_refill" ? "mark" : "control") ||
      !plan.producesLocal ||
      plan.recipientType !== "UserDO" ||
      plan.recipient !== recipient ||
      plan.epoch !== fence.epoch ||
      plan.incarnation !== fence.incarnation ||
      row.authorization_gen !== fence.authorizationGen ||
      grant.seq <= fence.cleanupThrough ||
      now < plan.validFrom ||
      now >= plan.validUntil
    )
      return "refused";
    const balance = kind === "mark_refill" ? "mark" : "control";
    // Installed on each of its days with room (a full one's charge stands); with none, its item
    // stays queued: the pool installs it once a block drains or is retired.
    const days = this.#roomyDays(balance, plan, now);
    if (days.length === 0) return "full";
    this.#installOn(balance, grant, days);
    this.finishPending(kind, identity);
    return "installed";
  }

  /**
   * Installs a block an entry was granted with (an admission's first
   * blocks, its funding checked by the caller): into `balance`'s pool on
   * each day it is charged to whose pool has room, while it is current and
   * valid; `full` when no day has (it is then not installed: its charge
   * stands).
   */
  installBlock(
    balance: "control" | "mark",
    grant: LiveEnvelope,
    now: number,
  ): "installed" | "duplicate" | "refused" | "full" {
    const plan = grant.plan;
    if (
      this.sql
        .exec(
          "SELECT 1 FROM live_budget_balances WHERE operation_id = ? LIMIT 1",
          grant.operationId,
        )
        .toArray().length > 0
    )
      return "duplicate";
    if (
      plan.kind !== balance ||
      !plan.producesLocal ||
      plan.recipientType !== "UserDO" ||
      this.#fenced({ epoch: plan.epoch, incarnation: plan.incarnation, seq: grant.seq }) ||
      now < plan.validFrom ||
      now >= plan.validUntil
    )
      return "refused";
    const days = this.#roomyDays(balance, plan, now);
    if (days.length === 0) return "full";
    this.#installOn(balance, grant, days);
    return "installed";
  }

  /**
   * Provides `socketId`'s terminal work from its grant: a provision on each
   * day the grant is charged to, what that day's end of the socket may use;
   * false when the grant is not current and valid.
   */
  provideTerminal(socketId: string, grant: LiveEnvelope, now: number): boolean {
    const plan = grant.plan;
    if (
      plan.kind !== "terminal" ||
      this.#fenced({ epoch: plan.epoch, incarnation: plan.incarnation, seq: grant.seq }) ||
      now < plan.validFrom ||
      now >= plan.validUntil
    )
      return false;
    for (const charge of plan.charges)
      this.sql.exec(
        `INSERT INTO live_budget_terminal (socket_id, day, operation_id, remaining, budget_epoch,
           budget_incarnation, budget_seq, budget_valid_until)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        socketId,
        charge.day,
        grant.operationId,
        JSON.stringify(canonicalVector(charge.resources)),
        plan.epoch,
        plan.incarnation,
        grant.seq,
        plan.validUntil,
      );
    return true;
  }

  /**
   * Ends `socketId` on its terminal provision of the first of `days` that
   * has one current, valid at `now` and holding `price` (the days the
   * ledger may be on): consumed with every other day's provision of it;
   * whether it did (none: nothing of the socket may be done, its recovery
   * retires it).
   */
  terminate(
    socketId: string,
    days: readonly number[],
    price: ResourceVector,
    now: number,
  ): boolean {
    return days.some((day) => this.#terminateOn(socketId, day, price, now));
  }

  #terminateOn(socketId: string, day: number, price: ResourceVector, now: number): boolean {
    const row = this.sql
      .exec<{ remaining: string }>(
        `SELECT t.remaining FROM live_budget_terminal t JOIN live_budget_fence f ON f.id = 1
         WHERE t.socket_id = ?1 AND t.day = ?2
           AND t.budget_epoch = f.epoch AND t.budget_incarnation = f.incarnation
           AND t.budget_seq > f.cleanup_through AND t.budget_valid_until > ?3`,
        socketId,
        day,
        now,
      )
      .toArray()[0];
    if (!row) return false;
    const remaining = JSON.parse(row.remaining) as Record<string, number>;
    if (!R.every((r) => (remaining[r] ?? 0) >= price[r])) return false;
    this.sql.exec("DELETE FROM live_budget_terminal WHERE socket_id = ?", socketId);
    return true;
  }

  /** Forgets `socketId`'s terminal provisions (its admission refused after they were made). */
  forgetTerminal(socketId: string): void {
    this.sql.exec("DELETE FROM live_budget_terminal WHERE socket_id = ?", socketId);
  }

  /** Whole `unit`s left of today's `kind` credit (`day` must be `now`'s), counted to `atMost`. */
  unitsLeft(
    kind: "control" | "mark",
    day: number,
    unit: ResourceVector,
    now: number,
    atMost: number,
  ): number {
    if (day !== Math.floor(now / DAY)) return 0;
    const rows = this.#spendable(kind, day, now);
    let units = 0;
    for (const row of rows) {
      const remaining = JSON.parse(row.remaining) as Record<string, number>;
      units += Math.min(
        ...R.filter((r) => unit[r] > 0).map((r) => Math.floor((remaining[r] ?? 0) / unit[r])),
      );
      if (units >= atMost) return atMost;
    }
    return units;
  }

  /**
   * The stamp of the feed's turn while its grant is current and valid at
   * `now` (what a refill is queued under when its pool holds no current
   * grant at all: the turn is what will run it), or null.
   */
  turnStamp(now: number): LiveFundingStamp | null {
    const turn = this.turn();
    if (!turn) return null;
    const stamp = {
      epoch: turn.envelope.plan.epoch,
      incarnation: turn.envelope.plan.incarnation,
      seq: turn.envelope.seq,
      validUntil: turn.envelope.plan.validUntil,
    };
    return this.#fenced(stamp) || now >= stamp.validUntil ? null : stamp;
  }

  /**
   * The stamp of the newest current grant of today's `kind` pool, drained
   * or not (what a refill asked for an empty pool is queued under), or null.
   */
  poolStamp(kind: "control" | "mark", day: number, now: number): LiveFundingStamp | null {
    const row = this.sql
      .exec<{ e: number; i: string; s: number; v: number }>(
        `SELECT b.budget_epoch AS e, b.budget_incarnation AS i, b.budget_seq AS s,
           b.budget_valid_until AS v FROM live_budget_balances b
           INDEXED BY live_budget_balances_pool JOIN live_budget_fence f ON f.id = 1
         WHERE b.kind = ?1 AND b.day = ?2
           AND b.budget_epoch = f.epoch AND b.budget_incarnation = f.incarnation
           AND b.budget_seq > f.cleanup_through AND b.budget_valid_until > ?3
         ORDER BY b.budget_seq DESC LIMIT 1`,
        kind,
        day,
        now,
      )
      .toArray()[0];
    return row ? { epoch: row.e, incarnation: row.i, seq: row.s, validUntil: row.v } : null;
  }

  /** Today's spendable balances of `kind`, oldest first, a pool's at most. */
  #spendable(kind: "control" | "mark", day: number, now: number) {
    return this.sql
      .exec<{
        operation_id: string;
        remaining: string;
        budget_epoch: number;
        budget_incarnation: string;
        budget_seq: number;
        budget_valid_until: number;
      }>(
        `SELECT b.operation_id, b.remaining, b.budget_epoch, b.budget_incarnation, b.budget_seq,
           b.budget_valid_until FROM live_budget_balances b
           INDEXED BY live_budget_balances_live JOIN live_budget_fence f ON f.id = 1
         WHERE b.kind = ?1 AND b.day = ?2 AND b.remaining <> '${EMPTY}'
           AND b.budget_epoch = f.epoch AND b.budget_incarnation = f.incarnation
           AND b.budget_seq > f.cleanup_through AND b.budget_valid_until > ?3
         ORDER BY b.budget_seq, b.operation_id LIMIT ?4`,
        kind,
        day,
        now,
        LIVE_POOL_GRANTS,
      )
      .toArray();
  }

  /**
   * Spends `price` of today's `kind` credit (`day` must be `now`'s) across
   * the valid grants (oldest first), all of it or nothing.
   */
  spend(kind: "control" | "mark", day: number, price: ResourceVector, now: number): boolean {
    return this.spendFrom(kind, day, price, now) !== null;
  }

  /**
   * Spends as `spend` does: the stamp of the newest grant it charged (what
   * the work it paid for is stamped with), or null when it spent nothing.
   */
  spendFrom(
    kind: "control" | "mark",
    day: number,
    price: ResourceVector,
    now: number,
  ): LiveFundingStamp | null {
    // Work runs on the day it runs: a day captured before an await is not charged after it.
    if (day !== Math.floor(now / DAY)) return null;
    const rows = this.#spendable(kind, day, now);
    const left = Object.fromEntries(R.map((r) => [r, price[r]])) as Record<string, number>;
    const updates: { operation_id: string; remaining: Record<string, number> }[] = [];
    let stamp: LiveFundingStamp | null = null;
    for (const row of rows) {
      const remaining = JSON.parse(row.remaining) as Record<string, number>;
      let changed = false;
      for (const r of R) {
        const take = Math.min(remaining[r] ?? 0, left[r] ?? 0);
        if (take > 0) {
          remaining[r] = (remaining[r] ?? 0) - take;
          left[r] = (left[r] ?? 0) - take;
          changed = true;
        }
      }
      if (changed) {
        updates.push({ operation_id: row.operation_id, remaining });
        stamp = {
          epoch: row.budget_epoch,
          incarnation: row.budget_incarnation,
          seq: row.budget_seq,
          validUntil: row.budget_valid_until,
        };
      }
      if (R.every((r) => left[r] === 0)) break;
    }
    if (!R.every((r) => left[r] === 0)) return null;
    // A balance out of a counter the work needs pays for nothing more (a block's margin past its
    // last unit): drained whole, it no longer counts in its pool.
    for (const u of updates)
      if (R.some((r) => price[r] > 0 && (u.remaining[r] ?? 0) === 0))
        for (const r of R) u.remaining[r] = 0;
    for (const u of updates)
      this.sql.exec(
        "UPDATE live_budget_balances SET remaining = ? WHERE operation_id = ? AND day = ?",
        JSON.stringify(canonicalVector(u.remaining as ResourceVector)),
        u.operation_id,
        day,
      );
    return stamp;
  }

  /** Keeps an ordinary grant's duration completion for its settlement, while the grant is current. */
  complete(grant: LiveEnvelope, completion: LiveDurationCompletion): boolean {
    const plan = grant.plan;
    if (completion.operationId !== grant.operationId) return false;
    if (this.#fenced({ epoch: plan.epoch, incarnation: plan.incarnation, seq: grant.seq }))
      return false;
    this.sql.exec(
      `INSERT INTO live_budget_completions (operation_id, completion, budget_epoch,
         budget_incarnation, budget_seq, budget_valid_until)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      grant.operationId,
      canonicalCompletion(completion),
      plan.epoch,
      plan.incarnation,
      grant.seq,
      plan.validUntil,
    );
    return true;
  }

  /**
   * One bounded page of recovery through `throughSeq`. First the fence,
   * once (durable across pages): the authorization generation moves (no
   * result captured before applies) and the watermark to `throughSeq`
   * (nothing granted through it is spent or installed again), before
   * anything is deleted. Then at most `LIVE_RECOVERY_ROWS` rows inspected
   * in all, through each table's stamp index, invalid ones (older
   * incarnations or epochs) and covered ones deleted by their exact key and
   * stamp (a socket only once its dependencies are gone; a dispatched
   * installation only once its owner is quarantined). Clean once nothing
   * covered is left: local state retired, which is not its work's end nor
   * its places' release (an authorization still running keeps them).
   */
  recoverPage(
    throughSeq: number,
    /** Owners of dispatched installations the directory has quarantined (their places kept). */
    quarantined: ReadonlySet<string> = new Set(),
    /** The fence the recovery was validated under: another since, it touches nothing. */
    expected?: { readonly epoch: number; readonly incarnation: string },
  ): {
    readonly status: "pending" | "clean" | "fenced";
    readonly closedSocketIds: readonly string[];
    readonly inspected: number;
    readonly deleted: number;
  } {
    const current = this.fence();
    if (
      expected &&
      (current.epoch !== expected.epoch || current.incarnation !== expected.incarnation)
    )
      return { status: "fenced", closedSocketIds: [], inspected: 0, deleted: 0 };
    // Old authority refused before anything is deleted, durably (across pages): results captured
    // before now never apply, and nothing granted through `throughSeq` is spent or installed.
    this.sql.exec(
      `UPDATE live_budget_fence SET authorization_gen = authorization_gen + 1, cleanup_through = ?1
       WHERE id = 1 AND cleanup_through < ?1`,
      throughSeq,
    );
    const fence = this.fence();
    let left = LIVE_RECOVERY_ROWS;
    let inspected = 0;
    let deleted = 0;
    let remains = false;
    const closed: string[] = [];
    const stampCols = "budget_incarnation, budget_epoch, budget_seq";
    for (const { table, key } of RECOVERY_TABLES) {
      const order = `ORDER BY ${stampCols}, ${key.join(", ")}`;
      const probes: { where: string; args: (string | number)[]; covered: boolean }[] = [
        { where: "budget_incarnation < ?", args: [fence.incarnation], covered: false },
        { where: "budget_incarnation > ?", args: [fence.incarnation], covered: false },
        {
          where: "budget_incarnation = ? AND budget_epoch < ?",
          args: [fence.incarnation, fence.epoch],
          covered: false,
        },
        {
          where: "budget_incarnation = ? AND budget_epoch = ? AND budget_seq <= ?",
          args: [fence.incarnation, fence.epoch, throughSeq],
          covered: true,
        },
      ];
      for (const probe of probes) {
        // A socket costs two reads (its row, then whether dependencies remain): as many are
        // selected as can be decided.
        const limit = table === "live_local" ? Math.floor(left / 2) : left;
        if (limit === 0) {
          remains = true;
          break;
        }
        const rows = this.sql
          .exec<Stamped>(
            `SELECT ${key.join(", ")}, budget_epoch, budget_incarnation, budget_seq, budget_valid_until
             FROM ${table} INDEXED BY ${table}_budget WHERE ${probe.where} ${order} LIMIT ?`,
            ...probe.args,
            limit,
          )
          .toArray();
        left -= rows.length;
        inspected += rows.length;
        for (const row of rows) {
          if (table === "live_local") {
            // Its dependencies looked for: a row's read of the page too.
            if (left === 0) {
              remains = true;
              break;
            }
            left--;
            inspected++;
            if (
              this.sql
                .exec(
                  "SELECT 1 FROM live_local_deps WHERE socket_id = ? LIMIT 1",
                  row.socket_id as string,
                )
                .toArray().length > 0
            ) {
              remains = true;
              continue;
            }
          }
          // A dispatched installation (or turn) names the owner whose work may still run: it goes
          // only once that owner is quarantined (its place kept); until then recovery cannot be
          // clean.
          const queuedOnly =
            table === "live_budget_pending"
              ? " AND (phase = 'queued' OR owner_id IN (SELECT value FROM json_each(?)))"
              : table === "live_turn"
                ? " AND (phase <> 'dispatched' OR owner_id IN (SELECT value FROM json_each(?)))"
                : "";
          const gone = this.sql.exec(
            `DELETE FROM ${table} WHERE ${key.map((k) => `${k} = ?`).join(" AND ")}
               AND budget_incarnation = ? AND budget_epoch = ? AND budget_seq = ?
               AND budget_valid_until = ?${queuedOnly}`,
            ...key.map((k) => row[k] as string | number),
            row.budget_incarnation,
            row.budget_epoch,
            row.budget_seq,
            row.budget_valid_until,
            ...(queuedOnly ? [JSON.stringify([...quarantined])] : []),
          ).rowsWritten;
          if (gone > 0) {
            deleted++;
            if (table === "live_local") closed.push(row.socket_id as string);
          } else if (queuedOnly) remains = true;
        }
      }
      if (left === 0) {
        remains = true;
        break;
      }
    }
    // Clean: local state retired (not the work's end, nor its places' release).
    const clean = !remains;
    return { status: clean ? "clean" : "pending", closedSocketIds: closed, inspected, deleted };
  }
}
