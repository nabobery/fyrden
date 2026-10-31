// A recovery's import after its restore: every preserved table made again
// exactly as it was preserved, every column, its restored-only rows removed,
// a bounded step at a time as a maintenance writer at the recovery's
// generation, its place kept in the same transaction; refused for a page
// that does not match what was recorded, or once the barrier moved.

import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_ORG_SHARD, readModelFor } from "../src/events/read-model.js";
import { EXPORT_TABLES } from "../src/read-model/export.js";
import { IMPORT_STEP, importStep } from "../src/read-model/import.js";
import { admitted, pauseReadModel, resumeReadModel } from "../src/read-model/maintenance.js";
import {
  beginRecovery,
  PRESERVED_TABLES,
  PreservationMismatch,
  PreservationRefused,
  type PreservedTable,
  preservedPage,
  preserveStep,
  type Typed,
} from "../src/read-model/preservation.js";

const db = readModelFor(env, DEFAULT_ORG_SHARD);

async function paused(): Promise<void> {
  for (let step = 0; step < 5; step++)
    if ((await pauseReadModel(env, DEFAULT_ORG_SHARD)).phase === "paused") return;
  throw new Error("not paused");
}

const recovery = () =>
  env.DIRECTORY.prepare(
    "SELECT recovery_id, generation, stage FROM read_model_recoveries WHERE shard = ?",
  )
    .bind(DEFAULT_ORG_SHARD)
    .first<{ recovery_id: string; generation: number; stage: string }>();

/** A recovery preserved, and the restore it awaited made (`restore`, written as its maintenance). */
async function restored(restore: (org: D1Database) => D1PreparedStatement[]): Promise<string> {
  await paused();
  const id = uniqueId("rcv");
  await beginRecovery(env, DEFAULT_ORG_SHARD, id);
  for (let step = 0; step < 200; step++)
    if ((await preserveStep(env, DEFAULT_ORG_SHARD, id)).done) break;
  expect((await recovery())?.stage).toBe("awaiting_restore");
  const generation = (await recovery())?.generation ?? 0;
  expect(await admitted(env, DEFAULT_ORG_SHARD, generation, restore)).toBe(true);
  await env.DIRECTORY.prepare(
    "UPDATE read_model_recoveries SET stage = 'importing' WHERE recovery_id = ?",
  )
    .bind(id)
    .run();
  return id;
}

/** Imports through to its end: its steps. */
async function imported(id: string): Promise<number> {
  for (let step = 1; step <= 500; step++)
    if ((await importStep(env, DEFAULT_ORG_SHARD, id)).done) return step;
  throw new Error("still importing");
}

/** Every row of `table` as the database holds it, typed as preserved. */
async function current(table: PreservedTable): Promise<Typed[][]> {
  const info = await db
    .prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid")
    .bind(table)
    .all<{ name: string }>();
  const key = EXPORT_TABLES.find((t) => t.table === table)?.key ?? [];
  const typed = info.results.map(
    ({ name }) =>
      `json_array(typeof(${name}), CASE typeof(${name}) WHEN 'null' THEN NULL
         WHEN 'real' THEN printf('%!.17g', ${name}) ELSE CAST(${name} AS TEXT) END)`,
  );
  const { results } = await db
    .prepare(
      `SELECT json_array(${typed.join(", ")}) AS row FROM ${table} ORDER BY ${key.join(", ")}`,
    )
    .all<{ row: string }>();
  return results.map((r) => JSON.parse(r.row) as Typed[]);
}

/** Every row of `table` as the recovery preserved it. */
async function kept(id: string, table: PreservedTable): Promise<Typed[][]> {
  const { results } = await env.DIRECTORY.prepare(
    "SELECT page FROM read_model_preservation_pages WHERE recovery_id = ? AND table_name = ? ORDER BY page",
  )
    .bind(id, table)
    .all<{ page: number }>();
  const rows: Typed[][] = [];
  for (const { page } of results)
    rows.push(...(await preservedPage(env, id, table, page)).rows.map((r) => [...r]));
  return rows;
}

/** The test's recovery done with, and the writers running again. */
async function finished(): Promise<void> {
  await env.DIRECTORY.prepare("UPDATE read_model_recoveries SET stage = 'complete'").run();
  await env.DIRECTORY.prepare(
    "UPDATE read_model_barriers SET phase = 'paused' WHERE phase = 'recovering'",
  ).run();
  await resumeReadModel(env, DEFAULT_ORG_SHARD);
}

afterEach(finished);

