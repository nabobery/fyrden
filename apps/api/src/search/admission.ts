import { READ_MODEL_ADMISSION, releaseStatements } from "../read-model/executor.js";
/*
 * What search may spend of the org database: each UTC day's allowance of
 * projection rows written and of rows its maintenance reads, and room under
 * a size threshold left for everything else the database holds (effects,
 * webhooks). A step reserves its worst case before it runs and settles to
 * what it used after; a step whose day ends before it writes is refused by
 * its own statements (it runs again, reserving from the new day). A
 * reservation never settled stays spent.
 */

/** Proposed values. */
export const ADMISSION = {
  /** Projection rows search may write a day. */
  dailyRows: 40_000,
  /** Rows its maintenance (reconciliations) may read a day. */
  dailyReads: 1_000_000,
  /** The database size above which search writes nothing more (Free's limit is 500 MB). */
  maxBytes: 350 * 1024 * 1024,
  /** Rows search's repository index may write a day (its own allowance). */
  repoDailyRows: 2_000,
};

/**
 * How much a batch's projections may grow the database, reserved before
 * they are written: `factor` times their rows' bytes (their JSON, a bound
 * on the text indexed), and `entity` bytes more each (its rows, keys and
 * index entries). Provisional, until measured: generous on purpose.
 */
export const GROWTH = { factor: 4, entity: 8_192 };

/** The bytes `rows` (projected entities' rows; a deletion's null) may grow the database by. */
export function growthOf(rows: readonly (Record<string, unknown> | null)[]): number {
  let bytes = 0;
  for (const row of rows)
    bytes += GROWTH.entity + (row ? GROWTH.factor * utf8(JSON.stringify(row)) : 0);
  return bytes;
}

const encoder = new TextEncoder();
const utf8 = (text: string) => encoder.encode(text).byteLength;

/**
 * The database's own UTC day, as days since the Unix epoch: reservations and
 * the statements they admit both read the same clock.
 */
export const TODAY = "CAST(unixepoch() / 86400 AS INTEGER)";

/** SQL true while the database's day is still `?<n>` (a reservation's). */
export const SAME_DAY = (n: number) => `${TODAY} = ?${n}`;

/**
 * SQL true when the batch whose token is `?<n>` was admitted today, in this
 * batch (its receipt carries the batch's executor sequence; see
 * `admitStatements`).
 */
export const ADMITTED = (n: number) =>
  `EXISTS (SELECT 1 FROM search_byte_reservations r JOIN read_model_write w ON w.id = 1
    WHERE r.token = ?${n} AND r.day = ${TODAY} AND r.sequence = w.seq AND w.open = 1)`;

/**
 * Rows one projected entity's statements write, reserved: an issue first
 * projected writes 12 (its row and indexes, its repository's number, the
 * counters and its full-text entry; measured, a 9,000-word body as many as
 * a short one), and the full-text index's merges now and then more (not
 * measured; settled at what was written).
 */
export const STATEMENT_ROWS = 16;

/** Rows one projected entity's statements read, reserved (an issue's group: 26, measured). */
export const STATEMENT_READS = 40;

export interface Reservation {
  readonly day: number;
  readonly rows: number;
  readonly reads: number;
  /** What reserving itself wrote and read, charged when it is settled. */
  readonly overhead: { readonly rows: number; readonly reads: number };
  /**
   * The database is at its size threshold: the step may only remove (mark
   * deleted what is gone, empty text), never add.
   */
  readonly removalsOnly: boolean;
}

/**
 * What settling a reservation writes and reads (its own update, measured,
 * and its admission), charged with it.
 */
export const SETTLING = {
  rows: 1 + READ_MODEL_ADMISSION.rows,
  reads: 5 + READ_MODEL_ADMISSION.reads,
};

/**
 * What a spending made in a batch of its own costs besides what it charges
 * and its own statement (which it charges itself): its admission.
 */
export const SPENDING = {
  rows: READ_MODEL_ADMISSION.rows,
  reads: READ_MODEL_ADMISSION.reads,
};

/** A spending's own statement: its row and the reads of its upsert (measured). */
const SPENT = { rows: 1, reads: 8 };

/**
 * Reserves `rows` and `reads` from the database's day; null when the day's
 * allowance cannot hold them. At the size threshold the reservation allows
 * removals only (`removalsOnly`), once the size has been looked at again
 * (a later observation: the database may have shrunk since the one held,
 * through removals that report none). What reserving cost (the refresh
 * included) is charged with the reservation; a refused one's is spent
 * anyway.
 */
