// What a recovery preserves of the read model before a restore: every row
// and column of its operational tables, a page at a time under the paused
// barrier's fence, each value typed (integers past JavaScript's exact range
// kept exact), each page digested into the assets bucket and catalogued in
// the directory, and the catalog sealed into a manifest. A page read back is
// checked against its record and the manifest; a step repeated finds its
// page recorded; a step after the barrier moved preserves nothing.

import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_ORG_SHARD, readModelFor } from "../src/events/read-model.js";
import { EXPORT_TABLES } from "../src/read-model/export.js";
import {
  admitted,
  barrierHooks,
  pauseReadModel,
  resumeReadModel,
} from "../src/read-model/maintenance.js";
import {
  beginRecovery,
  PRESERVATION_PAGE,
  PRESERVATION_PAGES,
  PRESERVED_TABLES,
  PreservationMismatch,
  PreservationRefused,
  type PreservedTable,
  preservedPage,
  preserveStep,
  type Typed,
} from "../src/read-model/preservation.js";

const db = readModelFor(env, DEFAULT_ORG_SHARD);

async function paused(): Promise<number> {
  for (let step = 0; step < 5; step++) {
    const progress = await pauseReadModel(env, DEFAULT_ORG_SHARD);
    if (progress.phase === "paused") return progress.generation;
  }
  throw new Error("not paused");
}

/** Preserves through to the recovery's restore: its steps. */
async function preserved(recoveryId: string): Promise<number> {
  for (let step = 1; step <= 100; step++)
    if ((await preserveStep(env, DEFAULT_ORG_SHARD, recoveryId)).done) return step;
  throw new Error("still preserving");
}

const recovery = () =>
  env.DIRECTORY.prepare(
    "SELECT recovery_id, generation, stage, cursor, manifest FROM read_model_recoveries WHERE shard = ?",
  )
    .bind(DEFAULT_ORG_SHARD)
    .first<{
      recovery_id: string;
      generation: number;
      stage: string;
      cursor: string | null;
      manifest: string | null;
    }>();

const pages = (recoveryId: string, table: string) =>
  env.DIRECTORY.prepare(
    `SELECT page, rows, object_key FROM read_model_preservation_pages
     WHERE recovery_id = ? AND table_name = ? ORDER BY page`,
  )
    .bind(recoveryId, table)
    .all<{ page: number; rows: number; object_key: string }>()
    .then((r) => r.results);

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

/** Every row of `table` as the recovery preserved it, its pages read back and checked. */
async function kept(recoveryId: string, table: PreservedTable): Promise<Typed[][]> {
  const rows: Typed[][] = [];
  for (const { page } of await pages(recoveryId, table))
    rows.push(...(await preservedPage(env, recoveryId, table, page)).rows.map((r) => [...r]));
  return rows;
}

/** The read model's own barrier moved off its pause (as a resume, or a restore, would). */
async function moved(): Promise<void> {
  const generation = (await recovery())?.generation ?? 0;
  expect(
    await admitted(env, DEFAULT_ORG_SHARD, generation, (org) =>
      org.prepare("UPDATE read_model_barrier SET phase = 'running' WHERE id = 1"),
    ),
  ).toBe(true);
}

