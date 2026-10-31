import { createLogger, type Metrics } from "@fyrden/adapters-cloudflare/obs";
import { eventKey } from "@fyrden/domain";
import type { Snapshot } from "../queues/events-consumer.js";
import { READ_MODEL_ADMISSION } from "../read-model/executor.js";
import {
  ADMITTED,
  admitStatements,
  STATEMENT_ROWS,
  settleStatement,
  spentStatement,
  usedBy,
} from "./admission.js";
import { repairStatement } from "./repairs.js";
import { searchStatements } from "./statements.js";

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
 * Rows a batch reserves for its bookkeeping besides its statements': up to
 * three requests for a reconciliation (two rows each), and its admission.
 * (The size it leaves is its writer's observation, recorded once an invocation.)
 */
const BOOKKEEPING_ROWS = 6 + READ_MODEL_ADMISSION.rows;

/** One message's search statements, around the consumer's own in its batch. */
export interface LiveSearch {
  /** Before the source's epoch is recorded (they read the epoch held). */
  readonly before: readonly D1PreparedStatement[];
  /** After the repository's own rows. */
  readonly after: readonly D1PreparedStatement[];
  /**
   * What settles the batch's reservation (or counts what it wrote, when it
   * reserved nothing or was refused), from the results of `before` and
   * `after` and the batch's last, with the rows the repository's index entry
   * wrote in the batch (`indexed`); charged with the admission of the batch
   * they are applied in unless `admitted` is false (another in that batch
   * is charged with it).
   */
  settlement(
    before: readonly D1Result[],
    after: readonly D1Result[],
    last: D1Result | undefined,
    admitted?: boolean,
    indexed?: number,
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
  let projected = 0;
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
      const statements = searchStatements(db, position, entity, {
        by: "event",
        admission: { token, removal: entity.deleted },
      });
      if (statements) {
        projections.push(...statements);
        projected++;
      }
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
  const reserved = projected * STATEMENT_ROWS + BOOKKEEPING_ROWS;
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
      : [...(admitting ? admitStatements(db, token, reserved) : []), ...writes];
  return {
    before,
    after,
    settlement(beforeResults, results, last, admitted = true, indexed = 0) {
      const admission = admitting ? results.slice(0, 2) : [];
      const day = (admission[1]?.results[0] as { day?: number } | undefined)?.day;
      const overhead = usedBy(admission);
      // The epoch's request too (written before the reservation, charged with it), and, when
      // search has statements of its own in the batch, the batch's admission, which the executor
      // counts with the batch's last result: when statements of others follow search's, that one
      // is not among these.
      const after = usedBy([...beforeResults, ...results.slice(admission.length)]);
      const othersLast = results.length > 0 && last !== undefined && last !== results.at(-1);
      const used = {
        rows: after.rows + (othersLast ? READ_MODEL_ADMISSION.rows : 0) + indexed,
        reads: after.reads,
      };
      if (day !== undefined)
        // Settling charges its own statements.
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
            admitted,
          ),
        ];
      const rows = overhead.rows + used.rows;
      // Nothing written: nothing to charge.
      if (rows === 0) return [];
      // With the admission of the batch it is applied in, when charged with it.
      const batch = admitted ? READ_MODEL_ADMISSION : { rows: 0, reads: 0 };
      return [spentStatement(db, { rows: rows + batch.rows, reads: batch.reads })];
    },
  };
}

/**
 * What an invocation's batches leave of search's settlements, by read
 * model, applied together after its messages: one call an invocation, its
 * admission charged once. What is not applied leaves its reservation spent.
 */
export class Settling {
  readonly #settlements = new Map<
    D1Database,
    ((admitted: boolean) => readonly D1PreparedStatement[])[]
  >();

  /** A batch's settlement, built once it is known whether it is charged with the admission. */
  add(db: D1Database, settle: (admitted: boolean) => readonly D1PreparedStatement[]): void {
    const list = this.#settlements.get(db);
    if (list) list.push(settle);
    else this.#settlements.set(db, [settle]);
  }

  /** Never throws: a failure is logged. */
  async apply(metrics?: Metrics): Promise<void> {
    for (const [db, settlements] of this.#settlements) {
      const statements: D1PreparedStatement[] = [];
      for (const settle of settlements) statements.push(...settle(statements.length === 0));
      if (statements.length === 0) continue;
      try {
        metrics?.count("d1.query", { db: "org", op: "search_settle" });
        await db.batch(statements);
      } catch (error) {
        createLogger({ op: "search.live" }).warn("settling search's allowance failed", { error });
      }
    }
    this.#settlements.clear();
  }
}
