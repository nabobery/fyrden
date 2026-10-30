// Search's projections written live by the events consumer: while the
// deployment's search indexing is on, a repository envelope's issue, pull
// request, label and milestone snapshots are projected in the message's own
// batch, under the day's allowance and the database's size threshold, and
// what the projections then miss (a refused admission, a stored payload gone,
// a restored source, a row that cannot be read) asks for a reconciliation.
import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  createIdFactory,
  type DomainEvent,
  type IssueRow,
  type LabelRow,
  type MilestoneRow,
  secureRandomBytes,
} from "@fyrden/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { applyEnvelope, consumeEvents, EVENTS_QUEUE } from "../src/queues/events-consumer.js";
import { READ_MODEL_ADMISSION } from "../src/read-model/executor.js";
import { ADMISSION } from "../src/search/admission.js";
import { liveSearch } from "../src/search/live.js";

const newId = createIdFactory(Date.now, secureRandomBytes);
const OWNER = "usr_01K742SG00NAWD8WB4RTMJF8H8";
const db = env.ORG_READ;

async function listedRepo(): Promise<string> {
  const id = newId("rep");
  await env.DIRECTORY.prepare(
    "INSERT INTO principals (id, type, handle, created_at) VALUES (?, 'user', ?, 0) ON CONFLICT DO NOTHING",
  )
    .bind(OWNER, "live-search-owner")
    .run();
  await env.DIRECTORY.prepare(
    `INSERT INTO repos (id, owner_id, name, network_id, org_shard, visibility, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'default', 'private', 'active', 0, 0)`,
  )
    .bind(id, OWNER, id.toLowerCase(), newId("net"))
    .run();
  return id;
}

const indexing = (on: boolean) =>
  on
    ? env.DIRECTORY.prepare(
        `INSERT INTO deployment_settings (name, value, updated_at) VALUES ('search_indexing', 'on', 0)
         ON CONFLICT (name) DO UPDATE SET value = 'on'`,
      ).run()
    : env.DIRECTORY.prepare("DELETE FROM deployment_settings WHERE name = 'search_indexing'").run();

/** The database's own day (the allowance's). */
async function today(): Promise<number> {
  const row = await db
    .prepare("SELECT CAST(unixepoch() / 86400 AS INTEGER) AS day")
    .first<{ day: number }>();
  return row?.day as number;
}

async function spent(): Promise<number> {
  const row = await db
    .prepare("SELECT rows FROM search_budget WHERE day = ?")
    .bind(await today())
    .first<{ rows: number }>();
  return row?.rows ?? 0;
}

const issue = (number: number, overrides: Partial<IssueRow> = {}): IssueRow => ({
  number,
  title: `Issue ${number}`,
  body: "Something is broken.",
  state: "open",
  stateReason: null,
  duplicateOf: null,
  locked: false,
  lockReason: null,
  authorId: "usr_author",
  authorRoot: "usr_author",
  closedAt: null,
  closedBy: null,
  createdAt: 10,
  updatedAt: 20,
  labels: [],
  assignees: [],
  milestone: null,
  ...overrides,
});

const label = (id: number): LabelRow => ({
  id,
  name: "bug",
  color: "d73a4a",
  description: null,
  isDefault: false,
  createdAt: 1,
  updatedAt: 1,
});

const milestone = (number: number): MilestoneRow => ({
  number,
  title: "v1",
  description: null,
  state: "open",
  dueOn: null,
  closedAt: null,
  openIssues: 0,
  closedIssues: 0,
  openPulls: 0,
  closedPulls: 0,
  creator: "usr_author",
  createdAt: 1,
  updatedAt: 1,
});