export async function reserve(
  db: D1Database,
  wanted: { rows: number; reads: number },
): Promise<Reservation | null> {
  // Every attempt's own cost, and a refresh's, charged with the reservation or spent anyway.
  const cost = { rows: 0, reads: 0 };
  const add = (results: readonly D1Result[]) => {
    const used = usedBy(results);
    cost.rows += used.rows;
    cost.reads += used.reads;
  };
  const refused = async () => {
    // With the spending's own batch.
    await spentStatement(db, {
      rows: cost.rows + SPENDING.rows,
      reads: cost.reads + SPENDING.reads,
    }).run();
    return null;
  };
  {
    const results = await db.batch([
      db.prepare(`INSERT INTO search_budget (day) VALUES (${TODAY}) ON CONFLICT (day) DO NOTHING`),
      db
        .prepare(
          `UPDATE search_budget SET rows = rows + ?1, reads = reads + ?2
           WHERE day = ${TODAY} AND rows + ?1 <= ?3 AND reads + ?2 <= ?4
           RETURNING day`,
        )
        .bind(wanted.rows, wanted.reads, ADMISSION.dailyRows, ADMISSION.dailyReads),
      db
        .prepare(`SELECT bytes + bytes_reserved >= ?1 AS full FROM search_size WHERE id = 1`)
        .bind(ADMISSION.maxBytes),
    ]);
    add(results);
    const day = (results[1]?.results[0] as { day?: number } | undefined)?.day;
    if (day === undefined) return refused();
    let full = (results[2]?.results[0] as { full?: number } | undefined)?.full === 1;
    if (full) {
      // The size held is at the threshold: observe it again (a batch's own report).
      const ticked = await db.batch([tickStatement(db)]);
      add(ticked);
      const tick = (ticked[0]?.results[0] as { clock?: number } | undefined)?.clock;
      const bytes = ticked[0]?.meta.size_after;
      if (tick !== undefined && bytes !== undefined) {
        // Recorded, with the growth it covers released: what is still reserved counts too.
        const refreshed = await db.batch([
          sizeStatement(db, tick, bytes),
          ...releaseStatements(db),
          db
            .prepare("SELECT bytes + bytes_reserved >= ?1 AS full FROM search_size WHERE id = 1")
            .bind(ADMISSION.maxBytes),
        ]);
        // The releases were charged with the batches whose growth they release.
        add([refreshed[0], refreshed.at(-1)].filter((r) => r !== undefined));
        full = (refreshed.at(-1)?.results[0] as { full?: number } | undefined)?.full === 1;
      }
    }
    return { day, ...wanted, overhead: { ...cost }, removalsOnly: full };
  }
}

/**
 * Settles a reservation to what its step used, with what reserving and
 * settling it cost: the rest goes back, and a step that used more than it
 * reserved is charged all of it (the day may then end over its allowance).
 */
export function settleStatement(
  db: D1Database,
  reservation: Reservation,
  used: { rows: number; reads: number },
  /** Whether the batch it is applied in is charged with it (others in that batch charge none). */
  admitted = true,
): D1PreparedStatement {
  const settling = admitted
    ? SETTLING
    : {
        rows: SETTLING.rows - READ_MODEL_ADMISSION.rows,
        reads: SETTLING.reads - READ_MODEL_ADMISSION.reads,
      };
  // What was used, all of it: more than was reserved too (an estimate exceeded is still spent).
  const rows = used.rows + reservation.overhead.rows + settling.rows;
  const reads = used.reads + reservation.overhead.reads + settling.reads;
  return db
    .prepare(
      `UPDATE search_budget SET rows = rows - ?2 + ?4, reads = reads - ?3 + ?5 WHERE day = ?1`,
    )
    .bind(reservation.day, reservation.rows, reservation.reads, rows, reads);
}

/**
 * Counts writes made without a reservation (removals, which shrink the
 * database), with this statement's own.
 */
