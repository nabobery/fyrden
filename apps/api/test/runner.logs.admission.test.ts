// On Free, each live log ticket is granted from the CI ledger as a viewer
// before it is answered: priced from the job's log stored when it is issued
// and charged on every UTC day from issuance to the end of its socket's
// life, viewers together within a quarter of the allowance. A ticket the
// ledger refuses, or cannot answer for, is deleted before the refusal is
// answered. Paid prices nothing. Each test sets D1's ledger clock and the
// run's clock to the same instant, on a UTC day no other test of the file
// charges. No runner is registered in this file, so the fleet stays within
// its cap.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  CI_NOW,
  ciAllowance,
  ciEnv,
  ciFleetCap,
  ciJobPrice,
  ciVariableOverrides,
  ciViewerBudget,
  ciViewerPrice,
  grantCi,
} from "../src/ci/budget.js";
import { ticketHash } from "../src/do/user/live.js";
import { api, json } from "./helpers/api.js";
import { pinD1Clock } from "./helpers/d1.js";
import { orgRepo } from "./helpers/runners.js";
import { at, drain, inRun, job, jobNamed, started, workflow } from "./helpers/runs.js";

const ORIGIN = "https://fyrden.test";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const one = workflow(job("a"));

const ledgerClock = { now: 0 };
let unpin: () => void;
beforeAll(() => {
  unpin = pinD1Clock(CI_NOW, ledgerClock);
});
afterAll(() => unpin());

let days = 0;
/** Noon of a UTC day no other test of this file charges: the ledger's days are the deployment's. */
function freshNoon(): number {
  days += 4;
  return Date.UTC(2032, 0, 1) + days * DAY + 12 * HOUR;
}

/**
 * A new run's queued job (reserved as on Paid, the setup's plan), then the
 * run's clock and D1's ledger clock at `t` and the deployment on Free.
 */
async function queuedAt(t: number) {
  const f = await orgRepo();
  const runId = await started(f, one);
  const { jobId } = await jobNamed(runId, "a");
  ledgerClock.now = t;
  await at(runId, t);
  ciVariableOverrides.FYRDEN_PLAN = "free";
  return { f, runId, jobId };
}

type Queued = Awaited<ReturnType<typeof queuedAt>>;

const livePath = (q: Queued) => `${q.f.path}/actions/runs/${q.runId}/jobs/${q.jobId}/logs/live`;

const ticketCall = (q: Queued) =>
  json<{ ticket: string; code?: string; retry_after?: number; retry_at?: number }>(
    api("POST", livePath(q), q.f.owner.token),
  );

const ticketsOf = (runId: string) =>
  inRun(runId, (r) =>
    r.engine.rows<{
      hash: string;
      read_bytes: number | null;
      read_gets: number | null;
      read_checks: number | null;
    }>("SELECT hash, read_bytes, read_gets, read_checks FROM ci_log_tickets ORDER BY hash"),
  );

const receiptsOf = async (runId: string) =>
  (
    await env.DIRECTORY.prepare(
      `SELECT key, kind, account_id, first_day, last_day, fixed, state
       FROM ci_budget_receipts WHERE key LIKE ? ORDER BY key`,
    )
      .bind(`${runId}/%`)
      .all<{
        key: string;
        kind: string;
        account_id: string;
        first_day: number;
        last_day: number;
        fixed: string;
        state: string;
      }>()
  ).results;

const dayRow = (day: number) =>
  env.DIRECTORY.prepare("SELECT * FROM ci_budget_days WHERE day = ?")
    .bind(day)
    .first<Record<string, number>>();

const NOTHING_STORED = { chunks: 0, rereadBytes: 0, reads: 0 };
/** A viewer's budget on Free and its price, from what is stored and how long rows may flow. */
function viewer(activeMs: number) {
  const budget = ciViewerBudget({ stored: NOTHING_STORED, activeMs });
  return { ...budget, price: ciViewerPrice(budget) };
}
/**
 * A queued job's viewer on Free: nothing stored, and rows may flow while the
 * job may run (Free's longest job, 180 minutes) and its late window.
 */
const emptyLog = viewer((180 + 10) * MIN);

