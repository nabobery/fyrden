// The operator's backfill of search's projections: a reconciliation asked
// for every active repository, a page of them a call, which the repair job
// then works within search's allowance.
import { env } from "cloudflare:workers";
import { createIdFactory, secureRandomBytes } from "@fyrden/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_ORG_SHARD, readModelFor } from "../src/events/read-model.js";
import type { OpContext } from "../src/ops/execute.js";
import { READ_MODEL_ADMISSION, READ_MODEL_LONE_WRITE } from "../src/read-model/executor.js";
import { backfillSearchOperation } from "../src/search/backfill.js";
import { REQUEST_ROWS, repairStatement } from "../src/search/repairs.js";
import { api, json, user, type Who } from "./helpers/api.js";

const newId = createIdFactory(Date.now, secureRandomBytes);
const OWNER = "usr_01K742SG00NAWD8WB4RTMJF8H9";
// Written as production writes it: through the read model's executor.
const db = readModelFor(env, DEFAULT_ORG_SHARD);

let admin: Who;
beforeAll(async () => {
  admin = await user(true);
});

const indexing = (on: boolean) =>
  on
    ? env.DIRECTORY.prepare(
        `INSERT INTO deployment_settings (name, value, updated_at) VALUES ('search_indexing', 'on', 0)
         ON CONFLICT (name) DO UPDATE SET value = 'on'`,
      ).run()
    : env.DIRECTORY.prepare("DELETE FROM deployment_settings WHERE name = 'search_indexing'").run();

const spent = async () =>
  (
    await db
      .prepare("SELECT rows FROM search_budget WHERE day = CAST(unixepoch() / 86400 AS INTEGER)")
      .first<{ rows: number }>()
  )?.rows ?? 0;

/** Repositories listed in the directory, `state` each. */
async function listed(count: number, state: "active" | "deleting" = "active"): Promise<string[]> {
  await env.DIRECTORY.prepare(
    "INSERT INTO principals (id, type, handle, created_at) VALUES (?, 'user', ?, 0) ON CONFLICT DO NOTHING",
  )
    .bind(OWNER, "backfill-owner")
    .run();
  const ids = Array.from({ length: count }, () => newId("rep"));
  await env.DIRECTORY.batch(
    ids.map((id) =>
      env.DIRECTORY.prepare(
        `INSERT INTO repos (id, owner_id, name, network_id, org_shard, visibility, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'default', 'private', ?, 0, 0)`,
      ).bind(id, OWNER, id.toLowerCase(), newId("net"), state),
    ),
  );
  return ids;
}

type Backfill = { requested: number; next_cursor: string | null };

/** Calls the backfill until it is through, page by page. */
async function backfill(): Promise<Backfill[]> {
  const pages: Backfill[] = [];
  let cursor: string | null | undefined;
  do {
    const { status, body } = await json<Backfill>(
      api("POST", "/admin/search/backfill", admin.token, cursor ? { cursor } : {}),
    );
    expect(status).toBe(200);
    pages.push(body);
    cursor = body.next_cursor;
  } while (cursor);
  return pages;
}

const requests = async (ids: readonly string[]) => {
  const { results } = await db
    .prepare(
      "SELECT repo_id, reason FROM search_repairs WHERE repo_id IN (SELECT value FROM json_each(?)) AND dirty > covered",
    )
    .bind(JSON.stringify(ids))
    .all<{ repo_id: string; reason: string }>();
  return results;
};

