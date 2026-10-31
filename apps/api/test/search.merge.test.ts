// What a full-text index's merge really costs, measured against what it
// reserves (`MERGE`): rows written and read, and the database's growth (the
// larger of its size after, as D1 reports it, against the one before, and
// of the bytes the index added), over an index fragmented by many small
// commits (short documents, the longest bodies of distinct terms, many
// edits of a few), merged until a merge changes nothing. Then the repair
// job's merges: one of each index a run, charged what each wrote and read,
// within the calls left, none past the allowance or at the size threshold,
// or while search does not index.

import { env } from "cloudflare:workers";
import { createIdFactory, type IssueRow, secureRandomBytes } from "@fyrden/domain";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_ORG_SHARD, readModelFor } from "../src/events/read-model.js";
import { epochStatement } from "../src/queues/events-consumer.js";
import { withReadModel } from "../src/read-model/executor.js";
import { ADMISSION, RECEIPT_RELEASE, SETTLING, SPENDING } from "../src/search/admission.js";
import { INDEXES, MERGE, MERGE_CALLS } from "../src/search/indexes.js";
import { runSearchRepairs } from "../src/search/repairs.js";
import { docStatements, type SearchPosition } from "../src/search/statements.js";

const newId = createIdFactory(Date.now, secureRandomBytes);
const db = readModelFor(env, DEFAULT_ORG_SHARD);

/** The longest body an issue may have (UTF-16 code units). */
const BODY = 65_536;

/** Distinct short terms, up to `length` characters of them. */
const dense = (seed: number, length: number) => {
  const terms: string[] = [];
  let size = 0;
  for (let i = 0; size < length; i++) {
    const term = `${seed.toString(36)}${i.toString(36)}`;
    terms.push(term);
    size += term.length + 1;
  }
  return terms.join(" ").slice(0, length);
};

const issue = (number: number, body: string): IssueRow => ({
  number,
  title: `Issue ${number}`,
  body,
  state: "open",
  stateReason: null,
  duplicateOf: null,
  locked: false,
  lockReason: null,
  authorId: "agt_author",
  authorRoot: "usr_author",
  closedAt: null,
  closedBy: null,
  createdAt: 1,
  updatedAt: 2,
  assignees: [],
  labels: [],
  milestone: null,
});

/** A source with `count` issues of `text`, each projected in a commit of its own. */
async function fragmented(
  count: number,
  text: (n: number) => string,
  numberOf: (n: number) => number = (n) => n,
): Promise<void> {
  const repoId = newId("rep");
  await withReadModel(env, DEFAULT_ORG_SHARD, async (readModel, writer) => {
    await writer.write([epochStatement(readModel, repoId, 1, 0)]);
    for (let number = 1; number <= count; number++) {
      const position: SearchPosition = { repoId, epochGen: 1, ownerGen: 1, sourceSeq: number };
      await writer.write(
        docStatements(readModel, position, {
          type: "issue",
          id: `${repoId}#${numberOf(number)}`,
          version: number,
          deleted: false,
          row: issue(numberOf(number), text(number)) as unknown as Record<string, unknown>,
        }),
      );
    }
  });
}

/** The bytes an index holds. */
const held = (table: string) =>
  db
    .prepare(`SELECT coalesce(sum(length(block)), 0) AS bytes FROM ${table}_data`)
    .first<{ bytes: number }>()
    .then((r) => r?.bytes ?? 0);

interface Measured {
  grew: number;
  rows: number;
  reads: number;
  /** The rows the merge changed (its work, the index's own: D1 counts none of it as written). */
  changed: number;
}

/** Merges `table` (`MERGE.pages` of work) in a batch of its own: what it grew, cost and did. */
async function merge(table: string): Promise<Measured> {
  return withReadModel(env, DEFAULT_ORG_SHARD, async (readModel, writer) => {
    const before = (await writer.write([readModel.prepare("SELECT 1")])).usage.bytes ?? 0;
    const logical = await held(table);
    const changes = () => readModel.prepare("SELECT total_changes() AS n");
    const { results, usage } = await writer.write([
      changes(),
      readModel
        .prepare(`INSERT INTO ${table} (${table}, rank) VALUES ('merge', ?)`)
        .bind(MERGE.pages),
      changes(),
    ]);
    const changed = (r: D1Result | undefined) =>
      (r?.results[0] as { n: number } | undefined)?.n ?? 0;
    return {
      grew: Math.max((usage.bytes ?? 0) - before, (await held(table)) - logical, 0),
      // The batch's (its admission's with its last result): the counts of changes write and read none.
      rows: results.reduce((n, r) => n + (r.meta.rows_written ?? 0), 0),
      reads: results.reduce((n, r) => n + (r.meta.rows_read ?? 0), 0),
      // Less the command's own change.
      changed: changed(results[2]) - changed(results[0]) - 1,
    };
  });
}