describe("a live log ticket on Free", () => {
  it("is granted from the ledger as a viewer, priced from its log at issuance (none yet), charged on each day of its life", async () => {
    const t = freshNoon();
    const q = await queuedAt(t);
    const issued = await ticketCall(q);
    expect(issued.status).toBe(200);
    const hash = await ticketHash(issued.body.ticket);
    expect(await ticketsOf(q.runId)).toEqual([
      {
        hash,
        read_bytes: emptyLog.readBytes,
        read_gets: emptyLog.getAttempts,
        read_checks: emptyLog.checks,
      },
    ]);
    const day = Math.floor(t / DAY);
    expect(await receiptsOf(q.runId)).toEqual([
      {
        key: `${q.runId}/viewer/${hash}`,
        kind: "viewer",
        account_id: q.f.org.id,
        first_day: day,
        last_day: day + 1,
        fixed: JSON.stringify(emptyLog.price.fixed),
        state: "granted",
      },
    ]);
    for (const d of [day, day + 1]) {
      const row = await dayRow(d);
      expect(row?.do_requests).toBe(emptyLog.price.fixed.do_requests);
      expect(row?.viewer_do_requests).toBe(emptyLog.price.fixed.do_requests);
      expect(row?.viewer_r2_class_b).toBe(emptyLog.getAttempts);
    }
    expect(await dayRow(day + 2)).toBeNull();
  });

  it("is charged on all three UTC days its life touches when issued just before midnight", async () => {
    const t = freshNoon() + 12 * HOUR - 15_000;
    const q = await queuedAt(t);
    const issued = await ticketCall(q);
    expect(issued.status).toBe(200);
    const day = Math.floor(t / DAY);
    expect(await receiptsOf(q.runId)).toMatchObject([{ first_day: day, last_day: day + 2 }]);
    for (const d of [day, day + 1, day + 2])
      expect((await dayRow(d))?.viewer_do_requests).toBe(emptyLog.price.fixed.do_requests);
  });

  it("is refused once viewers' quarter is spent, though jobs still fit, until the next UTC midnight, and deleted", async () => {
    const t = freshNoon();
    const q = await queuedAt(t);
    // Viewers' quarter fits one ticket's Durable Object requests, not two.
    ciVariableOverrides.FYRDEN_CI_DAILY = `do_requests=${6 * emptyLog.price.fixed.do_requests}`;
    const first = await ticketCall(q);
    expect(first.status).toBe(200);
    const refused = await ticketCall(q);
    expect(refused.status).toBe(429);
    const midnight = (Math.floor(t / DAY) + 1) * DAY;
    expect(refused.body).toMatchObject({
      code: "log_viewers_spent",
      retry_after: (midnight - t) / 1000,
      retry_at: midnight,
    });
    expect(await ticketsOf(q.runId)).toEqual([
      expect.objectContaining({ hash: await ticketHash(first.body.ticket) }),
    ]);
    expect(await receiptsOf(q.runId)).toHaveLength(1);
    const ci = ciEnv(env);
    const job = await grantCi(
      env.DIRECTORY,
      {
        key: uniqueId("job"),
        kind: "job",
        accountId: q.f.org.id,
        validUntil: t + 30 * MIN,
        price: ciJobPrice(10),
        spanMs: 10 * MIN,
      },
      {
        allowance: ciAllowance(ci) ?? expect.fail("Free has an allowance"),
        fleetCap: ciFleetCap(ci),
      },
    );
    expect(job).toMatchObject({ status: "granted" });
  });

  it("answers 503 and deletes the ticket when the ledger cannot answer", async () => {
    const q = await queuedAt(freshNoon());
    const directory = env.DIRECTORY;
    const failing = new Proxy(directory, {
      get(target, prop) {
        if (prop === "prepare")
          return (query: string) => {
            if (query.includes("ci_budget_receipts")) throw new Error("D1 unavailable");
            return target.prepare(query);
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const ctx = createExecutionContext();
    const response = await createApp().fetch(
      new Request(`${ORIGIN}/api${livePath(q)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${q.f.owner.token}`,
          "Idempotency-Key": crypto.randomUUID(),
          "CF-Connecting-IP": "10.9.9.9",
        },
      }),
      { ...env, DIRECTORY: failing } as Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "log_viewers_unavailable" });
    expect(await ticketsOf(q.runId)).toEqual([]);
    expect(await receiptsOf(q.runId)).toEqual([]);
  });

  it("is refused, and deleted, when one viewer's price is more than viewers' quarter of a day", async () => {
    const q = await queuedAt(freshNoon());
    ciVariableOverrides.FYRDEN_CI_DAILY = `do_requests=${emptyLog.price.fixed.do_requests}`;
    const refused = await ticketCall(q);
    expect(refused.status).toBe(503);
    expect(refused.body.code).toBe("log_viewers_unavailable");
    expect(refused.body.retry_after).toBeUndefined();
    expect(await ticketsOf(q.runId)).toEqual([]);
    expect(await receiptsOf(q.runId)).toEqual([]);
  });
});

describe("a live log ticket's price on Free", () => {
  it("pays for a check a minute only while rows may flow: Free's longest job and the late window", async () => {
    const t = freshNoon();
    const q = await queuedAt(t);
    expect((await ticketCall(q)).status).toBe(200);
    const day = Math.floor(t / DAY);
    // The ticket, the upgrade and the socket's checks: a minute's for 190 minutes, not 24 hours.
    expect(emptyLog.checks - viewer(0).checks).toBe(190);
    expect((await dayRow(day))?.viewer_do_requests).toBe(2 + emptyLog.checks);
    expect((await dayRow(day + 1))?.viewer_do_requests).toBe(2 + emptyLog.checks);
  });

  it("pays only for reading back once the job completed with no log to come", async () => {
    const t = freshNoon();
    const q = await queuedAt(t);
    ciVariableOverrides.FYRDEN_PLAN = "paid";
    expect(
      (await json(api("POST", `${q.f.path}/actions/runs/${q.runId}/cancel`, q.f.owner.token)))
        .status,
    ).toBeLessThan(300);
    await drain(q.runId);
    expect(await inRun(q.runId, (r) => r.engine.instance(q.jobId)?.status)).toBe("completed");
    ciVariableOverrides.FYRDEN_PLAN = "free";
    expect((await ticketCall(q)).status).toBe(200);
    expect((await dayRow(Math.floor(t / DAY)))?.viewer_do_requests).toBe(2 + viewer(0).checks);
  });
});

describe("a live log ticket on Paid", () => {
  it("is admitted with no price and no read budget", async () => {
    const q = await queuedAt(freshNoon());
    ciVariableOverrides.FYRDEN_PLAN = "paid";
    const issued = await ticketCall(q);
    expect(issued.status).toBe(200);
    expect(await ticketsOf(q.runId)).toEqual([
      {
        hash: await ticketHash(issued.body.ticket),
        read_bytes: null,
        read_gets: null,
        read_checks: null,
      },
    ]);
    expect(await receiptsOf(q.runId)).toEqual([]);
  });
});
