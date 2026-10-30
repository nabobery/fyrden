// A coherent export of the read model, under the paused barrier: every row of
// every table exactly once, in key order, a page of at most 200 rows and
// 2 MiB of JSON at a time (large rows split pages), resumable from any page's
// cursor, refused once the barrier leaves the export's generation; its
// manifest; and the gate that keeps it unavailable until writes outside the
// executor are refused.

import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EXPORT_PAGE,
  EXPORT_TABLES,
  type ExportCursor,
  ExportFenceLost,
  exportAvailability,
  exportManifest,
  exportPage,
  PROTOCOL_TABLES,
} from "../src/read-model/export.js";
import { pauseReadModel, resumeReadModel } from "../src/read-model/maintenance.js";

const db = env.ORG_READ;

/** The whole export from `from`: its pages. */
async function exportAll(
  generation: number,
  from: ExportCursor = { table: 0, after: null },
  through: D1Database = db,
) {
  const pages = [];
  let cursor: ExportCursor | null = from;
  while (cursor) {
    const page = await exportPage(through, generation, cursor);
    pages.push({ ...page, cursor });
    cursor = page.next;
  }
  return pages;
}

const everyRow = async (table: string, key: readonly string[]) =>
  (await db.prepare(`SELECT * FROM ${table} ORDER BY ${key.join(", ")}`).all()).results;

afterEach(async () => {
  await resumeReadModel(env, "default");
});

describe("an export of the read model", () => {
  beforeEach(async () => {
    // Rows to export: large ones (pages split by bytes), one whose JSON is more than a page (its
    // text escaped again: twice its stored size), composite keys, more than a page of rows.
    const repo = uniqueId("rep");
    const failed = (id: string, envelope: string) =>
      db
        .prepare(
          `INSERT INTO events_failed (id, kind, envelope, reason, at, expires_at)
           VALUES (?, 'malformed', ?, 'test', 0, 1)`,
        )
        .bind(id, envelope);
    const statements = [
      ...Array.from({ length: 12 }, (_, i) =>
        failed(`${repo}-${String(i).padStart(2, "0")}`, "x".repeat(400_000)),
      ),
      failed(`${repo}-zz`, '"'.repeat(1_200_000)),
      ...Array.from({ length: 250 }, (_, i) =>
        db
          .prepare(
            "INSERT INTO source_owner (source_id, owner_gen) VALUES (?, 1) ON CONFLICT DO NOTHING",
          )
          .bind(`${repo}-${i}`),
      ),
    ];
    await db.batch(statements);
    await db.batch(
      [3, 1, 2].map((label) =>
        db
          .prepare(
            `INSERT INTO search_labels (repo_id, label_id, name, color, epoch_gen, owner_gen, version,
               updated_seq)
             VALUES (?, ?, 'l', '000000', 1, 1, 1, 1)`,
          )
          .bind(repo, label),
      ),
    );
  });

  it("covers every table of the read model's data by its primary key", async () => {
    const { results } = await db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name",
      )
      .all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(
      [...EXPORT_TABLES.map((t) => t.table), ...PROTOCOL_TABLES].sort(),
    );
    for (const { table, key } of EXPORT_TABLES) {
      const pk = await db
        .prepare("SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk")
        .bind(table)
        .all<{ name: string }>();
      expect(
        pk.results.map((r) => r.name),
        table,
      ).toEqual(key);
    }
  });

  it("returns every row once, in key order, within its page bounds, and resumes from a cursor", async () => {
    const { phase, generation } = await pauseReadModel(env, "default");
    expect(phase).toBe("paused");
    // What each read loaded (its stored text): never much more than a page.
    const loads: number[] = [];
    const measured = new Proxy(db, {
      get(target, prop) {
        if (prop === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements);
            loads.push(
              results
                .flatMap((r) => r.results as Record<string, unknown>[])
                .flatMap((row) => Object.values(row))
                .reduce<number>((n, v) => n + (typeof v === "string" ? v.length : 8), 0),
            );
            return results;
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const pages = await exportAll(generation, { table: 0, after: null }, measured);
    const encoded = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
    for (const page of pages) {
      expect(page.rows.length).toBeLessThanOrEqual(EXPORT_PAGE.rows);
      // The page as it would be sent, framing and cursor included; only a row larger than a page
      // is a page of its own beyond it.
      const { table, rows, next } = page;
      if (rows.length > 1)
        expect(encoded({ table, rows, next })).toBeLessThanOrEqual(EXPORT_PAGE.bytes);
    }
    const largest = 1_200_000;
    expect(Math.max(...loads)).toBeLessThanOrEqual(EXPORT_PAGE.bytes + largest);
    // The row whose JSON is more than a page: alone, whole.
    const alone = pages.find((p) => p.rows.some((row) => String(row.id).endsWith("-zz")));
    expect(alone?.rows).toHaveLength(1);
    expect(encoded(alone?.rows[0])).toBeGreaterThan(EXPORT_PAGE.bytes);
    for (const { table, key } of EXPORT_TABLES) {
      const exported = pages.filter((p) => p.table === table).flatMap((p) => p.rows);
      expect(exported, table).toEqual(await everyRow(table, key));
    }
    // Large rows split their table across pages; a table of more than a page's rows too.
    expect(pages.filter((p) => p.table === "events_failed").length).toBeGreaterThan(1);
    expect(pages.filter((p) => p.table === "source_owner").length).toBeGreaterThan(1);
    // From a page's cursor, the rest as it was.
    const middle = pages.findIndex((p) => p.table === "source_owner" && p.cursor.after !== null);
    const resumed = await exportAll(generation, pages[middle]?.cursor as ExportCursor);
    expect(resumed.map((p) => p.rows)).toEqual(pages.slice(middle).map((p) => p.rows));
  });

  it("is refused once the barrier leaves the export's generation", async () => {
    const { generation } = await pauseReadModel(env, "default");
    await expect(exportPage(db, generation + 1, { table: 0, after: null })).rejects.toBeInstanceOf(
      ExportFenceLost,
    );
    await resumeReadModel(env, "default");
    await expect(exportPage(db, generation, { table: 0, after: null })).rejects.toBeInstanceOf(
      ExportFenceLost,
    );
    await expect(exportManifest(db, generation)).rejects.toBeInstanceOf(ExportFenceLost);
  });

  it("has a manifest of its schema, generation, columns and the protocol's state", async () => {
    const { generation } = await pauseReadModel(env, "default");
    const manifest = await exportManifest(db, generation);
    expect(manifest.generation).toBe(generation);
    expect(manifest.migrations).toContain("0017_read_model_executor.sql");
    expect(manifest.tables.find((t) => t.table === "search_labels")?.columns).toEqual(
      expect.arrayContaining(["repo_id", "label_id", "name"]),
    );
    expect(manifest.protocol.read_model_barrier).toMatchObject([{ phase: "paused", generation }]);
    expect(manifest.protocol.read_model_write).toMatchObject([{ open: 0 }]);
  });
});

describe("the export's availability", () => {
  it("is refused until writes outside the executor are refused (the restore floor set)", () => {
    expect(exportAvailability(null)).toEqual({ available: false, reason: "protocol_not_enforced" });
    expect(exportAvailability("2026-10-30T00:00:00Z")).toEqual({ available: true, reason: null });
  });
});