export function spentStatement(
  db: D1Database,
  used: { rows: number; reads: number },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO search_budget (day, rows, reads) VALUES (${TODAY}, ?1, ?2)
       ON CONFLICT (day) DO UPDATE SET rows = rows + excluded.rows, reads = reads + excluded.reads`,
    )
    .bind(used.rows + SPENT.rows, used.reads + SPENT.reads);
}

/**
 * The statements a batch reserves `rows` of the day's allowance and
 * `bytes` of growth with, in the batch itself (no call of their own):
 * today's row; the reservation, made only when the rows fit the day's
 * allowance and the size held, with every growth reserved and not yet
 * observed, and this batch's, stays within the threshold (`RETURNING day`
 * when made); then its receipt (`token`, the day, the batch's executor
 * sequence and its bytes), and the bytes held reserved until an observation
 * of the database's size covers that sequence (`releaseStatements`). The
 * batch's guarded writes check the receipt (`ADMITTED`).
 */
export function admitStatements(
  db: D1Database,
  token: string,
  rows: number,
  bytes: number,
): D1PreparedStatement[] {
  return [
    db.prepare(`INSERT INTO search_budget (day) VALUES (${TODAY}) ON CONFLICT (day) DO NOTHING`),
    db
      .prepare(
        `UPDATE search_budget SET rows = rows + ?1, admitted = ?2
         WHERE day = ${TODAY} AND rows + ?1 <= ?3
           AND EXISTS (SELECT 1 FROM search_size
             WHERE id = 1 AND bytes + bytes_reserved + ?5 <= ?4)
         RETURNING day`,
      )
      .bind(rows, token, ADMISSION.dailyRows, ADMISSION.maxBytes, bytes),
    ...receiptStatements(db, token, bytes),
  ];
}

/**
 * The statements a batch whose rows were reserved before (`day`, a
 * reconciliation's) admits its growth with: made only while it is still
 * that day and the size held, with every growth reserved and not yet
 * observed, and this batch's, stays within the threshold; then its receipt.
 */
export function growthStatements(
  db: D1Database,
  token: string,
  day: number,
  bytes: number,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE search_budget SET admitted = ?1
         WHERE day = ?2 AND day = ${TODAY}
           AND EXISTS (SELECT 1 FROM search_size
             WHERE id = 1 AND bytes + bytes_reserved + ?3 <= ?4)`,
      )
      .bind(token, day, bytes, ADMISSION.maxBytes),
    ...receiptStatements(db, token, bytes),
  ];
}

/** Statements `admitStatements` makes (its results come first in the batch). */
export const ADMIT_STATEMENTS = 4;

/**
 * What a receipt's release costs later (its row deleted, the bytes it held
 * released, in an observation's write; measured): charged with the batch
 * that made it.
 */
export const RECEIPT_RELEASE = { rows: 2, reads: 16 };

/**
 * The receipt of a reservation this batch made (its row marked `token`):
 * its day, the batch's executor sequence and its `bytes`, held reserved.
 */
export function receiptStatements(
  db: D1Database,
  token: string,
  bytes: number,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO search_byte_reservations (token, day, sequence, bytes)
         SELECT ?1, b.day, w.seq, ?2 FROM search_budget b JOIN read_model_write w ON w.id = 1
         WHERE b.day = ${TODAY} AND b.admitted = ?1 AND w.open = 1`,
      )
      .bind(token, bytes),
    db
      .prepare(
        `UPDATE search_size SET bytes_reserved = bytes_reserved + ?2
         WHERE id = 1 AND ${ADMITTED(1)}`,
      )
      .bind(token, bytes),
  ];
}

/** D1 calls an invocation may still make (a batch is one). */
export interface CallBudget {
  left: number;
}

/** `db` whose every call (a query or a batch) is taken from `calls`. */
export function counted(db: D1Database, calls: CallBudget): D1Database {
  // The statements handed out, by what they stand for (a batch takes the real ones).
  const real = new WeakMap<object, D1PreparedStatement>();
  const take = <T>(call: () => Promise<T>) => {
    calls.left--;
    return call();
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, prop) {
        if (prop === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        if (prop === "first" || prop === "all" || prop === "run" || prop === "raw")
          return (...args: unknown[]) =>
            take(() =>
              (Reflect.get(target, prop) as (...a: unknown[]) => Promise<unknown>).apply(
                target,
                args,
              ),
            );
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    real.set(proxy, statement);
    return proxy;
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "batch")
        return (statements: D1PreparedStatement[]) =>
          take(() => target.batch(statements.map((s) => real.get(s) ?? s)));
      if (prop === "prepare") return (sql: string) => wrap(target.prepare(sql));
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * The write clock's next tick, returned: past every executor commit's
 * sequence (and every executor commit after it is past the tick), so a
 * refresh's size and a writer's observation are ordered as they committed.
 */
export function tickStatement(db: D1Database): D1PreparedStatement {
  return db.prepare(
    `UPDATE search_size SET clock = max(clock, observed,
       coalesce((SELECT seq FROM read_model_write WHERE id = 1), 0)) + 1
     WHERE id = 1 RETURNING clock`,
  );
}

/**
 * Records the database's size a batch reported, unless a later batch's is
 * already held.
 */
export function sizeStatement(db: D1Database, tick: number, bytes: number): D1PreparedStatement {
  return db
    .prepare("UPDATE search_size SET observed = ?1, bytes = ?2 WHERE id = 1 AND observed < ?1")
    .bind(tick, bytes);
}

/** What a batch used, as D1 counts it, and the size it left the database at. */
export function usedBy(results: readonly D1Result[]): {
  rows: number;
  reads: number;
  bytes: number | undefined;
} {
  let rows = 0;
  let reads = 0;
  let bytes: number | undefined;
  for (const result of results) {
    rows += result.meta.rows_written ?? 0;
    reads += result.meta.rows_read ?? 0;
    bytes = result.meta.size_after ?? bytes;
  }
  return { rows, reads, bytes };
}
