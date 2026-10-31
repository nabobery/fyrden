// The read model's and search's state, as instance administrators read it
// (`GET /admin/search/status`): what operators look at before a pause or
// an export, and search's allowance, indexes, coverage and repairs, each
// read through an index whatever the database holds.

import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import { DEFAULT_ORG_SHARD, readModelFor } from "../src/events/read-model.js";
import { REPO_INDEX } from "../src/queues/events-consumer.js";
import { READ_MODEL_PROTOCOL, ReadModelWriter } from "../src/read-model/executor.js";
import { ADMISSION } from "../src/search/admission.js";
import { repairStatement } from "../src/search/repairs.js";
import { STATUS_QUERIES } from "../src/search/status.js";
import { api, json, user } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";

const status = (token: string) =>
  json<Record<string, Record<string, unknown>>>(api("GET", "/admin/search/status", token));

describe("the read model's status", () => {
  it("says it refuses writes outside the executor, consistent, with no export yet, and counts the live leases", async () => {
    const admin = await user(true);
    const writer = new ReadModelWriter(env, "default");
    await writer.acquire();
    try {
      const { status: code, body } = await status(admin.token);
      expect(code).toBe(200);
      expect(body.protocol).toEqual({
        serving_version: READ_MODEL_PROTOCOL,
        deployed_version: 0,
        required_version: 2,
        mode: "enforced",
        restore_floor: null,
        restore_token: "uninitialized",
      });
      expect(body.barrier).toMatchObject({
        directory_phase: "running",
        org_phase: "running",
        consistent: true,
      });
      expect(body.barrier?.org_generation).toBe(body.barrier?.directory_generation);
      expect(body.admission).toMatchObject({ open: false });
      expect(body.writers).toMatchObject({ live: 1, earliest_deadline: writer.lease?.until });
      expect(body.export).toEqual({ available: false, reason: "no_restore_floor" });
      expect(body.search).toMatchObject({ day: expect.any(Number), rows: expect.any(Number) });
    } finally {
      await writer.release();
    }
  });

  it("is read only by instance administrators", async () => {
    const someone = await user();
    expect((await status(someone.token)).status).toBe(403);
    const admin = await user(true);
    // A token narrowed to other permissions does not reach it either.
    const narrowed = await scopedToken(admin.principalId, ["members:read"]);
    expect((await status(narrowed)).status).toBe(403);
  });
});

