import { createLogger, type Metrics } from "@fyrden/adapters-cloudflare/obs";
import { eventKey } from "@fyrden/domain";
import type { Snapshot } from "../queues/events-consumer.js";
import {
  ADMITTED,
  admitStatements,
  STATEMENT_ROWS,
  settleStatement,
  sizeStatement,
  spentStatement,
  tickStatement,
  usedBy,
} from "./admission.js";
import { repairStatement } from "./repairs.js";
import { searchStatement } from "./statements.js";

/*
 * Search's projections written by the events consumer while search
 * indexing is on, in each message's own batch (no call of their own): the
 * newest snapshot of each issue, pull request, label and milestone an
 * envelope carries, under the day's allowance and the database's size
 * threshold. Those limits hold back additions only: a deletion is made
 * whatever they say (it empties a row, or keeps one without text where
 * none was). What the projections then miss asks for the source's
 * reconciliation in the same batch: its epoch advanced (a restored
 * repository), a stored payload was gone, the admission was refused, or a
 * row could not be read.
 */

/**
 * Rows a batch reserves for its bookkeeping besides its statements': the
 * write clock's tick and up to three requests for a reconciliation.
 */
const BOOKKEEPING_ROWS = 7;

/** One message's search statements, around the consumer's own in its batch. */
export interface LiveSearch {
  /** Before the source's epoch is recorded (they read the epoch held). */
  readonly before: readonly D1PreparedStatement[];
  /** After the repository's own rows. */
  readonly after: readonly D1PreparedStatement[];
  /**
   * What settles the batch's reservation (or counts what it wrote, when it
   * reserved nothing or was refused) and records the size the batch left
   * the database at, from the results of `before` and `after` and the
   * batch's last.
   */
  settlement(
    before: readonly D1Result[],
    after: readonly D1Result[],
    last: D1Result | undefined,
  ): D1PreparedStatement[];
}

export function liveSearch(
  db: D1Database,
  repoId: string,
  snapshots: readonly Snapshot[],
  options: { epochGen: number; now: number; missing: boolean; token?: string },
): LiveSearch {
  const { epochGen, now } = options;
  const token = options.token ?? crypto.randomUUID();
  const projections: D1PreparedStatement[] = [];
  let malformed = false;
  for (const event of snapshots) {
    const { entity } = event;
    const position = {
      repoId,
      epochGen: event.id.epochGen,
      ownerGen: event.ownerGen,
      sourceSeq: event.id.sourceSeq,
    };
    try {
      // A deletion empties a row already there whatever the admission (the database shrinks); one
      // of an entity never projected adds a row, admitted as any other.
      const statement = searchStatement(db, position, entity, {
        by: "event",
        admission: { token, removal: entity.deleted },
      });
      if (statement) projections.push(statement);
    } catch (error) {
      // Skipped: the rest of the envelope applies, and the reconciliation reads it again.
      malformed = true;
      createLogger({ op: "search.live" }).warn("a snapshot search cannot project", {
        error,
        event: eventKey(event.id),
      });
    }
  }
  const before = [
    repairStatement(db, repoId, "epoch_advanced", now, {
      where: "EXISTS (SELECT 1 FROM consumer_epochs WHERE source_id = ?1 AND epoch_gen < ?4)",
      value: epochGen,
    }),
  ];
  const admitting = projections.length > 0;
  const reserved = projections.length * STATEMENT_ROWS + BOOKKEEPING_ROWS;
  const requests = [
    ...(admitting
      ? [
          repairStatement(db, repoId, "admission", now, {
            where: `NOT ${ADMITTED(4)}`,
            value: token,
          }),
        ]
      : []),
    ...(options.missing ? [repairStatement(db, repoId, "payload_missing", now)] : []),
    ...(malformed ? [repairStatement(db, repoId, "malformed_row", now)] : []),
  ];
  const writes = [...projections, ...requests];
  const after =
    writes.length === 0
      ? []
      : [
          ...(admitting ? admitStatements(db, token, reserved) : []),
          ...writes,
          // Last of search's: the batch's place among the size observations.
          tickStatement(db),
        ];
  return {
    before,
    after,
    settlement(beforeResults, results, last) {
      const admission = admitting ? results.slice(0, 2) : [];
      const day = (admission[1]?.results[0] as { day?: number } | undefined)?.day;
      const overhead = usedBy(admission);
      // The epoch's request too (written before the reservation, charged with it).
      const used = usedBy([...beforeResults, ...results.slice(admission.length)]);
      const tick = (results.at(-1)?.results[0] as { clock?: number } | undefined)?.clock;
      const bytes = last?.meta.size_after;
      const size =
        tick !== undefined && bytes !== undefined ? [sizeStatement(db, tick, bytes)] : [];
      if (day !== undefined)
        // Settling charges its own statements (the size observation's included).
        return [
          settleStatement(
            db,
            {
              day,
              rows: reserved,
              reads: 0,
              overhead: { rows: overhead.rows, reads: 0 },
              removalsOnly: false,
            },
            { rows: used.rows, reads: 0 },
          ),
          ...size,
        ];
      const rows = overhead.rows + used.rows + size.length;
      // Nothing written, nothing to observe: nothing to charge.
      if (rows === 0 && size.length === 0) return [];
      return [spentStatement(db, { rows, reads: 0 }), ...size];
    },
  };
}

/**
 * What an invocation's batches leave of search's bookkeeping (settlements
 * and size observations), by read model, applied together after its
 * messages: one call an invocation. What is not applied leaves its
 * reservation spent.
 */
export class Settling {
  readonly #statements = new Map<D1Database, D1PreparedStatement[]>();

  add(db: D1Database, statements: readonly D1PreparedStatement[]): void {
    const list = this.#statements.get(db);
    if (list) list.push(...statements);
    else this.#statements.set(db, [...statements]);
  }

  /** Never throws: a failure is logged. */
  async apply(metrics?: Metrics): Promise<void> {
    for (const [db, statements] of this.#statements) {
      if (statements.length === 0) continue;
      try {
        metrics?.count("d1.query", { db: "org", op: "search_settle" });
        await db.batch(statements);
      } catch (error) {
        createLogger({ op: "search.live" }).warn("settling search's allowance failed", { error });
      }
    }
    this.#statements.clear();
  }
}