/** Merges until a merge does nothing: every merge's cost (at most `most`, and then it fails). */
async function mergedThrough(table: string, most = 40): Promise<Measured[]> {
  const seen: Measured[] = [];
  for (let i = 0; i < most; i++) {
    const measured = await merge(table);
    seen.push(measured);
    if (measured.changed === 0) return seen;
  }
  throw new Error(`${table} still merging after ${most} merges`);
}

/**
 * What limits.md states as measured: the rows D1 counts a merge written
 * and read (its batch's admission's), and its growth at most (a page, by
 * the order of the tests before it: the free pages they left).
 */
const LIMITS = { grew: 4_096, rows: 3, reads: 6 };

describe("a full-text index's merge, measured against its reservation", () => {
  it("of indexes fragmented by many small commits, each merged until it has nothing left", async () => {
    // In one order, each history added to the index as it stands (the others' before it).
    const histories: [number, (n: number) => string, ((n: number) => number)?][] = [
      [300, (n) => `Something is broken ${n}.`],
      [24, (n) => dense(n, BODY)],
      [300, (n) => dense(n, 2_000), (n) => (n % 5) + 1],
    ];
    const seen: Measured[] = [];
    for (const [count, text, numberOf] of histories) {
      await fragmented(count, text, numberOf);
      seen.push(...(await mergedThrough(INDEXES.documents)));
    }
    const most = (key: keyof Measured) => Math.max(...seen.map((m) => m[key]));
    // Some merge had work to do; none cost more than limits.md states, or than it reserves.
    expect(most("changed")).toBeGreaterThan(0);
    expect({ rows: most("rows"), reads: most("reads") }).toEqual({
      rows: LIMITS.rows,
      reads: LIMITS.reads,
    });
    expect(most("grew")).toBeLessThanOrEqual(LIMITS.grew);
    expect(LIMITS.grew).toBeLessThanOrEqual(MERGE.bytes);
    expect(LIMITS.rows).toBeLessThanOrEqual(MERGE.rows);
  });
});

/** Rows and reads of the merges' batches (their admission's included), as `env` sees them. */
interface Recorded {
  batches: { rows: number; reads: number }[];
  /** Run before the merge batch numbered so (from 0). */
  before?: Map<number, () => Promise<void>>;
}