describe("a recovery's import", () => {
  it("makes every preserved table its snapshot again: rows lost, changed in any column, or only restored", async () => {
    const [a, b, c] = [uniqueId("src-a"), uniqueId("src-b"), uniqueId("src-c")];
    await db.batch([
      db
        .prepare("INSERT INTO source_owner (source_id, owner_gen) VALUES (?, 1), (?, 2), (?, 3)")
        .bind(a, b, c),
      db.prepare(
        "INSERT INTO search_budget (day, rows, reads, repo_rows) VALUES (900100, 9007199254740993, 5, 7)",
      ),
      db
        .prepare(
          `INSERT INTO events_failed (id, source_id, kind, envelope, reason, at, expires_at)
           VALUES (?, NULL, 'malformed', '{ "kept" : true }', NULL, 1, 2)`,
        )
        .bind(uniqueId("dlq")),
    ]);
    const id = await restored((org) => [
      // As the restore found the read model: one row gone, one changed in a column, rows the
      // snapshot never had (before, between and after its keys), a counter older.
      org.prepare("DELETE FROM source_owner WHERE source_id = ?").bind(a),
      org.prepare("UPDATE source_owner SET owner_gen = 9 WHERE source_id = ?").bind(b),
      org
        .prepare("INSERT INTO source_owner (source_id, owner_gen) VALUES (?, 1), (?, 1), (?, 1)")
        .bind(`${a}-0`, `${b}-0`, "zzzz-restored"),
      org.prepare("UPDATE search_budget SET rows = 3, repo_rows = 0 WHERE day = 900100"),
      org.prepare(
        "UPDATE events_failed SET envelope = '{\"kept\":true}' WHERE envelope = '{ \"kept\" : true }'",
      ),
    ]);
    await imported(id);
    for (const table of PRESERVED_TABLES)
      expect(await current(table), table).toEqual(await kept(id, table));
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM source_owner WHERE source_id IN (?, ?, ?)")
        .bind(`${a}-0`, `${b}-0`, "zzzz-restored")
        .first(),
    ).toEqual({ n: 0 });
    expect(await db.prepare("SELECT rows FROM search_budget WHERE day = 900100").first()).toEqual({
      rows: 9007199254740993,
    });
    // Once through, it stays through.
    expect(await importStep(env, DEFAULT_ORG_SHARD, id)).toEqual({ done: true });
  });

  it("removes no more rows a step than it may, however many only the restore had", async () => {
    const prefix = uniqueId("only");
    const id = await restored((org) => [
      org.prepare(
        `INSERT INTO source_owner (source_id, owner_gen)
         WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v + 1 FROM n WHERE v < 1200)
         SELECT '${prefix}-' || printf('%05d', v), 1 FROM n`,
      ),
    ]);
    let most = 0;
    let before =
      (await db.prepare("SELECT count(*) AS n FROM source_owner").first<{ n: number }>())?.n ?? 0;
    for (let step = 0; step < 500; step++) {
      const { done } = await importStep(env, DEFAULT_ORG_SHARD, id);
      const now =
        (await db.prepare("SELECT count(*) AS n FROM source_owner").first<{ n: number }>())?.n ?? 0;
      most = Math.max(most, before - now);
      before = now;
      if (done) break;
    }
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(IMPORT_STEP.removed);
    expect(await current("source_owner")).toEqual(await kept(id, "source_owner"));
  });

  it("compares a page's rows without reading back what the restore holds of them, however large", async () => {
    const keys = Array.from({ length: 64 }, () => uniqueId("dlq"));
    for (const key of keys)
      await db
        .prepare(
          `INSERT INTO events_failed (id, source_id, kind, envelope, reason, at, expires_at)
           VALUES (?, NULL, 'malformed', NULL, 'pruned', 1, 2)`,
        )
        .bind(key)
        .run();
    // The restore brings back their bodies (pruned since): far larger than the rows preserved.
    const body = "b".repeat(1_000_000);
    const id = await restored((org) =>
      keys.map((key) =>
        org.prepare("UPDATE events_failed SET envelope = ? WHERE id = ?").bind(body, key),
      ),
    );
    let most = 0;
    const org = new Proxy(env.ORG_READ, {
      get(target, prop) {
        if (prop === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements);
            most = Math.max(most, JSON.stringify(results.map((r) => r.results)).length);
            return results;
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const watched = new Proxy(env, {
      get: (target, prop) => (prop === "ORG_READ" ? org : Reflect.get(target, prop)),
    });
    for (let step = 0; step < 500; step++)
      if ((await importStep(watched, DEFAULT_ORG_SHARD, id)).done) break;
    expect(await current("events_failed")).toEqual(await kept(id, "events_failed"));
    expect(most).toBeLessThan(body.length);
  });

  it("writes more differing rows than a step may over several, a composite key across pages, and removes restored rows before and after every key", async () => {
    const delivery = uniqueId("dlv");
    await db
      .prepare(
        `INSERT INTO webhook_attempts (delivery_id, n, at, status)
         WITH RECURSIVE k(v) AS (SELECT 1 UNION ALL SELECT v + 1 FROM k WHERE v < 450)
         SELECT ?, v, v, 200 FROM k`,
      )
      .bind(delivery)
      .run();
    const id = await restored((org) => [
      // Thirty changed in one page, five lost, rows the snapshot never had before and after.
      org
        .prepare("UPDATE webhook_attempts SET status = 500 WHERE delivery_id = ? AND n <= 30")
        .bind(delivery),
      org
        .prepare("DELETE FROM webhook_attempts WHERE delivery_id = ? AND n BETWEEN 300 AND 304")
        .bind(delivery),
      org.prepare(
        `INSERT INTO webhook_attempts (delivery_id, n, at) VALUES ('', 1, 1), ('', 2, 1),
           ('~~~~', 1, 1), ('~~~~', 2, 1)`,
      ),
      org
        .prepare("INSERT INTO webhook_attempts (delivery_id, n, at) VALUES (?, 0, 1), (?, 9999, 1)")
        .bind(delivery, delivery),
    ]);
    await imported(id);
    expect(await current("webhook_attempts")).toEqual(await kept(id, "webhook_attempts"));
  });

  it("keeps a text key holding a NUL as it was", async () => {
    const key = `${uniqueId("src")}\u0000tail`;
    await db
      .prepare("INSERT INTO source_owner (source_id, owner_gen) VALUES (?, 5)")
      .bind(key)
      .run();
    const id = await restored((org) => [
      org.prepare("DELETE FROM source_owner WHERE source_id = ?").bind(key),
    ]);
    await imported(id);
    expect(await current("source_owner")).toEqual(await kept(id, "source_owner"));
    expect(
      await db.prepare("SELECT owner_gen FROM source_owner WHERE source_id = ?").bind(key).first(),
    ).toEqual({ owner_gen: 5 });
  });

  it("converges again from an earlier place, writing nothing twice that differs", async () => {
    const owner = uniqueId("src");
    await db
      .prepare("INSERT INTO source_owner (source_id, owner_gen) VALUES (?, 4)")
      .bind(owner)
      .run();
    const id = await restored((org) => [
      org.prepare("DELETE FROM source_owner WHERE source_id = ?").bind(owner),
    ]);
    await imported(id);
    // As if a step's answer were lost before the place it wrote was seen: back to the start.
    const generation = (await recovery())?.generation ?? 0;
    await admitted(env, DEFAULT_ORG_SHARD, generation, (org) =>
      org.prepare("UPDATE read_model_recovery_progress SET table_index = 0, page = 0 WHERE id = 1"),
    );
    await imported(id);
    for (const table of PRESERVED_TABLES)
      expect(await current(table), table).toEqual(await kept(id, table));
  });

  it("refuses a page that does not match what was recorded, before writing anything of it", async () => {
    const owner = uniqueId("src");
    await db
      .prepare("INSERT INTO source_owner (source_id, owner_gen) VALUES (?, 4)")
      .bind(owner)
      .run();
    const id = await restored((org) => [
      org.prepare("DELETE FROM source_owner WHERE source_id = ?").bind(owner),
    ]);
    const { results } = await env.DIRECTORY.prepare(
      "SELECT object_key FROM read_model_preservation_pages WHERE recovery_id = ? AND table_name = 'source_owner'",
    )
      .bind(id)
      .all<{ object_key: string }>();
    for (const { object_key: key } of results) {
      const text = (await (await env.ASSETS.get(key))?.text()) ?? "";
      await env.ASSETS.put(key, text.replace('"4"', '"5"'));
    }
    await expect(imported(id)).rejects.toBeInstanceOf(PreservationMismatch);
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM source_owner WHERE source_id = ?")
        .bind(owner)
        .first(),
    ).toEqual({ n: 0 });
  });

  it("is refused unless importing, and once the read model's barrier left the recovery's generation", async () => {
    await paused();
    const id = uniqueId("rcv");
    await beginRecovery(env, DEFAULT_ORG_SHARD, id);
    await expect(importStep(env, DEFAULT_ORG_SHARD, id)).rejects.toBeInstanceOf(
      PreservationRefused,
    );
    for (let step = 0; step < 200; step++)
      if ((await preserveStep(env, DEFAULT_ORG_SHARD, id)).done) break;
    await env.DIRECTORY.prepare(
      "UPDATE read_model_recoveries SET stage = 'importing' WHERE recovery_id = ?",
    )
      .bind(id)
      .run();
    // The directory's barrier at another generation: no maintenance writer of the recovery's.
    await env.DIRECTORY.prepare(
      "UPDATE read_model_barriers SET generation = generation + 1 WHERE phase = 'recovering'",
    ).run();
    await expect(importStep(env, DEFAULT_ORG_SHARD, id)).rejects.toThrow();
    await env.DIRECTORY.prepare(
      "UPDATE read_model_barriers SET generation = generation - 1 WHERE phase = 'recovering'",
    ).run();
  });
});