/** An event of `repoId` at `seq` carrying a snapshot of `type` (`id` after the repository's). */
function snapshotEvent(
  repoId: string,
  seq: number,
  type: string,
  key: string,
  row: object | null,
  options: { version?: number; epochGen?: number; deleted?: boolean; stored?: boolean } = {},
): DomainEvent {
  const deleted = options.deleted ?? false;
  return {
    id: { sourceId: repoId, epochGen: options.epochGen ?? 1, sourceSeq: seq },
    type: `${type}.${deleted ? "deleted" : "updated"}`,
    at: 1,
    actor: null,
    actChain: [],
    ownerGen: 1,
    entity: {
      type,
      id: `${repoId}#${key}`,
      version: options.version ?? seq,
      deleted,
      row: deleted || options.stored ? null : (row as Record<string, unknown>),
    },
    data: null,
    stored: options.stored ?? false,
  };
}

const issueEvent = (repoId: string, seq: number, row: IssueRow | null, options = {}) =>
  snapshotEvent(repoId, seq, "issue", String(row?.number ?? seq), row, options);

async function deliver(bodies: unknown[], on: Env = env) {
  const batch = createMessageBatch(
    EVENTS_QUEUE,
    bodies.map((body, i) => ({ id: `m${i}`, timestamp: new Date(), attempts: 1, body })),
  );
  const ctx = createExecutionContext();
  await consumeEvents(batch, on, { sinks: [] });
  return getQueueResult(batch, ctx);
}

const docs = (repoId: string) =>
  db
    .prepare(
      "SELECT number, kind, title, body, deleted, version FROM search_docs WHERE repo_id = ? ORDER BY number",
    )
    .bind(repoId)
    .all<{
      number: number;
      kind: number;
      title: string | null;
      body: string | null;
      deleted: number;
      version: number;
    }>()
    .then((r) => r.results);

const repair = (repoId: string) =>
  db
    .prepare("SELECT dirty, covered, reason FROM search_repairs WHERE repo_id = ?")
    .bind(repoId)
    .first<{ dirty: number; covered: number; reason: string }>();

beforeEach(() => indexing(true));
afterEach(async () => {
  await indexing(false);
  await db.prepare("DELETE FROM search_budget").run();
  await db.prepare("UPDATE search_size SET bytes = 0, observed = 0 WHERE id = 1").run();
});