/** Preserves every page, stopping before the seal. */
async function allPages(recoveryId: string): Promise<void> {
  for (let step = 0; step < 100; step++) {
    const cursor = JSON.parse((await recovery())?.cursor ?? "{}") as { table?: number };
    if (cursor.table === PRESERVED_TABLES.length) return;
    await preserveStep(env, DEFAULT_ORG_SHARD, recoveryId);
  }
  throw new Error("still preserving pages");
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

describe("a recovery's preservation", () => {
  it("names the read model's operational tables, each exported with its key", async () => {
    for (const table of PRESERVED_TABLES) {
      expect(
        EXPORT_TABLES.some((t) => t.table === table),
        table,
      ).toBe(true);
      const info = await db
        .prepare("SELECT count(*) AS n FROM pragma_table_info(?)")
        .bind(table)
        .first<{ n: number }>();
      expect(info?.n, table).toBeGreaterThan(0);
    }
  });

  it("keeps every row and column of every operational table exactly, values typed", async () => {
    const source = uniqueId("rep");
    await db.batch([
      db
        .prepare("INSERT INTO consumer_epochs (source_id, epoch_gen, updated_at) VALUES (?, 3, 7)")
        .bind(`${source}-ünïcode`),
      db.prepare("INSERT INTO source_owner (source_id, owner_gen) VALUES (?, 2)").bind(source),
      // Past JavaScript's exact integers.
      db.prepare(
        "INSERT INTO search_budget (day, rows, reads) VALUES (900001, 9007199254740993, 5)",
      ),
      db
        .prepare(
          `INSERT INTO events_failed (id, source_id, kind, epoch_gen, first_seq, last_seq, types,
             envelope, reason, at, expires_at)
           VALUES (?, NULL, 'malformed', NULL, NULL, NULL, NULL, ?, NULL, 1, 2)`,
        )
        .bind(uniqueId("dlq"), '{ "spaced" :  [1, 2.50] }'),
    ]);
    const generation = await paused();
    const id = uniqueId("rcv");
    // At the next generation: a step of the paused one admits nothing more.
    expect(await beginRecovery(env, DEFAULT_ORG_SHARD, id)).toEqual({
      generation: generation + 1,
      stage: "preserving",
    });
    await preserved(id);
    const sealed = await recovery();
    expect(sealed).toMatchObject({ recovery_id: id, stage: "awaiting_restore", cursor: null });
    expect(JSON.parse(sealed?.manifest ?? "{}")).toMatchObject({
      recovery: id,
      generation: generation + 1,
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    for (const table of PRESERVED_TABLES)
      expect(await kept(id, table), table).toEqual(await current(table));
    const budget = (await kept(id, "search_budget")).find((row) => row[0]?.[1] === "900001");
    expect(budget?.[1]).toEqual(["integer", "9007199254740993"]);
  });

  it("keeps pages within their rows and bytes, a row larger than a page's bytes alone", async () => {
    const prefix = uniqueId("src");
    const values = Array.from(
      { length: 450 },
      (_, i) => `('${prefix}-${String(i).padStart(3, "0")}', 1, 1)`,
    );
    await db
      .prepare(
        `INSERT INTO consumer_epochs (source_id, epoch_gen, updated_at) VALUES ${values.join(", ")}`,
      )
      .run();
    const large = "x".repeat(PRESERVATION_PAGE.bytes + 1_000);
    await db
      .prepare(
        `INSERT INTO events_failed (id, source_id, kind, envelope, at, expires_at)
         VALUES (?, NULL, 'malformed', ?, 1, 2)`,
      )
      .bind(uniqueId("dlq"), large)
      .run();
    await paused();
    const id = uniqueId("rcv");
    await beginRecovery(env, DEFAULT_ORG_SHARD, id);
    await preserved(id);
    const epochs = await pages(id, "consumer_epochs");
    expect(epochs.every((p) => p.rows <= PRESERVATION_PAGE.rows)).toBe(true);
    expect(epochs.reduce((n, p) => n + p.rows, 0)).toBe((await current("consumer_epochs")).length);
    expect(epochs.length).toBeGreaterThanOrEqual(3);
    const failed = await kept(id, "events_failed");
    expect(failed.some((row) => row.some((v) => v[1] === large))).toBe(true);
    for (const { page } of await pages(id, "events_failed")) {
      const read = await preservedPage(env, id, "events_failed", page);
      if (read.rows.some((row) => row.some((v) => v[1] === large)))
        expect(read.rows).toHaveLength(1);
    }
  });

  it("holds the writers back: the directory's barrier recovering, so nothing resumes them", async () => {
    const generation = await paused();
    await beginRecovery(env, DEFAULT_ORG_SHARD, uniqueId("rcv"));
    expect(await resumeReadModel(env, DEFAULT_ORG_SHARD)).toEqual({
      phase: "recovering",
      generation: generation + 1,
    });
  });

  it("admits nothing more of a resume that was under way when it started", async () => {
    await paused();
    const id = uniqueId("rcv");
    // The resume looked at the barriers (paused) before the recovery started; then it goes on.
    barrierHooks.beforeChange = async (step) => {
      if (step !== "resume") return;
      delete barrierHooks.beforeChange;
      await beginRecovery(env, DEFAULT_ORG_SHARD, id);
    };
    try {
      await resumeReadModel(env, DEFAULT_ORG_SHARD);
    } finally {
      delete barrierHooks.beforeChange;
    }
    const generation = (await recovery())?.generation ?? 0;
    expect(
      await env.DIRECTORY.prepare(
        "SELECT phase, generation FROM read_model_barriers WHERE shard = ?",
      )
        .bind(DEFAULT_ORG_SHARD)
        .first(),
    ).toEqual({ phase: "recovering", generation });
    expect(
      await db.prepare("SELECT phase, generation FROM read_model_barrier WHERE id = 1").first(),
    ).toEqual({ phase: "paused", generation });
    await preserved(id);
    expect((await recovery())?.stage).toBe("awaiting_restore");
  });

  it("preserves nothing more once the read model's barrier leaves its pause", async () => {
    await paused();
    const id = uniqueId("rcv");
    await beginRecovery(env, DEFAULT_ORG_SHARD, id);
    await moved();
    await expect(preserveStep(env, DEFAULT_ORG_SHARD, id)).rejects.toBeInstanceOf(
      PreservationRefused,
    );
    expect(await pages(id, PRESERVED_TABLES[0])).toEqual([]);
  });

  it("seals nothing once the read model's barrier leaves its pause after the last page", async () => {
    await paused();
    const id = uniqueId("rcv");
    await beginRecovery(env, DEFAULT_ORG_SHARD, id);
    await allPages(id);
    await moved();
    await expect(preserveStep(env, DEFAULT_ORG_SHARD, id)).rejects.toBeInstanceOf(
      PreservationRefused,
    );
    expect(await recovery()).toMatchObject({ stage: "preserving", manifest: null });
  });

  it("keeps a row whose text, escaped, passes what one string may hold, alone", async () => {
    // Quotes: twice as long once escaped, past D1's 2,000,000 bytes a string.
    const quoted = '"'.repeat(1_050_000);
    const key = uniqueId("dlq");
    await db
      .prepare(
        `INSERT INTO events_failed (id, source_id, kind, envelope, at, expires_at)
         VALUES (?, NULL, 'malformed', ?, 1, 2)`,
      )
      .bind(key, quoted)
      .run();
    await paused();
    const id = uniqueId("rcv");
    await beginRecovery(env, DEFAULT_ORG_SHARD, id);
    await preserved(id);
    const found = (await kept(id, "events_failed")).filter((row) => row[0]?.[1] === key);
    expect(found).toHaveLength(1);
    expect(found[0]?.some((v) => v[0] === "text" && v[1] === quoted)).toBe(true);
    // Gone again (the file's other tests read every row with SQL's own JSON).
    await finished();
    await db.prepare("DELETE FROM events_failed WHERE id = ?").bind(key).run();
  });

  it("loads no more than about a page of rows at once, however many large ones follow", async () => {
    const body = "y".repeat(20_000);
    const prefix = uniqueId("dlq");
    for (let i = 0; i < 210; i += 30)
      await db.batch(
        Array.from({ length: 30 }, (_, j) =>
          db
            .prepare(
              `INSERT INTO events_failed (id, source_id, kind, envelope, at, expires_at)
               VALUES (?, NULL, 'malformed', ?, 1, 2)`,
            )
            .bind(`${prefix}-${String(i + j).padStart(3, "0")}`, body),
        ),
      );
    await paused();
    const id = uniqueId("rcv");
    await beginRecovery(env, DEFAULT_ORG_SHARD, id);
    // The bytes each of its reads returned.
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
    for (let step = 0; step < 100; step++)
      if ((await preserveStep(watched, DEFAULT_ORG_SHARD, id)).done) break;
    expect((await recovery())?.stage).toBe("awaiting_restore");
    // 210 rows of 20 KB: far more than a page, never loaded at once.
    expect(most).toBeLessThan(2 * PRESERVATION_PAGE.bytes);
    await finished();
    await db.prepare("DELETE FROM events_failed WHERE id LIKE ?").bind(`${prefix}-%`).run();
  });

  it("refuses to preserve more pages than a recovery holds", async () => {
    await paused();
    const id = uniqueId("rcv");
    await beginRecovery(env, DEFAULT_ORG_SHARD, id);
    await env.DIRECTORY.prepare("UPDATE read_model_recoveries SET cursor = ? WHERE recovery_id = ?")
      .bind(JSON.stringify({ table: 0, page: 0, after: null, pages: PRESERVATION_PAGES }), id)
      .run();
    await expect(preserveStep(env, DEFAULT_ORG_SHARD, id)).rejects.toThrow(/fresh database/);
  });

  it("finds a page recorded when a step is made again (its answer lost)", async () => {
    await paused();
    const id = uniqueId("rcv");
    await beginRecovery(env, DEFAULT_ORG_SHARD, id);
    await preserveStep(env, DEFAULT_ORG_SHARD, id);
    const once = await pages(id, PRESERVED_TABLES[0]);
    expect(once).toHaveLength(1);
    // Its place as before it: the same page again.
    await env.DIRECTORY.prepare(
      "UPDATE read_model_recoveries SET cursor = NULL WHERE recovery_id = ?",
    )
      .bind(id)
      .run();
    await preserveStep(env, DEFAULT_ORG_SHARD, id);
    expect(await pages(id, PRESERVED_TABLES[0])).toEqual(once);
    await preserved(id);
    expect((await recovery())?.stage).toBe("awaiting_restore");
  });

  it("moves on past no page recorded with another digest", async () => {
    await paused();
    const id = uniqueId("rcv");
    await beginRecovery(env, DEFAULT_ORG_SHARD, id);
    await env.DIRECTORY.prepare(
      `INSERT INTO read_model_preservation_pages
         (recovery_id, table_name, page, object_key, digest, rows, bytes)
       VALUES (?, ?, 0, 'elsewhere', 'another', 0, 0)`,
    )
      .bind(id, PRESERVED_TABLES[0])
      .run();
    await expect(preserveStep(env, DEFAULT_ORG_SHARD, id)).rejects.toBeInstanceOf(
      PreservationMismatch,
    );
    expect((await recovery())?.cursor).toBeNull();
  });

  it("refuses a page whose object or manifest no longer matches what was recorded", async () => {
    await db
      .prepare("INSERT INTO source_owner (source_id, owner_gen) VALUES (?, 1)")
      .bind(uniqueId("rep"))
      .run();
    await paused();
    const id = uniqueId("rcv");
    await beginRecovery(env, DEFAULT_ORG_SHARD, id);
    await preserved(id);
    const [first] = await pages(id, "source_owner");
    expect(first).toBeDefined();
    const key = first?.object_key ?? "";
    const original = (await (await env.ASSETS.get(key))?.text()) ?? "";
    await env.ASSETS.put(key, original.replace('"owner_gen"', '"owner_gen" '));
    await expect(preservedPage(env, id, "source_owner", 0)).rejects.toBeInstanceOf(
      PreservationMismatch,
    );
    await env.ASSETS.put(key, original);
    expect((await preservedPage(env, id, "source_owner", 0)).table).toBe("source_owner");
    await env.DIRECTORY.prepare(
      "UPDATE read_model_recoveries SET manifest = json_set(manifest, '$.generation', 0) WHERE recovery_id = ?",
    )
      .bind(id)
      .run();
    await expect(preservedPage(env, id, "source_owner", 0)).rejects.toBeInstanceOf(
      PreservationMismatch,
    );
  });

  it("is not started again with an id used before, nor with one too long for its pages' keys", async () => {
    await paused();
    const id = uniqueId("rcv");
    await beginRecovery(env, DEFAULT_ORG_SHARD, id);
    await preserved(id);
    await env.DIRECTORY.prepare("UPDATE read_model_recoveries SET stage = 'complete'").run();
    await env.DIRECTORY.prepare(
      "UPDATE read_model_barriers SET phase = 'paused' WHERE phase = 'recovering'",
    ).run();
    await expect(beginRecovery(env, DEFAULT_ORG_SHARD, id)).rejects.toBeInstanceOf(
      PreservationRefused,
    );
    await expect(beginRecovery(env, DEFAULT_ORG_SHARD, "r".repeat(65))).rejects.toBeInstanceOf(
      PreservationRefused,
    );
    await expect(beginRecovery(env, DEFAULT_ORG_SHARD, "../x")).rejects.toBeInstanceOf(
      PreservationRefused,
    );
    expect(await recovery()).toMatchObject({ recovery_id: id, stage: "complete" });
  });

  it("is not started while the read model is not paused, nor while another recovery is under way", async () => {
    await expect(beginRecovery(env, DEFAULT_ORG_SHARD, uniqueId("rcv"))).rejects.toBeInstanceOf(
      PreservationRefused,
    );
    await paused();
    const first = uniqueId("rcv");
    await beginRecovery(env, DEFAULT_ORG_SHARD, first);
    // The one under way again: itself.
    expect((await beginRecovery(env, DEFAULT_ORG_SHARD, first)).stage).toBe("preserving");
    await expect(beginRecovery(env, DEFAULT_ORG_SHARD, uniqueId("rcv"))).rejects.toBeInstanceOf(
      PreservationRefused,
    );
  });
});