describe("search's status", () => {
  const db = readModelFor(env, DEFAULT_ORG_SHARD);
  const TODAY = "CAST(unixepoch() / 86400 AS INTEGER)";

  /** Search's singletons set to `values` (restored after `work`). */
  async function holding<T>(
    values: { liveDocs: number; indexedRepos: number; reserved: number; repoRows: number },
    work: () => Promise<T>,
  ): Promise<T> {
    const state = await db
      .prepare("SELECT live_docs, indexed_repos FROM search_index_state WHERE id = 1")
      .first<{ live_docs: number; indexed_repos: number }>();
    const size = await db
      .prepare("SELECT bytes_reserved FROM search_size WHERE id = 1")
      .first<{ bytes_reserved: number }>();
    const set = (live: number, repos: number, reserved: number) =>
      db.batch([
        db
          .prepare("UPDATE search_index_state SET live_docs = ?, indexed_repos = ? WHERE id = 1")
          .bind(live, repos),
        db.prepare("UPDATE search_size SET bytes_reserved = ? WHERE id = 1").bind(reserved),
      ]);
    await set(values.liveDocs, values.indexedRepos, values.reserved);
    await db
      .prepare(
        `INSERT INTO search_budget (day, repo_rows) VALUES (${TODAY}, ?1)
         ON CONFLICT (day) DO UPDATE SET repo_rows = ?1`,
      )
      .bind(values.repoRows)
      .run();
    try {
      return await work();
    } finally {
      await set(state?.live_docs ?? 0, state?.indexed_repos ?? 0, size?.bytes_reserved ?? 0);
    }
  }

  /** Every source known whole but `uncovered` (each made a source when it is none). */
  async function sources(covered: string[], uncovered: string[]): Promise<void> {
    await db.prepare("UPDATE search_sources SET index_covered = 1").run();
    for (const [ids, flag] of [
      [covered, 1],
      [uncovered, 0],
    ] as const)
      for (const id of ids)
        await db
          .prepare(
            `INSERT INTO search_sources (repo_id, cutoff_epoch, cutoff_seq, index_covered)
             VALUES (?1, 0, 0, ?2) ON CONFLICT (repo_id) DO UPDATE SET index_covered = ?2`,
          )
          .bind(id, flag)
          .run();
  }

  async function parkedAt(repoId: string, retryAt: number): Promise<void> {
    await db
      .prepare(
        "UPDATE search_repairs SET blocked_reason = 'growth', retry_at = ? WHERE repo_id = ?",
      )
      .bind(retryAt, repoId)
      .run();
  }

  it("shows the allowance with its limits, the indexes' counts and room, and what waits", async () => {
    const admin = await user(true);
    await db.prepare("DELETE FROM search_repairs").run();
    const [due, parked, later] = [uniqueId("rep"), uniqueId("rep"), uniqueId("rep")];
    await repairStatement(db, due, "backfill", 5).run();
    await repairStatement(db, parked, "backfill", 1).run();
    await repairStatement(db, later, "backfill", 2).run();
    await parkedAt(parked, 1234);
    await parkedAt(later, 5678);
    // Sorted first among the sources not known whole ("a" before every generated id).
    const [whole, notWhole] = [`a-${uniqueId("rep")}`, `a-${uniqueId("rep")}`].sort().reverse();
    await sources([whole ?? ""], [notWhole ?? ""]);
    const { status: code, body } = await holding(
      { liveDocs: 41, indexedRepos: 7, reserved: 4_096, repoRows: 99 },
      () => status(admin.token),
    );
    expect(code).toBe(200);
    expect(body.search).toMatchObject({
      repo_rows: 99,
      bytes_reserved: 4_096,
      live_docs: 41,
      indexed_repos: 7,
      limits: {
        daily_rows: ADMISSION.dailyRows,
        daily_reads: ADMISSION.dailyReads,
        max_bytes: ADMISSION.maxBytes,
        repository_daily_rows: ADMISSION.repoDailyRows,
        repository_capacity: REPO_INDEX.capacity,
      },
      // The parked ones asked for earlier, but not due: the next due is the other; of the parked,
      // the one whose wait ends first.
      repair_pending: true,
      next_repair_since: 5,
      next_parked: { repo_id: parked, reason: "growth", retry_at: 1234 },
      first_uncovered: notWhole,
    });
  });

  it("says nothing is due while only a parked one waits, and none uncovered when all are whole", async () => {
    const admin = await user(true);
    await db.prepare("DELETE FROM search_repairs").run();
    const parked = uniqueId("rep");
    await repairStatement(db, parked, "backfill", 1).run();
    await parkedAt(parked, 99);
    await sources([uniqueId("rep")], []);
    const { body } = await status(admin.token);
    expect(body.search).toMatchObject({
      repair_pending: false,
      next_repair_since: null,
      next_parked: { repo_id: parked, reason: "growth", retry_at: 99 },
      first_uncovered: null,
    });
    await db.prepare("DELETE FROM search_repairs").run();
    expect((await status(admin.token)).body.search).toMatchObject({
      repair_pending: false,
      next_parked: null,
    });
  });

  it("reads each of search's rows through its own index, in its order", async () => {
    const through = {
      nextDue: "search_repairs_due",
      nextParked: "search_repairs_retry",
      firstUncovered: "search_sources_uncovered",
      firstHidden: "search_sources_visible",
      nextPurge: "search_purges_generation",
    };
    for (const [name, sql] of Object.entries(STATUS_QUERIES)) {
      const { results } = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>();
      const plan = results.map((r) => r.detail).join(" | ");
      expect(plan, name).toMatch(
        new RegExp(
          `^(SEARCH|SCAN) search_\\w+ USING (COVERING )?INDEX ${through[name as keyof typeof through]}\\b`,
        ),
      );
      expect(plan, name).not.toMatch(/TEMP B-TREE/);
    }
  });
});