describe("search's live projection", () => {
  it("writes nothing while search indexing is off", async () => {
    await indexing(false);
    const repoId = await listedRepo();
    const result = await deliver([{ sourceId: repoId, events: [issueEvent(repoId, 1, issue(1))] }]);
    expect(result.explicitAcks).toEqual(["m0"]);
    expect(await docs(repoId)).toEqual([]);
    expect(await spent()).toBe(0);
    expect(await repair(repoId)).toBeNull();
  });

  it("projects an envelope's issues, labels and milestones, each entity's newest snapshot", async () => {
    const repoId = await listedRepo();
    await deliver([
      {
        sourceId: repoId,
        events: [
          issueEvent(repoId, 1, issue(1, { title: "first" })),
          issueEvent(repoId, 2, issue(1, { title: "second" })),
          issueEvent(repoId, 3, issue(2)),
          snapshotEvent(repoId, 4, "label", "labels/7", label(7)),
          snapshotEvent(repoId, 5, "milestone", "milestones/1", milestone(1)),
        ],
      },
    ]);
    expect(await docs(repoId)).toMatchObject([
      { number: 1, kind: 1, title: "second", version: 2, deleted: 0 },
      { number: 2, title: "Issue 2", deleted: 0 },
    ]);
    const labels = await db
      .prepare("SELECT name FROM search_labels WHERE repo_id = ?")
      .bind(repoId)
      .all();
    expect(labels.results).toEqual([{ name: "bug" }]);
    const milestones = await db
      .prepare("SELECT title FROM search_milestones WHERE repo_id = ?")
      .bind(repoId)
      .all();
    expect(milestones.results).toEqual([{ title: "v1" }]);
    expect(await repair(repoId)).toBeNull();
  });

  it("projects a stored snapshot with the payload its repository keeps", async () => {
    const repoId = await listedRepo();
    await runInDurableObject(env.REPO.getByName(repoId), (_: RepoDO, state) => {
      state.storage.sql.exec(
        "INSERT INTO event_payloads (event_key, payload, created_at) VALUES (?, ?, 0)",
        `${repoId}:1:1`,
        JSON.stringify({ row: issue(1, { body: "kept by its repository" }) }),
      );
    });
    await deliver([
      { sourceId: repoId, events: [issueEvent(repoId, 1, issue(1), { stored: true })] },
    ]);
    expect(await docs(repoId)).toMatchObject([{ number: 1, body: "kept by its repository" }]);
  });

  it("asks for a reconciliation when a stored snapshot's payload is gone", async () => {
    const repoId = await listedRepo();
    const result = await deliver([
      {
        sourceId: repoId,
        events: [
          issueEvent(repoId, 1, issue(1), { stored: true }),
          issueEvent(repoId, 2, issue(2)),
        ],
      },
    ]);
    expect(result.explicitAcks).toEqual(["m0"]);
    expect(await docs(repoId)).toMatchObject([{ number: 2 }]);
    expect(await repair(repoId)).toMatchObject({ dirty: 1, reason: "payload_missing" });
  });

  it("asks for a reconciliation when its source's epoch advances, not when it is first seen", async () => {
    const repoId = await listedRepo();
    await deliver([{ sourceId: repoId, events: [issueEvent(repoId, 1, issue(1))] }]);
    expect(await repair(repoId)).toBeNull();
    await deliver([
      { sourceId: repoId, events: [issueEvent(repoId, 1, issue(3), { epochGen: 2 })] },
    ]);
    expect(await repair(repoId)).toMatchObject({ dirty: 1, reason: "epoch_advanced" });
    expect(await docs(repoId)).toMatchObject([{ number: 1 }, { number: 3 }]);
  });

  it("skips a snapshot whose row cannot be read, asking for a reconciliation, and applies the rest", async () => {
    const repoId = await listedRepo();
    const result = await deliver([
      {
        sourceId: repoId,
        events: [
          snapshotEvent(repoId, 1, "issue", "1", { number: 1, title: 5 }),
          issueEvent(repoId, 2, issue(2)),
        ],
      },
    ]);
    expect(result.explicitAcks).toEqual(["m0"]);
    expect(await docs(repoId)).toMatchObject([{ number: 2 }]);
    expect(await repair(repoId)).toMatchObject({ dirty: 1, reason: "malformed_row" });
  });
});

