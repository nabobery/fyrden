import { DISCRETIONARY_RESOURCES, type ResourceVector } from "../../effects/discretionary.js";
import {
  canonicalCompletion,
  canonicalVector,
  type LiveDurationCompletion,
  type LiveEnvelope,
} from "../../live/budget.js";

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
   * newer one of the kind replaces it). False when the funding is not current.
   */
  begin(
    kind: PendingKind,
    operationId: string,
    intendedAt: number,
    funding: LiveFundingStamp,
    now: number,
  ): boolean {
    if (this.#fenced(funding) || now >= funding.validUntil) return false;
    this.sql.exec(
      `INSERT INTO live_budget_pending (kind, operation_id, intended_at, authorization_gen,
         budget_epoch, budget_incarnation, budget_seq, budget_valid_until)
       SELECT ?1, ?2, ?3, authorization_gen, ?4, ?5, ?6, ?7 FROM live_budget_fence WHERE id = 1
       ON CONFLICT (kind) DO UPDATE SET operation_id = excluded.operation_id,
         intended_at = excluded.intended_at, authorization_gen = excluded.authorization_gen,
         budget_epoch = excluded.budget_epoch, budget_incarnation = excluded.budget_incarnation,
         budget_seq = excluded.budget_seq, budget_valid_until = excluded.budget_valid_until`,
      kind,
      operationId,
      intendedAt,
      funding.epoch,
      funding.incarnation,
      funding.seq,
      funding.validUntil,
    );
    return true;
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
   * One bounded page of recovery through `throughSeq`: at most
   * `LIVE_RECOVERY_ROWS` rows inspected in all, through each table's stamp
   * index, invalid ones (older incarnations or epochs) and covered expired
   * ones deleted by their exact key and stamp (a socket only once its
   * dependencies are gone; covered completions at once, their duration kept
   * charged). Clean only when nothing covered is left and no authorization
   * is outstanding: the watermark then moves to `throughSeq`.
   */
  recoverPage(
    throughSeq: number,
    now: number,
    physicalOwnerPending: boolean,
  ): {
    readonly status: "pending" | "clean";
    readonly closedSocketIds: readonly string[];
    readonly inspected: number;
    readonly deleted: number;
  } {
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
          // Covered state still valid stays (completions are retired at once, conservatively).
          if (
            probe.covered &&
            table !== "live_budget_completions" &&
            row.budget_valid_until > now
          ) {
            remains = true;
            continue;
          }
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
          const gone = this.sql.exec(
            `DELETE FROM ${table} WHERE ${key.map((k) => `${k} = ?`).join(" AND ")}
               AND budget_incarnation = ? AND budget_epoch = ? AND budget_seq = ?
               AND budget_valid_until = ?`,
            ...key.map((k) => row[k] as string | number),
            row.budget_incarnation,
            row.budget_epoch,
            row.budget_seq,
            row.budget_valid_until,
          ).rowsWritten;
          if (gone > 0) {
            deleted++;
            if (table === "live_local") closed.push(row.socket_id as string);
          }
        }
      }
      if (left === 0) {
        remains = true;
        break;
      }
    }
    const clean = !remains && !physicalOwnerPending;
    if (clean)
      this.sql.exec(
        `UPDATE live_budget_fence SET cleanup_through = max(cleanup_through, ?1)
         WHERE id = 1 AND epoch = ?2 AND incarnation = ?3`,
        throughSeq,
        fence.epoch,
        fence.incarnation,
      );
    return { status: clean ? "clean" : "pending", closedSocketIds: closed, inspected, deleted };
  }
}
