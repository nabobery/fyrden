import { d1RowsRun } from "@fyrden/adapters-cloudflare/obs";

/*
 * A feed's turn, metered against its grant: the rows its work reads and
 * writes in the feed's object (every statement's own counters) and in D1
 * (what D1 reported, as the invocation counts it), from when the turn was
 * dispatched. Each optional step of the work (an admission forgotten, a
 * renewal, a refill, a credential's delivery, a prune page) starts only
 * while what was used, the step's most (measured) and the turn's own end
 * still fit its grant; what does not wait for the next turn. So no
 * combination of steps can spend more than the turn was paid for.
 */

/** Rows a turn's work counts against its grant. */
export interface TurnRows {
  readonly do_rows_read: number;
  readonly do_rows_written: number;
  readonly d1_rows_read: number;
  readonly d1_rows_written: number;
}

const COUNTERS = ["do_rows_read", "do_rows_written", "d1_rows_read", "d1_rows_written"] as const;

export const NO_ROWS: TurnRows = {
  do_rows_read: 0,
  do_rows_written: 0,
  d1_rows_read: 0,
  d1_rows_written: 0,
};

/** `rows` times `n`, counter by counter. */
export const times = (rows: TurnRows, n: number): TurnRows =>
  Object.fromEntries(COUNTERS.map((c) => [c, rows[c] * n])) as unknown as TurnRows;

const plus = (a: TurnRows, b: TurnRows): TurnRows =>
  Object.fromEntries(COUNTERS.map((c) => [c, a[c] + b[c]])) as unknown as TurnRows;

const minus = (a: TurnRows, b: TurnRows): TurnRows =>
  Object.fromEntries(COUNTERS.map((c) => [c, a[c] - b[c]])) as unknown as TurnRows;

export class TurnMeter {
  readonly #sql: SqlStorage;
  readonly #exec: SqlStorage["exec"];
  readonly #cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
  readonly #d1: { readonly read: number; readonly written: number };
  readonly #budget: TurnRows;
  readonly #end: TurnRows;
  /** What work paid for elsewhere used (a socket's end, on its terminal provision). */
  #paidElsewhere: TurnRows = NO_ROWS;
  #stopped = false;

  /**
   * Meters `sql`'s statements and the invocation's D1 rows from now: the
   * turn's work fits `budget` (what its grant paid for the day it runs on),
   * keeping `end` (the most its own end uses) for after it.
   */
  constructor(sql: SqlStorage, budget: TurnRows, end: TurnRows) {
    this.#sql = sql;
    this.#exec = sql.exec;
    this.#budget = budget;
    this.#end = end;
    this.#d1 = d1RowsRun();
    const exec = this.#exec;
    const cursors = this.#cursors;
    (sql as { exec: unknown }).exec = (query: string, ...bindings: SqlStorageValue[]) => {
      const cursor = exec.call(sql, query, ...bindings);
      cursors.push(cursor);
      return cursor;
    };
  }

  /** What the turn has used so far. */
  used(): TurnRows {
    const d1 = d1RowsRun();
    let read = 0;
    let written = 0;
    for (const c of this.#cursors) {
      read += c.rowsRead;
      written += c.rowsWritten;
    }
    return minus(
      {
        do_rows_read: read,
        do_rows_written: written,
        d1_rows_read: d1.read - this.#d1.read,
        d1_rows_written: d1.written - this.#d1.written,
      },
      this.#paidElsewhere,
    );
  }

  /**
   * Runs `fn`, work another grant may pay for (a socket's end, on its
   * terminal provision): outside what the turn counts against its own when
   * `fn` says it was paid for (what it used), else the turn's (null).
   */
  exempt(fn: () => boolean): TurnRows | null {
    const before = this.used();
    const paid = fn();
    if (!paid) return null;
    const used = minus(this.used(), before);
    this.#paidElsewhere = plus(this.#paidElsewhere, used);
    return used;
  }

  /** Whether a step using at most `step` still fits, with the turn's end kept for after it. */
  fits(step: TurnRows): boolean {
    const after = plus(plus(this.used(), step), this.#end);
    return COUNTERS.every((c) => after[c] <= this.#budget[c]);
  }

  /** Runs `fn` as one step and gives back what it used (for its measurement). */
  async step<T>(fn: () => Promise<T> | T): Promise<{ value: T; used: TurnRows }> {
    const before = this.used();
    const value = await fn();
    return { value, used: minus(this.used(), before) };
  }

  /** Stops metering: `sql` runs its statements as before (once; again changes nothing). */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    (this.#sql as { exec: unknown }).exec = this.#exec;
  }
}