describe("search's backfill", () => {
  it("asks for every active repository's reconciliation, a page at a time, each once", async () => {
    await indexing(true);
    const active = await listed(130);
    const deleting = await listed(2, "deleting");
    // A repository whose deletion the read model holds is never asked for.
    const [gone] = await listed(1);
    await db
      .prepare(
        `INSERT INTO repos (repo_id, deleted, epoch_gen, version, owner_gen, updated_seq, updated_at)
         VALUES (?, 1, 1, 1, 1, 1, 0)`,
      )
      .bind(gone)
      .run();
    const pages = await backfill();
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.at(-1)?.next_cursor).toBeNull();
    expect(pages.reduce((n, page) => n + page.requested, 0)).toBeGreaterThanOrEqual(active.length);
    const asked = await requests([...active, ...deleting, gone as string]);
    expect(asked.map((r) => r.repo_id).sort()).toEqual([...active].sort());
    expect(new Set(asked.map((r) => r.reason))).toEqual(new Set(["backfill"]));
    // Asked again while they wait: nothing new.
    const again = await backfill();
    expect(again.reduce((n, page) => n + page.requested, 0)).toBe(0);
  });

  it("charges what its requests may write in their own batch", async () => {
    await indexing(true);
    const ids = await listed(3);
    // What a request writes, at most: a new one's row and its index entries.
    const probe = await db.batch(ids.map((id) => repairStatement(db, `${id}x`, "probe", 0)));
    // (The batch's last result carries its admission's rows too.)
    for (const [i, result] of probe.entries())
      expect(
        (result.meta.rows_written ?? 0) - (i === probe.length - 1 ? READ_MODEL_ADMISSION.rows : 0),
      ).toBeLessThanOrEqual(REQUEST_ROWS);
    const before = await spent();
    const pages = await backfill();
    const asked = pages.reduce((n, page) => n + page.requested, 0);
    expect(asked).toBeGreaterThanOrEqual(3);
    // Every repository the pages went through, as if each wrote its row, and each batch's charge.
    expect((await spent()) - before).toBeGreaterThanOrEqual(asked * REQUEST_ROWS);
  });

  it("charges its requests in the batch that makes them", async () => {
    await indexing(true);
    const [first] = (await listed(2)).sort();
    const cursor = (first as string).slice(0, -1);
    // A read model whose every call after the first batch fails: the charge must not need one.
    let batches = 0;
    const real = new WeakMap<object, D1PreparedStatement>();
    const refused = () => {
      throw new Error("no more calls");
    };
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
      const proxy = new Proxy(statement, {
        get(target, p) {
          if (p === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
          if (p === "run" || p === "all" || p === "first" || p === "raw") return refused;
          const value = Reflect.get(target, p);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      real.set(proxy, statement);
      return proxy;
    };
    const once = new Proxy(db, {
      get(target, prop) {
        if (prop === "batch")
          return (statements: D1PreparedStatement[]) => {
            if (++batches > 1) refused();
            return target.batch(statements.map((s) => real.get(s) ?? s));
          };
        if (prop === "prepare") return (sql: string) => wrap(target.prepare(sql));
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const before = await spent();
    const metrics = { count() {}, gauge() {}, timing() {} } as unknown as OpContext["metrics"];
    const out = await backfillSearchOperation(
      { env: { ...env, ORG_READ: once }, metrics } as unknown as OpContext,
      // From just before them (the clock stands still in a test: ids of its millisecond sort at
      // random, so the page holds others too, already asked).
      { cursor },
    );
    // The first of them is first on the page (the other may sort past its end).
    expect(out.requested).toBeGreaterThanOrEqual(1);
    const page = await env.DIRECTORY.prepare(
      "SELECT count(*) AS n FROM (SELECT id FROM repos WHERE id > ? AND state = 'active' ORDER BY id LIMIT 100)",
    )
      .bind(cursor)
      .first<{ n: number }>();
    // Each request of the page as if it wrote its row, the batch's admission and lease, and the charge itself.
    expect((await spent()) - before).toBe(
      (page?.n ?? 0) * REQUEST_ROWS + READ_MODEL_LONE_WRITE.rows + 1,
    );
  });

  it("is refused while search indexing is off", async () => {
    await indexing(false);
    const res = await api("POST", "/admin/search/backfill", admin.token, {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe("search_indexing_off");
  });

  it("is for instance administrators only", async () => {
    const someone = await user();
    const res = await api("POST", "/admin/search/backfill", someone.token, {});
    expect(res.status).toBe(403);
  });
});