/** `env` whose merge batches are recorded in `seen`. */
function recording(seen: Recorded): Env {
  const org = new Proxy(env.ORG_READ, {
    get(target, prop) {
      if (prop === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const sql = statements.map((s) => (s as unknown as { statement: string }).statement);
          if (!sql.some((q) => q.includes("'merge'"))) return target.batch(statements);
          await seen.before?.get(seen.batches.length)?.();
          const results = await target.batch(statements);
          seen.batches.push({
            rows: results.reduce((n, r) => n + (r.meta.rows_written ?? 0), 0),
            reads: results.reduce((n, r) => n + (r.meta.rows_read ?? 0), 0),
          });
          return results;
        };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(env, {
    get: (target, prop) => (prop === "ORG_READ" ? org : Reflect.get(target, prop)),
  });
}

const sum = (batches: Recorded["batches"], key: "rows" | "reads") =>
  batches.reduce((n, b) => n + b[key], 0);

async function indexing(on: boolean): Promise<void> {
  await (on
    ? env.DIRECTORY.prepare(
        `INSERT INTO deployment_settings (name, value, updated_at) VALUES ('search_indexing', 'on', 0)
         ON CONFLICT (name) DO UPDATE SET value = 'on'`,
      )
    : env.DIRECTORY.prepare("DELETE FROM deployment_settings WHERE name = 'search_indexing'")
  ).run();
}

afterEach(() => indexing(false));

describe("the repair job's merges", () => {
  const today = async () =>
    db
      .prepare(
        "SELECT rows, reads FROM search_budget WHERE day = CAST(unixepoch() / 86400 AS INTEGER)",
      )
      .first<{ rows: number; reads: number }>()
      .then((r) => r ?? { rows: 0, reads: 0 });

  /**
   * What a run charged search's allowance, less a run's too few calls to merge charged (`then`
   * between them: the first run's size observation records the size it finds).
   */
  async function charged(
    run: () => Promise<unknown>,
    then?: () => Promise<unknown>,
  ): Promise<{ rows: number; reads: number }> {
    const before = await today();
    expect(await runSearchRepairs(env, { calls: 6 })).toEqual({ worked: 0, merged: 0 });
    const between = await today();
    await then?.();
    await run();
    const after = await today();
    return {
      rows: after.rows - between.rows - (between.rows - before.rows),
      reads: after.reads - between.reads - (between.reads - before.reads),
    };
  }

  it("merges each index once a run, charged what each wrote and read", async () => {
    await db.prepare("DELETE FROM search_repairs").run();
    await fragmented(40, (n) => `Fragment ${n}`);
    await indexing(true);
    const seen: Recorded = { batches: [] };
    const merges = await charged(async () =>
      expect(await runSearchRepairs(recording(seen))).toEqual({ worked: 0, merged: 2 }),
    );
    expect(seen.batches).toHaveLength(2);
    // Each its batch, its receipt's release (later, by an observation) and its settlement; what
    // it reserved given back.
    expect(merges).toEqual({
      rows: sum(seen.batches, "rows") + 2 * (RECEIPT_RELEASE.rows + SETTLING.rows),
      reads: sum(seen.batches, "reads") + 2 * (RECEIPT_RELEASE.reads + SETTLING.reads),
    });
  });

  it("merges no more than the calls leave room for, the run's own last call kept", async () => {
    await db.prepare("DELETE FROM search_repairs").run();
    await indexing(true);
    // The run's own six, and one merge's two.
    expect(await runSearchRepairs(env, { calls: 6 + MERGE_CALLS })).toEqual({
      worked: 0,
      merged: 1,
    });
  });

  it("merges nothing at the size threshold, its refused batch still spent", async () => {
    await db.prepare("DELETE FROM search_repairs").run();
    await indexing(true);
    const threshold = async () => {
      await withReadModel(env, DEFAULT_ORG_SHARD, (readModel) =>
        readModel.prepare("UPDATE search_size SET bytes = bytes WHERE id = 1").run(),
      );
      await db
        .prepare("UPDATE search_size SET bytes = ? WHERE id = 1")
        .bind(ADMISSION.maxBytes - 1)
        .run();
    };
    try {
      const seen: Recorded = { batches: [] };
      const refused = await charged(
        async () =>
          expect(await runSearchRepairs(recording(seen))).toEqual({ worked: 0, merged: 0 }),
        threshold,
      );
      // The first refused, the other not tried; its batch spent, with the spending's own.
      expect(seen.batches).toHaveLength(1);
      expect(refused.rows).toBe(sum(seen.batches, "rows") + SPENDING.rows + 1);
    } finally {
      await db.prepare("UPDATE search_size SET bytes = 0 WHERE id = 1").run();
    }
  });

  it("merges the one index its allowance admits, the other refused", async () => {
    await db.prepare("DELETE FROM search_repairs").run();
    await indexing(true);
    // The day's allowance spent between the two merges.
    const spend = (delta: number) =>
      db
        .prepare(
          `UPDATE search_budget SET rows = rows + ? WHERE day = CAST(unixepoch() / 86400 AS INTEGER)`,
        )
        .bind(delta)
        .run();
    const seen: Recorded = {
      batches: [],
      before: new Map([[1, () => spend(ADMISSION.dailyRows).then(() => {})]]),
    };
    try {
      expect(await runSearchRepairs(recording(seen))).toEqual({ worked: 0, merged: 1 });
      expect(seen.batches).toHaveLength(2);
    } finally {
      await spend(-ADMISSION.dailyRows);
    }
  });

  it("merges nothing while search does not index", async () => {
    expect(await runSearchRepairs(env)).toEqual({ worked: 0, merged: 0 });
  });
});
