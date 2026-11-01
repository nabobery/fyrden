import { DISCRETIONARY_RESOURCES, type ResourceVector } from "../../effects/discretionary.js";
import {
  canonicalCompletion,
  canonicalPlan,
  canonicalVector,
  type LiveDurationCompletion,
  type LiveEnvelope,
  type LiveGrantRequest,
} from "../../live/budget.js";
import type { LiveOwnerRef } from "../../live/owners.js";

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
  install(
    kind: PendingKind,
    grant: LiveEnvelope,
    now: number,
  ): "installed" | "duplicate" | "refused" {
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
    for (const charge of plan.charges)
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

  /** The owners of dispatched installations (their work may still run). */
  dispatchedOwners(): string[] {
    return this.sql
      .exec<{ owner_id: string }>(
        "SELECT owner_id FROM live_budget_pending WHERE phase = 'dispatched' AND owner_id IS NOT NULL",
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
  ): "installed" | "duplicate" | "refused" {
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
    for (const charge of plan.charges)
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
    this.finishPending(kind, identity);
    return "installed";
  }

  /**
   * Spends `price` of today's `kind` credit (`day` must be `now`'s) across
   * the valid grants (oldest first), all of it or nothing.
   */
  spend(kind: "control" | "mark", day: number, price: ResourceVector, now: number): boolean {
    // Work runs on the day it runs: a day captured before an await is not charged after it.
    if (day !== Math.floor(now / DAY)) return false;
    const rows = this.sql
      .exec<{ operation_id: string; remaining: string }>(
        `SELECT b.operation_id, b.remaining FROM live_budget_balances b
           JOIN live_budget_fence f ON f.id = 1
         WHERE b.kind = ?1 AND b.day = ?2 AND b.budget_epoch = f.epoch
           AND b.budget_incarnation = f.incarnation AND b.budget_seq > f.cleanup_through
           AND b.budget_valid_until > ?3
         ORDER BY b.budget_seq, b.operation_id`,
        kind,
        day,
        now,
      )
      .toArray();
    const left = Object.fromEntries(R.map((r) => [r, price[r]])) as Record<string, number>;
    const updates: { operation_id: string; remaining: Record<string, number> }[] = [];
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
      if (changed) updates.push({ operation_id: row.operation_id, remaining });
      if (R.every((r) => left[r] === 0)) break;
    }
    if (!R.every((r) => left[r] === 0)) return false;
    for (const u of updates)
      this.sql.exec(
        "UPDATE live_budget_balances SET remaining = ? WHERE operation_id = ? AND day = ?",
        JSON.stringify(canonicalVector(u.remaining as ResourceVector)),
        u.operation_id,
        day,
      );
    return true;
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
          // A dispatched installation names the owner whose work may still run: it goes only once
          // that owner is quarantined (its place kept); until then recovery cannot be clean.
          const queuedOnly =
            table === "live_budget_pending"
              ? " AND (phase = 'queued' OR owner_id IN (SELECT value FROM json_each(?)))"
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
