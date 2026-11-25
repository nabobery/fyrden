import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ciVariableOverrides } from "../src/ci/budget.js";
import type { RepoDO } from "../src/do/RepoDO.js";
import { IN_BETWEEN_CAP } from "../src/do/repo/run-history.js";
import { ciFixture } from "./helpers/ci-webhooks.js";
import { rowCountingD1 } from "./helpers/d1.js";
import { inRepo } from "./helpers/repo-git.js";
import {
  advance,
  assignNamed,
  drain,
  type Fixture,
  finish,
  job,
  runStub,
  started,
  workflow,
} from "./helpers/runs.js";
import { webhookTest } from "./helpers/webhooks.js";

const t = webhookTest();
let f: Fixture;

beforeEach(async () => {
  f = await ciFixture(t);
});

const CI_EVENTS = ["check_run", "workflow_run", "workflow_job"];
const matrix = (n: number) =>
  workflow(
    job("m", [
      "strategy:",
      "  matrix:",
      `    n: [${Array.from({ length: n }, (_, i) => i + 1).join(", ")}]`,
    ]),
  );

type Counted = { counted: { rows: number; events: number }; exec: SqlStorage["exec"] };

async function writes(work: () => Promise<unknown>) {
  await inRepo(t.stub(), (r: RepoDO) => {
    const { sql } = r.git.context.storage;
    const counted = { rows: 0, events: 0 };
    const exec = sql.exec.bind(sql);
    Object.assign(r, { counted, exec: sql.exec });
    sql.exec = ((query: string, ...bindings: unknown[]) => {
      const cursor = exec(query, ...(bindings as []));
      const rows = cursor.toArray();
      counted.rows += cursor.rowsWritten;
      if (query.includes("INSERT INTO outbox ")) counted.events++;
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error("not one row");
          return rows[0];
        },
        [Symbol.iterator]: () => rows[Symbol.iterator](),
        rowsWritten: cursor.rowsWritten,
        rowsRead: cursor.rowsRead,
      };
    }) as unknown as typeof sql.exec;
  });
  try {
    await work();
  } finally {
    await inRepo(t.stub(), (r: RepoDO) => {
      const { sql } = r.git.context.storage;
      sql.exec = (r as unknown as Counted).exec;
    });
  }
  return inRepo(t.stub(), (r: RepoDO) => ({ ...(r as unknown as Counted).counted }));
}

const drainOutbox = () => inRepo(t.stub(), (r: RepoDO) => r.outbox.drain(t.repo.id));

async function oneJob() {
  const runId = await started(f, workflow(job("build")));
  await advance(runId, 2_000);
  await assignNamed(runId, "build");
  await advance(runId, 2_000);
  await finish(runId, "build");
  await advance(runId, 2_000);
}

describe("what CI webhooks cost", () => {
  it("is no event while no hook takes them, and a job's moves nothing but the run's row", async () => {
    const started = await writes(oneJob);
    expect(started).toEqual({ rows: 15, events: 0 });
  });

  it("is three rows of the repository's object an event, and one a batch sent", async () => {
    const none = await writes(oneJob);
    await t.createHook({ events: CI_EVENTS });
    await drainOutbox();
    const told = await writes(async () => {
      await oneJob();
      await drainOutbox();
    });
    expect(told.events).toBe(8);
    expect(told.rows - none.rows).toBeLessThanOrEqual(3 * told.events + 4);
  });

  it("is bounded for the largest matrix on Free", async () => {
    ciVariableOverrides.FYRDEN_PLAN = "free";
    const run = async () => {
      const runId = await started(f, matrix(256));
      await advance(runId, 2_000);
      expect((await runStub(runId).cancel(t.owner.principalId, "force")).ok).toBe(true);
      await drain(runId);
      await advance(runId, 2_000);
      for (let i = 0; i < 10; i++) await drainOutbox();
    };
    const none = await writes(run);
    await t.createHook({ events: CI_EVENTS });
    await drainOutbox();
    const told = await writes(run);
    expect(told.events).toBe(2 * 256 + 2 * IN_BETWEEN_CAP + 3);
    expect(told.rows - none.rows).toBeLessThanOrEqual(3 * told.events + 40);
  });

  it("is a bounded number of the read model's rows an event", async () => {
    await t.createHook({ events: CI_EVENTS });
    await oneJob();
    const events = await t.routed();
    const rows = { read: 0, written: 0 };
    await t.materialize(events, 1, rowCountingD1(env.ORG_READ, rows));
    expect((await t.deliveries()).filter((d) => d.state === "done")).toHaveLength(events.length);
    expect(rows.written / events.length).toBeLessThanOrEqual(45);
  });
});
