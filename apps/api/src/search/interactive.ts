import { OperationError } from "../ops/execute.js";
import { ReadModelRefused } from "../read-model/executor.js";
import { MAINTENANCE_RETRY_MS } from "../read-model/maintenance.js";
import { SAME_DAY, TODAY } from "./admission.js";

/*
 * Searches' reads, an allowance of their own (`search_budget.
 * interactive_reads`), apart from the projections' rows and the
 * reconciliations' reads: a search reserves the most it may read before it
 * reads anything, reads only while it is still its reservation's day (each
 * read batch checks, in itself), and settles once at what it read (the rest
 * given back to that day; more than reserved, all of it charged), never
 * below a search's least charge, which bounds the searches a day and so
 * their bookkeeping writes. A reservation the day cannot hold refuses the
 * search until the next UTC day. Its bookkeeping writes go through the read
 * model's executor: none while it is under maintenance.
 */

export const INTERACTIVE = {
  /** Searches' reads a UTC day (Proposed). */
  dailyReads: 2_000_000,
  /** The least a search is charged, read or not: at most 2,000 searches a day (Proposed). */
  searchReads: 1_000,
} as const;

export interface InteractiveReservation {
  /** Its UTC day (days since the epoch). */
  readonly day: number;
  readonly reads: number;
}

/**
 * A search's reservation's day ended while one of its read batches ran:
 * what the batch read, charged to the new day already (its results are not
 * used).
 */
export class InteractiveDayEnded extends Error {
  constructor(readonly reads: number) {
    super("the search's reservation's day ended");
    this.name = "InteractiveDayEnded";
  }
}

const MS_A_DAY = 86_400_000;

/** Reservations settled (each settles once: a second is a bug, never a refund). */
const settled = new WeakSet<InteractiveReservation>();

function count(n: number, what: string): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${what} must be a count: ${n}`);
  return n;
}

/** A write of the ledger's, as the operations answer one the read model refuses. */
async function written<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ReadModelRefused)
      throw new OperationError(
        503,
        "read_model_maintenance",
        "The read model is under maintenance. Try again later.",
        undefined,
        undefined,
        MAINTENANCE_RETRY_MS / 1000,
      );
    throw error;
  }
}

/**
 * Reserves `reads` (at least a search's least charge) of today's allowance
 * (the read model through its executor: `db`); refused (`search_budget`,
 * until the next UTC day) when today cannot hold them.
 */
export async function reserveInteractive(
  db: D1Database,
  reads: number,
): Promise<InteractiveReservation> {
  const wanted = Math.max(count(reads, "reads"), INTERACTIVE.searchReads);
  // One statement, so one day: the day's row made and charged, or charged, when it holds them.
  const reserved = await written(() =>
    db
      .prepare(
        `INSERT INTO search_budget (day, interactive_reads) SELECT ${TODAY}, ?1 WHERE ?1 <= ?2
         ON CONFLICT (day) DO UPDATE SET interactive_reads = interactive_reads + ?1
           WHERE interactive_reads + ?1 <= ?2
         RETURNING day`,
      )
      .bind(wanted, INTERACTIVE.dailyReads)
      .first<{ day: number }>(),
  );
  if (!reserved) {
    // The clock as it is after the refusal (the day refused may have begun while it was asked).
    const now = Date.now();
    throw new OperationError(
      429,
      "search_budget",
      "Searches have read all they may today. Try again tomorrow (UTC).",
      undefined,
      undefined,
      Math.ceil((MS_A_DAY - (now % MS_A_DAY)) / 1000),
    );
  }
  return { day: reserved.day, reads: wanted };
}

/**
 * Runs `statements` (reads) in one batch, checked in the batch itself to
 * have begun and ended on `reservation`'s day (so each statement began on
 * it); their results. One that did not is charged to the day it is now, held
 * or not (one batch past the allowance at most), and throws
 * `InteractiveDayEnded`, its results not used.
 */
export async function readOnDay(
  db: D1Database,
  reservation: InteractiveReservation,
  statements: D1PreparedStatement[],
): Promise<D1Result<Record<string, unknown>>[]> {
  const sameDay = () => db.prepare(`SELECT ${SAME_DAY(1)} AS same`).bind(reservation.day);
  const done = await db.batch<Record<string, unknown>>([sameDay(), ...statements, sameDay()]);
  const results = done.slice(1, -1);
  if (done[0]?.results[0]?.same === 1 && done.at(-1)?.results[0]?.same === 1) return results;
  const reads = results.reduce((n, r) => n + (r.meta.rows_read ?? 0), 0);
  await written(() =>
    db
      .prepare(
        `INSERT INTO search_budget (day, interactive_reads) VALUES (${TODAY}, ?1)
         ON CONFLICT (day) DO UPDATE SET interactive_reads = interactive_reads + ?1`,
      )
      .bind(reads)
      .run(),
  );
  throw new InteractiveDayEnded(reads);
}

/**
 * Settles `reservation`, once, at `used` reads (at least a search's least
 * charge): what it did not use given back to its day, more than reserved
 * charged all the same.
 */
export async function settleInteractive(
  db: D1Database,
  reservation: InteractiveReservation,
  used: number,
): Promise<void> {
  const charged = Math.max(count(used, "used"), INTERACTIVE.searchReads);
  if (settled.has(reservation)) throw new Error("the reservation is settled already");
  settled.add(reservation);
  await written(() =>
    db
      .prepare(
        `UPDATE search_budget SET interactive_reads = interactive_reads - ?2 + ?3 WHERE day = ?1`,
      )
      .bind(reservation.day, reservation.reads, charged)
      .run(),
  );
}