describe("search's live projection, admitted", () => {
  it("charges the day what its writes used, not what they reserved", async () => {
    const repoId = await listedRepo();
    await deliver([{ sourceId: repoId, events: [issueEvent(repoId, 1, issue(1))] }]);
    const first = await spent();
    // A document's insert (its indexes included) and the bookkeeping (11 as measured), with the
    // admissions of its batch and of the settlement's, less than the 15 reserved (6 for the
    // statement, 9 for bookkeeping) and the settlement's charge.
    const admissions = 2 * READ_MODEL_ADMISSION.rows;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(12 + admissions);
    // A duplicate writes no projection row: only the bookkeeping is charged (4 as measured).
    await deliver([{ sourceId: repoId, events: [issueEvent(repoId, 1, issue(1))] }]);
    expect((await spent()) - first).toBeLessThanOrEqual(5 + admissions);
  });

  it("refuses additions past the day's allowance, still removes, and asks for a reconciliation", async () => {
    const repoId = await listedRepo();
    await deliver([{ sourceId: repoId, events: [issueEvent(repoId, 1, issue(1))] }]);
    await db
      .prepare("UPDATE search_budget SET rows = ? WHERE day = ?")
      .bind(ADMISSION.dailyRows, await today())
      .run();
    await deliver([
      {
        sourceId: repoId,
        events: [
          issueEvent(repoId, 2, issue(2)),
          issueEvent(repoId, 3, null, { deleted: true, version: 3 }),
          snapshotEvent(repoId, 4, "issue", "1", null, { deleted: true }),
        ],
      },
    ]);
    // The new issue refused, and the deletion of one never projected (it would add a row); the
    // projected one's deletion made whatever the allowance (it empties its row).
    expect(await docs(repoId)).toMatchObject([{ number: 1, deleted: 1, title: null }]);
    expect(await repair(repoId)).toMatchObject({ dirty: 1, reason: "admission" });
  });

  it("adds no row for a deletion of what was never projected when refused, and asks for a reconciliation", async () => {
    const repoId = await listedRepo();
    await deliver([{ sourceId: repoId, events: [issueEvent(repoId, 1, issue(1))] }]);
    await db
      .prepare("UPDATE search_budget SET rows = ? WHERE day = ?")
      .bind(ADMISSION.dailyRows, await today())
      .run();
    // Deletions only: one of a projected issue, one of an issue never projected.
    await deliver([
      {
        sourceId: repoId,
        events: [
          snapshotEvent(repoId, 2, "issue", "1", null, { deleted: true }),
          snapshotEvent(repoId, 3, "issue", "9", null, { deleted: true }),
        ],
      },
    ]);
    expect(await docs(repoId)).toMatchObject([{ number: 1, deleted: 1, title: null }]);
    expect(await repair(repoId)).toMatchObject({ dirty: 1, reason: "admission" });
  });

  it("charges the day what a source's restore asks of it, with nothing to project", async () => {
    const repoId = await listedRepo();
    await deliver([{ sourceId: repoId, events: [issueEvent(repoId, 1, issue(1))] }]);
    const before = await spent();
    // A restored repository's first event: its epoch advances, and it carries no snapshot search
    // projects (a repository event).
    await deliver([
      {
        sourceId: repoId,
        events: [
          {
            ...issueEvent(repoId, 1, issue(1)),
            id: { sourceId: repoId, epochGen: 2, sourceSeq: 1 },
            type: "push",
            entity: null,
          },
        ],
      },
    ]);
    expect(await repair(repoId)).toMatchObject({ reason: "epoch_advanced" });
    expect(await spent()).toBeGreaterThan(before);
  });

  it("charges an unreserved batch every row its search statements and bookkeeping wrote", async () => {
    const repoId = newId("rep");
    const live = liveSearch(db, repoId, [], { epochGen: 1, now: 0, missing: true });
    // What D1 reported: the epoch's request 3 rows, the payload's request 2, the tick 1.
    const result = (rows: number, results: unknown[] = []) =>
      ({
        results,
        success: true,
        meta: { rows_written: rows, size_after: 4_096 },
      }) as unknown as D1Result;
    const settlement = live.settlement(
      [result(3)],
      [result(2), result(1, [{ clock: 1_000_000 }])],
      result(0),
    );
    const before = await spent();
    await db.batch(settlement);
    // 6 written, the batch's admission (counted with another's statement, last in it), the size
    // observation 1, the charge itself 1, and the admission of the batch the charge is applied in.
    expect((await spent()) - before).toBe(
      6 + READ_MODEL_ADMISSION.rows + 1 + 1 + READ_MODEL_ADMISSION.rows,
    );
  });

  it("charges nothing for a batch without search's statements", () => {
    // An envelope with nothing to project, nothing missing, and no epoch advanced.
    const live = liveSearch(db, newId("rep"), [], { epochGen: 1, now: 0, missing: false });
    expect(live.after).toEqual([]);
    const epochRequest = {
      results: [],
      success: true,
      meta: { rows_written: 0 },
    } as unknown as D1Result;
    const others = { results: [], success: true, meta: { rows_written: 5 } } as unknown as D1Result;
    expect(live.settlement([epochRequest], [], others)).toEqual([]);
  });

  it("refuses additions while the database is at its size threshold", async () => {
    const repoId = await listedRepo();
    await db
      .prepare("UPDATE search_size SET bytes = ? WHERE id = 1")
      .bind(ADMISSION.maxBytes)
      .run();
    await deliver([{ sourceId: repoId, events: [issueEvent(repoId, 1, issue(1))] }]);
    expect(await docs(repoId)).toEqual([]);
    expect(await repair(repoId)).toMatchObject({ reason: "admission" });
  });

  it("records the database's size its batch reported", async () => {
    const repoId = await listedRepo();
    const before = await db
      .prepare("SELECT clock, observed FROM search_size WHERE id = 1")
      .first<{ clock: number; observed: number }>();
    await deliver([{ sourceId: repoId, events: [issueEvent(repoId, 1, issue(1))] }]);
    const after = await db
      .prepare("SELECT clock, observed, bytes FROM search_size WHERE id = 1")
      .first<{ clock: number; observed: number; bytes: number }>();
    expect(after?.clock).toBe((before?.clock ?? 0) + 1);
    expect(after?.observed).toBe(after?.clock);
    expect(after?.bytes).toBeGreaterThan(0);
  });

  it("settles a lone envelope's reservation itself", async () => {
    const repoId = await listedRepo();
    await applyEnvelope(
      env,
      { sourceId: repoId, events: [issueEvent(repoId, 1, issue(1))] },
      {
        sinks: [],
      },
    );
    expect(await spent()).toBeLessThanOrEqual(12 + 2 * READ_MODEL_ADMISSION.rows);
    expect(await docs(repoId)).toMatchObject([{ number: 1 }]);
  });

  it("charges its batch's admission when statements of others follow search's", async () => {
    // A sink journaling an effect for every event: its statements come last in the batch.
    const trailing = {
      name: "trailing",
      plan: () => [{ target: "t", payload: {} }],
      deliver: async () => {},
    };
    const apply = async (sinks: (typeof trailing)[]) => {
      const repoId = await listedRepo();
      const before = await spent();
      await applyEnvelope(
        env,
        { sourceId: repoId, events: [issueEvent(repoId, 1, issue(1))] },
        {
          sinks,
        },
      );
      return (await spent()) - before;
    };
    // (The day's row made first: each charge below is a document's alone.)
    await apply([]);
    expect(await apply([trailing])).toBe(await apply([]));
  });

  it("makes one call more an invocation, none more a message", async () => {
    const repoId = await listedRepo();
    const counting = (target: D1Database, count: { calls: number }) =>
      new Proxy(target, {
        get(t, prop) {
          if (prop === "batch")
            return (statements: D1PreparedStatement[]) => {
              count.calls++;
              return t.batch(statements);
            };
          if (prop === "prepare")
            return (sql: string) => {
              const statement = t.prepare(sql);
              const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
                new Proxy(s, {
                  get(st, p) {
                    if (p === "bind") return (...v: unknown[]) => wrap(st.bind(...v));
                    if (p === "first" || p === "all" || p === "run" || p === "raw")
                      return (...a: unknown[]) => {
                        count.calls++;
                        return (Reflect.get(st, p) as (...x: unknown[]) => unknown).apply(st, a);
                      };
                    const value = Reflect.get(st, p);
                    return typeof value === "function" ? value.bind(st) : value;
                  },
                });
              return wrap(statement);
            };
          const value = Reflect.get(t, prop);
          return typeof value === "function" ? value.bind(t) : value;
        },
      });
    const run = async (on: boolean) => {
      await indexing(on);
      const count = { calls: 0 };
      const envelopes = [1, 2, 3].map((n) => ({
        sourceId: repoId,
        events: [issueEvent(repoId, n + (on ? 10 : 0), issue(n + (on ? 10 : 0)))],
      }));
      await deliver(envelopes, { ...env, ORG_READ: counting(env.ORG_READ, count) });
      return count.calls;
    };
    const off = await run(false);
    const on = await run(true);
    expect(on).toBe(off + 1);
  });
});
