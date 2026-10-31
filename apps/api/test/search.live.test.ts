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
import type { EffectSink } from "../src/effects/journal.js";
import {
  applyEnvelope,
  consumeEvents,
  EVENTS_QUEUE,
  SEARCH_CHUNK,
  type SearchContinuation,
} from "../src/queues/events-consumer.js";
import { READ_MODEL_ADMISSION } from "../src/read-model/executor.js";
import { ADMISSION, growthOf } from "../src/search/admission.js";
import { liveSearch } from "../src/search/live.js";
import { admitted } from "./helpers/read-model.js";

const newId = createIdFactory(Date.now, secureRandomBytes);
const OWNER = "usr_01K742SG00NAWD8WB4RTMJF8H8";
// Written as production writes it: through the read model's executor.
const db = admitted();

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

  it("projects an entity's snapshot of its newest ownership when two share an epoch and version", async () => {
    const repoId = await listedRepo();
    await db
      .prepare("INSERT INTO source_owner (source_id, owner_gen) VALUES (?, 2)")
      .bind(repoId)
      .run();
    // Before and after a transfer: one version, two ownerships.
    const before = issueEvent(repoId, 1, issue(1, { title: "Before" }), { version: 3 });
    const after = {
      ...issueEvent(repoId, 2, issue(1, { title: "After" }), { version: 3 }),
      ownerGen: 2,
    };
    await deliver([{ sourceId: repoId, events: [before, after] }]);
    expect(await docs(repoId)).toMatchObject([{ number: 1, title: "After" }]);
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
    // A document's insert (its indexes, its repository's number, the counters and its full-text
    // entry included) and the bookkeeping, its growth's receipt made and released included (21
    // as measured), with the admissions of its batch and of the settlement's, less than the 30
    // reserved (16 for the document, 14 for bookkeeping) and the settlement's charge.
    const admissions = 2 * READ_MODEL_ADMISSION.rows;
    expect(first).toBe(21 + admissions);
    // A duplicate writes no projection row: only the bookkeeping is charged, its growth's receipt
    // included (admitted before anything can tell it changes nothing: 8 as measured).
    await deliver([{ sourceId: repoId, events: [issueEvent(repoId, 1, issue(1))] }]);
    expect((await spent()) - first).toBe(8 + admissions);
  });

  it("charges the day's repository index allowance what a repository's own entry writes", async () => {
    const repoId = await listedRepo();
    const before = await spent();
    const repository: DomainEvent = {
      id: { sourceId: repoId, epochGen: 1, sourceSeq: 1 },
      type: "repo.updated",
      at: 1,
      actor: null,
      actChain: [],
      ownerGen: 1,
      entity: {
        type: "repo",
        id: repoId,
        version: 1,
        deleted: false,
        row: {
          ownerId: "usr_01K742SG00NAWD8WB4RTMJF8H9",
          name: `indexed-${repoId}`,
          visibility: "private",
          defaultBranch: "refs/heads/main",
          pushedAt: null,
          createdAt: 1,
          description: "Charged",
        },
      },
      data: null,
      stored: false,
    };
    await deliver([{ sourceId: repoId, events: [repository] }]);
    expect(
      await db
        .prepare("SELECT indexed FROM search_repo_nums WHERE repo_id = ?")
        .bind(repoId)
        .first(),
    ).toEqual({ indexed: 1 });
    // Charged with the repository index's own allowance: its admission and receipt, its numbers
    // (its repository's and its owner's, each with two keys), the counters past them, the count,
    // its membership (with its key among the index's members) and its entry (the repository's row
    // is the read model's, not search's), its receipt's release later, and the settlement's own
    // row: 21, measured; and the admissions of
    // the batch and of the settlement's, its alone. None with the projection rows.
    expect((await spent()) - before).toBe(0);
    expect(
      await db
        .prepare(
          "SELECT repo_rows FROM search_budget WHERE day = CAST(unixepoch() / 86400 AS INTEGER)",
        )
        .first(),
    ).toEqual({ repo_rows: 21 + 2 * READ_MODEL_ADMISSION.rows });
    // Renamed while search does not index: its entry taken out, and that charged too.
    await indexing(false);
    const renamed = {
      ...repository,
      id: { ...repository.id, sourceSeq: 2 },
      entity: {
        ...repository.entity,
        version: 2,
        row: { ...(repository.entity?.row ?? {}), name: `renamed-${repoId}` },
      },
    } as DomainEvent;
    await deliver([{ sourceId: repoId, events: [renamed] }]);
    expect(
      await db
        .prepare("SELECT indexed FROM search_repo_nums WHERE repo_id = ?")
        .bind(repoId)
        .first(),
    ).toEqual({ indexed: 0 });
    const after = await db
      .prepare(
        "SELECT repo_rows FROM search_budget WHERE day = CAST(unixepoch() / 86400 AS INTEGER)",
      )
      .first<{ repo_rows: number }>();
    expect(after?.repo_rows).toBeGreaterThan(21 + 2 * READ_MODEL_ADMISSION.rows);
  });

  it("admits growth only within the threshold, counting what other batches of the invocation reserved", async () => {
    const [a, b] = [await listedRepo(), await listedRepo()];
    const grows = growthOf([issue(1) as unknown as Record<string, unknown>]);
    // Room for one batch's growth exactly (the size held, as if observed, and nothing reserved).
    await db
      .prepare("UPDATE search_size SET bytes = ? WHERE id = 1")
      .bind(ADMISSION.maxBytes - grows)
      .run();
    // Two messages of one invocation: the first's receipt still held when the second admits.
    await deliver([
      { sourceId: a, events: [issueEvent(a, 1, issue(1))] },
      { sourceId: b, events: [issueEvent(b, 1, issue(1))] },
    ]);
    expect([await docs(a), await docs(b)]).toMatchObject([[{ number: 1 }], []]);
    expect(await repair(b)).toMatchObject({ reason: "admission" });
    // The invocation's observation released what it covered: nothing stays reserved.
    expect(await db.prepare("SELECT bytes_reserved FROM search_size WHERE id = 1").first()).toEqual(
      { bytes_reserved: 0 },
    );
    expect(await db.prepare("SELECT count(*) AS n FROM search_byte_reservations").first()).toEqual({
      n: 0,
    });
  });

  it("charges the admission of an invocation's settlements once", async () => {
    const [a, b] = [await listedRepo(), await listedRepo()];
    const before = await spent();
    await deliver([
      { sourceId: a, events: [issueEvent(a, 1, issue(1))] },
      { sourceId: b, events: [issueEvent(b, 1, issue(1))] },
    ]);
    // Each message's as one alone (today's row made by the first only), but one settlement
    // batch: its admission charged once.
    expect((await spent()) - before).toBe(
      2 * (21 + READ_MODEL_ADMISSION.rows) - 1 + READ_MODEL_ADMISSION.rows,
    );
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
    // 6 written, the batch's admission (counted with another's statement, last in it), the
    // charge itself 1, and the admission of the batch the charge is applied in.
    expect((await spent()) - before).toBe(
      6 + READ_MODEL_ADMISSION.rows + 1 + READ_MODEL_ADMISSION.rows,
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

  it("records the size its invocation left the database at, by the executor's sequence", async () => {
    const repoId = await listedRepo();
    const before = await db
      .prepare("SELECT clock, observed FROM search_size WHERE id = 1")
      .first<{ clock: number; observed: number }>();
    await deliver([{ sourceId: repoId, events: [issueEvent(repoId, 1, issue(1))] }]);
    const after = await db
      .prepare("SELECT clock, observed, bytes FROM search_size WHERE id = 1")
      .first<{ clock: number; observed: number; bytes: number }>();
    // No clock of its own any more: the writer's commit sequence orders observations.
    expect(after?.clock).toBe(before?.clock);
    expect(after?.observed).toBeGreaterThan(before?.observed ?? 0);
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
    expect(await spent()).toBe(21 + 2 * READ_MODEL_ADMISSION.rows);
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

describe("search's live projection of a large envelope", () => {
  /** Queues' limit on a message (bytes of its JSON body). */
  const MESSAGE_BYTES = 128_000;
  const counts = { fetched: 0, planned: 0 };
  const sent: unknown[] = [];
  /**
   * `env` whose events queue keeps what is sent to it within the queue's limit (or refuses it,
   * `refuse`), and whose repository objects' payloads are counted as they are fetched.
   */
  const counted = (refuse = false) =>
    ({
      ...env,
      EVENTS: {
        send: async (body: unknown) => {
          if (refuse) throw new Error("queue unavailable");
          if (new TextEncoder().encode(JSON.stringify(body)).length > MESSAGE_BYTES)
            throw new Error("message too large");
          sent.push(body);
        },
      },
      REPO: {
        getByName: (name: string) => {
          const real = env.REPO.getByName(name);
          return {
            eventPayload: (key: string) => {
              counts.fetched++;
              return real.eventPayload(key);
            },
          };
        },
      },
    }) as unknown as Env;
  // A sink that plans nothing, counting what it is asked to plan.
  const sink = {
    name: "test_counting",
    plan: () => {
      counts.planned++;
      return [];
    },
    deliver: async () => {},
  } as unknown as EffectSink;
  const consume = async (bodies: unknown[], on: Env) => {
    const batch = createMessageBatch(
      EVENTS_QUEUE,
      bodies.map((body, i) => ({ id: `m${i}`, timestamp: new Date(), attempts: 1, body })),
    );
    const ctx = createExecutionContext();
    await consumeEvents(batch, on, { sinks: [sink] });
    return getQueueResult(batch, ctx);
  };
  /** Twenty issues of 60,000 characters each, kept by their repository: more than a batch indexes. */
  async function large(repoId: string): Promise<DomainEvent[]> {
    const rows = Array.from({ length: 20 }, (_, i) =>
      issue(i + 1, { body: `${i} ${"é".repeat(30_000)}` }),
    );
    await runInDurableObject(env.REPO.getByName(repoId), (_: RepoDO, state) => {
      for (const [i, row] of rows.entries())
        state.storage.sql.exec(
          "INSERT INTO event_payloads (event_key, payload, created_at) VALUES (?, ?, 0)",
          `${repoId}:1:${i + 1}`,
          JSON.stringify({ row }),
        );
    });
    return rows.map((row, i) => issueEvent(repoId, i + 1, row, { stored: true }));
  }

  beforeEach(() => {
    counts.fetched = 0;
    counts.planned = 0;
    sent.length = 0;
  });

  it("projects a chunk a batch, sends the rest on for search alone, and asks for a reconciliation", async () => {
    const repoId = await listedRepo();
    const events = await large(repoId);
    // Each body: 60,003 bytes of UTF-8 (two a character), its title a few more.
    const perIssue = 2 + 2 * 30_000 + new TextEncoder().encode("Issue 10").length;
    const fits = Math.floor(SEARCH_CHUNK.bytes / perIssue);
    expect((await consume([{ sourceId: repoId, events }], counted())).explicitAcks).toEqual(["m0"]);
    expect((await docs(repoId)).length).toBe(fits);
    // Every payload once (the sinks see every event whole; the chunk takes what they fetched),
    // and planning for every event.
    expect(counts).toEqual({ fetched: 20, planned: 20 });
    expect(sent).toHaveLength(1);
    const continuation = sent[0] as SearchContinuation;
    // The rest as they travelled: stored, without their rows.
    expect(continuation).toMatchObject({ type: "search.continue", sourceId: repoId });
    expect(continuation.events.map((e) => [e.entity.id, e.stored, e.entity.row])).toEqual(
      Array.from({ length: 20 - fits }, (_, i) => [`${repoId}#${fits + i + 1}`, true, null]),
    );
    expect(await repair(repoId)).toMatchObject({ reason: "search_continuation" });
    // The continuation: the rest projected, nothing sent on, and no effect planned.
    counts.fetched = 0;
    counts.planned = 0;
    sent.length = 0;
    expect((await consume([continuation], counted())).explicitAcks).toEqual(["m0"]);
    expect((await docs(repoId)).map((d) => d.number)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    expect([counts, sent]).toEqual([{ fetched: 20 - fits, planned: 0 }, []]);
    // Delivered again: nothing changes, nothing is counted twice.
    const indexed = await db
      .prepare("SELECT live_docs FROM search_index_state WHERE id = 1")
      .first();
    await consume([continuation], counted());
    expect(
      await db.prepare("SELECT live_docs FROM search_index_state WHERE id = 1").first(),
    ).toEqual(indexed);
    // Still not covered: only a reconciliation covers what continuations carried.
    expect(await repair(repoId)).toMatchObject({ covered: 0 });
  });

  it("does not acknowledge an envelope whose continuation could not be sent", async () => {
    const repoId = await listedRepo();
    const result = await consume(
      [{ sourceId: repoId, events: await large(repoId) }],
      counted(true),
    );
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages.map((m) => m.msgId)).toEqual(["m0"]);
  });
});
