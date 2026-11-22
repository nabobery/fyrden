// Each test sets D1's clock (the day); the isolate's clock is passed to the
// meter or is the test's own.

import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { afterEach, describe, expect, it } from "vitest";
import { CI_NOW, CI_POLL_BUDGET, CI_POLL_LEASE } from "../src/ci/budget.js";
import { MAINTENANCE_OBJECT } from "../src/cron/maintenance.js";
import {
  type FetchAdmission,
  freeRunnerAdmission,
  PollBlocks,
  runnerAdmissionFor,
} from "../src/runner/admission.js";
import {
  CREDENTIALS_REFUSED,
  FLEET_FULL,
  FLEET_POLLS_SPENT,
  POLLS_UNACCOUNTED,
  RUNNER_PAST_FLEET,
  RUNNER_POLLED_TOO_OFTEN,
} from "../src/runner/errors.js";
import {
  fleetRoom,
  LEASE_POLLS_SQL,
  REGISTER_RUNNER_SQL,
  stampSpentRunners,
} from "../src/runner/registry.js";
import { user, type Who } from "./helpers/api.js";
import { clockedD1, countingD1, rowCountingD1 } from "./helpers/d1.js";
import {
  decodeFetchTaskResponse,
  decodeRunnerResponse,
  encodeFetchTaskRequest,
  encodeRegisterRequest,
} from "./helpers/runner-proto.js";
import { call, connectError, newOrg, proto, runnerCall } from "./helpers/runners.js";
import { logs } from "./setup/log-capture.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const B = CI_POLL_BUDGET;

/** A UTC day (D1's) of the test's own: today's polls are counted per day. */
const testDay = (slot: number) => 60_000 + slot * 7;
const noonOf = (day: number) => day * DAY + 12 * HOUR;

type Clock = { now: number };
type Credentials = { id: number; uuid: string; token: string };

const free = (cap: number, clock: Clock, more: Record<string, unknown> = {}): Partial<Env> =>
  ({
    FYRDEN_CI_RUNNERS: "on",
    FYRDEN_CI_FLEET: String(cap),
    DIRECTORY: clockedD1(env.DIRECTORY, CI_NOW, clock),
    ...more,
  }) as Partial<Env>;

async function serving(): Promise<number> {
  return (
    (await env.DIRECTORY.prepare(
      `SELECT count(*) AS n FROM ci_runners
       WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
    )
      .bind(Date.now())
      .first<number>("n")) ?? 0
  );
}

// The cap is deployment-wide and storage is shared within the file: each
// test sets its cap from the runners serving when it starts, and leaves none.
afterEach(async () => {
  await env.DIRECTORY.prepare(
    "UPDATE ci_runners SET revoked_at = 1, revoked_reason = 'deleted' WHERE revoked_at IS NULL",
  ).run();
});

async function owned(): Promise<{ owner: Who; org: { id: string; login: string } }> {
  const owner = await user();
  return { owner, org: await newOrg(owner) };
}

function mint(org: string, owner: Who, overrides: Partial<Env>) {
  return call(
    `/api/orgs/${org}/actions/runners/registration-token`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${owner.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
    },
    overrides,
  );
}

async function token(org: string, owner: Who, overrides: Partial<Env>): Promise<string> {
  const res = await mint(org, owner, overrides);
  expect(res.status).toBe(201);
  return (await res.json<{ token: string }>()).token;
}

function registerCall(registration: string, overrides: Partial<Env>) {
  return runnerCall(
    "Register",
    encodeRegisterRequest({
      name: uniqueId("runner"),
      token: registration,
      agentLabels: [],
      customLabels: [],
      version: "v6.0.0",
      labels: ["ubuntu-latest"],
      ephemeral: false,
      capabilities: [],
    }),
    { overrides },
  );
}

async function register(registration: string, overrides: Partial<Env>): Promise<Credentials> {
  const { runner } = decodeRunnerResponse(await proto(await registerCall(registration, overrides)));
  if (!runner) throw new Error("no runner in the answer");
  return { id: runner.id, uuid: runner.uuid, token: runner.token };
}

const poll = (runner: Credentials, overrides: Partial<Env>) =>
  runnerCall("FetchTask", encodeFetchTaskRequest({ tasksVersion: 0 }), {
    credentials: runner,
    overrides,
  });

async function polled(runner: Credentials, overrides: Partial<Env>) {
  return decodeFetchTaskResponse(await proto(await poll(runner, overrides)));
}

function remove(org: string, owner: Who, id: number, overrides: Partial<Env>) {
  return call(
    `/api/orgs/${org}/actions/runners/${id}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${owner.token}`, "Idempotency-Key": crypto.randomUUID() },
    },
    overrides,
  );
}

async function listed(org: string, owner: Who, overrides: Partial<Env>) {
  const res = await call(
    `/api/orgs/${org}/actions/runners`,
    { method: "GET", headers: { Authorization: `Bearer ${owner.token}` } },
    overrides,
  );
  expect(res.status).toBe(200);
  return (await res.json<{ runners: { id: number; revoked_reason: string | null }[] }>()).runners;
}

interface MeterRow {
  poll_day: number;
  poll_used: number;
  revoked_at: number | null;
  revoked_reason: string | null;
}

const meterOf = (id: number) =>
  env.DIRECTORY.prepare(
    "SELECT poll_day, poll_used, revoked_at, revoked_reason FROM ci_runners WHERE id = ?",
  )
    .bind(id)
    .first<MeterRow>();

async function runnerRow(more: { expiresAt?: number | null; revokedAt?: number | null } = {}) {
  const row = await env.DIRECTORY.prepare(
    `INSERT INTO ci_runners (uuid, account_id, token_hash, name, ephemeral, created_at, revoked_at, expires_at)
     VALUES (?, ?, 'hash', 'runner', ?, 1, ?, ?) RETURNING id`,
  )
    .bind(
      uniqueId("runner"),
      uniqueId("acct"),
      more.expiresAt == null ? 0 : 1,
      more.revokedAt ?? null,
      more.expiresAt ?? null,
    )
    .first<{ id: number }>();
  return row?.id as number;
}

describe("the fleet's cap", () => {
  it("refuses a Register past the cap, and its token registers once a runner is deleted", async () => {
    const clock = { now: noonOf(testDay(1)) };
    const cap = (await serving()) + 1;
    const on = free(cap, clock);
    const { owner, org } = await owned();
    const spare = await token(org.login, owner, on);
    const first = await register(await token(org.login, owner, on), on);

    const refused = await registerCall(spare, on);
    expect(await connectError(refused, "resource_exhausted", 429)).toBe(FLEET_FULL);
    const minted = await mint(org.login, owner, on);
    expect(minted.status).toBe(409);
    expect((await minted.json<{ code: string }>()).code).toBe("runner_fleet_full");

    // The first never polled, so it leaves no polls behind.
    expect((await remove(org.login, owner, first.id, on)).status).toBe(204);
    const second = await register(spare, on);
    expect(second.id).toBeGreaterThan(first.id);
    expect(
      await connectError(await registerCall(spare, free(cap + 1, clock)), "permission_denied", 403),
    ).toMatch(/registration token is not valid/);
  });

  it("inserts exactly one runner when two Registers race for the last slot", async () => {
    const clock = { now: noonOf(testDay(2)) };
    const cap = (await serving()) + 1;
    const on = free(cap, clock);
    const { owner, org } = await owned();
    const tokens = [await token(org.login, owner, on), await token(org.login, owner, on)];
    const answers = await Promise.all(tokens.map((t) => registerCall(t, on)));
    expect(answers.map((r) => r.status).sort()).toEqual([200, 429]);
    expect(await serving()).toBe(cap);
  });

  it("after a delete, refuses a Register while today's polls of runners gone leave no slot, until the day turns", async () => {
    const day = testDay(3);
    const clock = { now: noonOf(day) };
    const cap = (await serving()) + 1;
    const on = free(cap, clock);
    const { owner, org } = await owned();
    const spare = await token(org.login, owner, on);
    const first = await register(await token(org.login, owner, on), on);
    await polled(first, on);
    expect((await remove(org.login, owner, first.id, on)).status).toBe(204);

    const refused = await registerCall(spare, on);
    expect(await connectError(refused, "resource_exhausted", 429)).toBe(FLEET_POLLS_SPENT);
    const minted = await mint(org.login, owner, on);
    expect(minted.status).toBe(409);
    expect(await minted.json<{ code: string; detail: string }>()).toMatchObject({
      code: "runner_fleet_full",
      detail: expect.stringMatching(/00:00 UTC/),
    });

    clock.now = (day + 1) * DAY + 1;
    expect((await register(spare, on)).id).toBeGreaterThan(first.id);
  });

  it("counts a deleted runner's whole leased block, though it served one poll of it", async () => {
    const day = testDay(4);
    const clock = { now: noonOf(day) };
    const cap = (await serving()) + 1;
    const on = free(cap, clock);
    const { owner, org } = await owned();
    const runner = await register(await token(org.login, owner, on), on);
    await polled(runner, on);
    expect((await remove(org.login, owner, runner.id, on)).status).toBe(204);
    expect(await meterOf(runner.id)).toMatchObject({
      poll_day: day,
      poll_used: CI_POLL_LEASE,
      revoked_reason: "deleted",
    });
    const db = clockedD1(env.DIRECTORY, CI_NOW, clock);
    expect(await fleetRoom(db, { cap, pollBudget: B }, Date.now())).toBe("polls_spent");
    // One more slot holds a runner's budget: room again.
    expect(await fleetRoom(db, { cap: cap + 1, pollBudget: B }, Date.now())).toBe("room");
  });

  it("counts the polls of an ephemeral runner past its end before the cron stamps it", async () => {
    const day = testDay(5);
    const clock = { now: noonOf(day) };
    const now = Date.now();
    const id = await runnerRow({ expiresAt: now - 1 });
    await env.DIRECTORY.prepare("UPDATE ci_runners SET poll_day = ?, poll_used = 60 WHERE id = ?")
      .bind(day, id)
      .run();
    const cap = (await serving()) + 1;
    const db = clockedD1(env.DIRECTORY, CI_NOW, clock);
    expect(await fleetRoom(db, { cap, pollBudget: B }, now)).toBe("polls_spent");
  });

  it("counts the runners that may serve as ranges of their index, in registration's own statement", async () => {
    const { results } = await env.DIRECTORY.prepare(`EXPLAIN QUERY PLAN ${REGISTER_RUNNER_SQL}`)
      .bind(...Array.from({ length: parameters(REGISTER_RUNNER_SQL) }, () => 1))
      .all<{ detail: string }>();
    const plan = results.map((r) => r.detail).join("\n");
    expect(plan).toMatch(/USING (COVERING )?INDEX ci_runners_live \(expires_at=\?\)/);
    expect(plan).toMatch(/USING (COVERING )?INDEX ci_runners_live \(expires_at>\?\)/);
    expect(plan).not.toMatch(/SCAN ci_runners\b/);
  });
});

const parameters = (sql: string) =>
  Math.max(...Array.from(sql.matchAll(/\?(\d+)/g), (m) => Number(m[1])));

async function drive(
  admission: { onFetch(runner: { id: number }, now: number): Promise<FetchAdmission> },
  id: number,
  clock: Clock,
  polls: number,
  gapMs: number,
): Promise<FetchAdmission[]> {
  const answers: FetchAdmission[] = [];
  for (let i = 0; i < polls; i++) {
    answers.push(await admission.onFetch({ id }, clock.now));
    clock.now += gapMs;
  }
  return answers;
}

describe("the poll meter", () => {
  it("serves a default day (17,280 polls) with one lease a block and no write from a held block", async () => {
    const day = testDay(10);
    const d1 = { now: noonOf(day) };
    const worker = { now: day * DAY };
    const count = { queries: 0 };
    const db = countingD1(clockedD1(env.DIRECTORY, CI_NOW, d1), count);
    const admission = freeRunnerAdmission(db, { cap: 1_000, pollBudget: B }, new PollBlocks());
    const id = await runnerRow();

    expect(await admission.onFetch({ id }, worker.now)).toBe("ok");
    expect(count.queries).toBe(1);
    const held = await drive(admission, id, worker, CI_POLL_LEASE - 1, 5_000);
    expect(held.every((a) => a === "ok")).toBe(true);
    expect(count.queries).toBe(1);

    const rest = await drive(admission, id, worker, 17_280 - CI_POLL_LEASE, 5_000);
    expect(rest.every((a) => a === "ok")).toBe(true);
    expect(count.queries).toBe(17_280 / CI_POLL_LEASE);
    expect(await meterOf(id)).toMatchObject({ poll_used: 17_280, revoked_at: null });
  });

  it.each([
    ["60, 60, 12", [60, 60, 12]],
    ["12, 60, 60", [12, 60, 60]],
    ["60, 12, 60", [60, 12, 60]],
  ])("revokes intermittent fast polling (%s a minute) at the budget", async (_name, pattern) => {
    const day = testDay(11);
    const db = clockedD1(env.DIRECTORY, CI_NOW, { now: noonOf(day) });
    const admission = freeRunnerAdmission(db, { cap: 1_000, pollBudget: B }, new PollBlocks());
    const id = await runnerRow();
    const worker = { now: day * DAY };
    let served = 0;
    let last: FetchAdmission = "ok";
    for (let minute = 0; last === "ok"; minute++) {
      const perMinute = pattern[minute % pattern.length] as number;
      for (let i = 0; i < perMinute && last === "ok"; i++) {
        last = await admission.onFetch({ id }, worker.now + (i * 60_000) / perMinute);
        if (last === "ok") served++;
      }
      worker.now += 60_000;
    }
    expect(last).toBe("poll_rate");
    expect(served).toBe(B);
    expect(await meterOf(id)).toMatchObject({ poll_used: B, revoked_reason: "poll_rate" });
  });

  it("adds up the blocks two isolates lease for one runner", async () => {
    const day = testDay(12);
    const db = clockedD1(env.DIRECTORY, CI_NOW, { now: noonOf(day) });
    const fleet = { cap: 1_000, pollBudget: 4 * CI_POLL_LEASE };
    const isolates = [new PollBlocks(), new PollBlocks()].map((blocks) =>
      freeRunnerAdmission(db, fleet, blocks),
    );
    const id = await runnerRow();
    const now = day * DAY;
    const answers: FetchAdmission[] = [];
    for (let i = 0; i < 2 * CI_POLL_LEASE; i++)
      answers.push(await (isolates[i % 2] as (typeof isolates)[0]).onFetch({ id }, now + i));
    expect(answers.every((a) => a === "ok")).toBe(true);
    expect((await meterOf(id))?.poll_used).toBe(2 * CI_POLL_LEASE);
    // Two more blocks, one each, and the fifth lease passes the budget.
    for (let i = 0; i < 2 * CI_POLL_LEASE; i++)
      answers.push(await (isolates[i % 2] as (typeof isolates)[0]).onFetch({ id }, now + i));
    expect(answers.every((a) => a === "ok")).toBe(true);
    expect((await meterOf(id))?.poll_used).toBe(4 * CI_POLL_LEASE);
    expect(await (isolates[0] as (typeof isolates)[0]).onFetch({ id }, now)).toBe("poll_rate");
    expect(await meterOf(id)).toMatchObject({
      poll_used: fleet.pollBudget,
      revoked_reason: "poll_rate",
    });
    expect(await (isolates[1] as (typeof isolates)[0]).onFetch({ id }, now)).toBe("gone");
  });

  it("serves every poll of two blocks leased at once for one runner in one isolate", async () => {
    const day = testDay(15);
    const count = { queries: 0 };
    const db = countingD1(clockedD1(env.DIRECTORY, CI_NOW, { now: noonOf(day) }), count);
    const admission = freeRunnerAdmission(db, { cap: 1_000, pollBudget: B }, new PollBlocks());
    const id = await runnerRow();
    const now = noonOf(day);
    // Both polls miss the isolate's block before either lease answers: two leases.
    expect(
      await Promise.all([admission.onFetch({ id }, now), admission.onFetch({ id }, now)]),
    ).toEqual(["ok", "ok"]);
    expect(count.queries).toBe(2);
    for (let i = 0; i < 2 * CI_POLL_LEASE - 2; i++)
      expect(await admission.onFetch({ id }, now + i)).toBe("ok");
    expect(count.queries).toBe(2);
    expect(await meterOf(id)).toMatchObject({ poll_used: 2 * CI_POLL_LEASE });
  });

  it("discards a block when the day turns, and holds none for a day the isolate has left", async () => {
    const day = testDay(13);
    const d1 = { now: (day + 1) * DAY - 1_000 };
    const count = { queries: 0 };
    const db = countingD1(clockedD1(env.DIRECTORY, CI_NOW, d1), count);
    const blocks = new PollBlocks();
    const admission = freeRunnerAdmission(db, { cap: 1_000, pollBudget: B }, blocks);
    const id = await runnerRow();
    const lastSecond = (day + 1) * DAY - 1_000;
    const midnight = (day + 1) * DAY;

    // Leased before midnight: the next poll after it leases again, on the new day's count.
    expect(await admission.onFetch({ id }, lastSecond)).toBe("ok");
    expect(await meterOf(id)).toMatchObject({ poll_day: day, poll_used: CI_POLL_LEASE });
    d1.now = midnight + 1;
    expect(await admission.onFetch({ id }, midnight + 1)).toBe("ok");
    expect(count.queries).toBe(2);
    expect(await meterOf(id)).toMatchObject({ poll_day: day + 1, poll_used: CI_POLL_LEASE });

    // A block is held for the isolate's day at lease time: one leased for the day the isolate
    // has already left serves only its own poll (D1 charged its own day either way).
    const late = await runnerRow();
    expect(await admission.onFetch({ id: late }, lastSecond)).toBe("ok");
    expect(await admission.onFetch({ id: late }, midnight + 2)).toBe("ok");
    expect(count.queries).toBe(4);
    expect(await meterOf(late)).toMatchObject({ poll_day: day + 1, poll_used: 2 * CI_POLL_LEASE });

    expect(blocks.size).toBe(2);
    await admission.onFetch({ id }, midnight + DAY);
    expect(blocks.size).toBe(1);
  });

  it("revokes the runner ranked past a lowered cap at its next lease, and the oldest keep serving", async () => {
    const day = testDay(14);
    const clock = { now: noonOf(day) };
    const roomy = free((await serving()) + 10, clock);
    const { owner, org } = await owned();
    const older = await register(await token(org.login, owner, roomy), roomy);
    const newer = await register(await token(org.login, owner, roomy), roomy);
    // The cap now leaves out only the newer of the two.
    const lowered = free((await serving()) - 1, clock);

    expect(await connectError(await poll(newer, lowered), "unauthenticated", 401)).toBe(
      RUNNER_PAST_FLEET,
    );
    expect(await meterOf(newer.id)).toMatchObject({ revoked_reason: "fleet_cap", poll_used: 0 });
    expect(await connectError(await poll(newer, lowered), "unauthenticated", 401)).toBe(
      CREDENTIALS_REFUSED,
    );
    expect(await polled(older, lowered)).toEqual({ tasksVersion: 0 });
    expect(await meterOf(older.id)).toMatchObject({ revoked_at: null, poll_used: CI_POLL_LEASE });
    expect((await listed(org.login, owner, lowered)).map((r) => r.revoked_reason)).toEqual([
      null,
      "fleet_cap",
    ]);
  });

  it("ranks a runner over the runners that may serve, never expired history", async () => {
    const now = Date.now();
    // Expired ephemeral runners, not yet stamped by the cron.
    await env.DIRECTORY.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
       INSERT INTO ci_runners (uuid, account_id, token_hash, name, ephemeral, created_at, expires_at)
       SELECT ?1 || i, 'history', 'hash', 'runner', 1, 1, ?2 FROM n`,
    )
      .bind(uniqueId("expired"), now - DAY)
      .run();
    try {
      const id = await runnerRow();
      const { results } = await env.DIRECTORY.prepare(`EXPLAIN QUERY PLAN ${LEASE_POLLS_SQL}`)
        .bind(id, now, 1_000, CI_POLL_LEASE, B, ...Array(parameters(LEASE_POLLS_SQL) - 5).fill(1))
        .all<{ detail: string }>();
      const plan = results.map((r) => r.detail).join("\n");
      expect(plan).toMatch(/USING (COVERING )?INDEX ci_runners_live \(expires_at=\? AND id<\?\)/);
      expect(plan).toMatch(/USING (COVERING )?INDEX ci_runners_live \(expires_at>\?\)/);
      expect(plan).not.toMatch(/SCAN ci_runners\b/);

      const rows = { read: 0, written: 0 };
      const db = rowCountingD1(
        clockedD1(env.DIRECTORY, CI_NOW, { now: noonOf(testDay(15)) }),
        rows,
      );
      const admission = freeRunnerAdmission(db, { cap: 1_000, pollBudget: B }, new PollBlocks());
      expect(await admission.onFetch({ id }, now)).toBe("ok");
      expect(rows.read).toBeLessThan(100);
    } finally {
      await env.DIRECTORY.prepare(
        "UPDATE ci_runners SET revoked_at = expires_at, revoked_reason = 'spent' WHERE account_id = 'history'",
      ).run();
    }
  });
});

describe("a FetchTask on Free", () => {
  it("leases until the budget would pass, then answers the revoking poll and refuses the next", async () => {
    const day = testDay(20);
    const clock = { now: noonOf(day) };
    const on = free((await serving()) + 1, clock);
    const { owner, org } = await owned();
    const runner = await register(await token(org.login, owner, on), on);
    await env.DIRECTORY.prepare("UPDATE ci_runners SET poll_day = ?, poll_used = ? WHERE id = ?")
      .bind(day, B - CI_POLL_LEASE, runner.id)
      .run();
    for (let i = 0; i < CI_POLL_LEASE; i++) await polled(runner, on);
    expect(await meterOf(runner.id)).toMatchObject({ poll_used: B, revoked_at: null });

    expect(await connectError(await poll(runner, on), "unauthenticated", 401)).toBe(
      RUNNER_POLLED_TOO_OFTEN,
    );
    expect(await meterOf(runner.id)).toMatchObject({ poll_used: B, revoked_reason: "poll_rate" });
    expect(await connectError(await poll(runner, on), "unauthenticated", 401)).toBe(
      CREDENTIALS_REFUSED,
    );
    expect(await listed(org.login, owner, on)).toMatchObject([
      { id: runner.id, revoked_reason: "poll_rate" },
    ]);
  });

  it("answers a lease that failed to commit with a restart, and revokes nothing", async () => {
    const day = testDay(21);
    const clock = { now: noonOf(day) };
    const on = free((await serving()) + 1, clock);
    const { owner, org } = await owned();
    const runner = await register(await token(org.login, owner, on), on);
    const directory = on.DIRECTORY as D1Database;
    const failing = new Proxy(directory, {
      get(target, prop) {
        if (prop === "prepare")
          return (query: string) => {
            if (query.includes("poll_used")) throw new Error("D1 is unavailable");
            return target.prepare(query);
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;

    expect(
      await connectError(await poll(runner, { ...on, DIRECTORY: failing }), "unauthenticated", 401),
    ).toBe(POLLS_UNACCOUNTED);
    const warned = logs
      .entries()
      .filter((e) => e.level === "warn" && e.msg === "runner poll lease failed");
    expect(warned).toEqual([
      expect.objectContaining({ runnerId: runner.id, error: "D1 is unavailable" }),
    ]);
    expect(logs.lines.some((line) => line.includes(runner.token))).toBe(false);
    expect(await meterOf(runner.id)).toMatchObject({ poll_used: 0, revoked_at: null });
    expect(await polled(runner, on)).toEqual({ tasksVersion: 0 });
    expect(await meterOf(runner.id)).toMatchObject({ poll_used: CI_POLL_LEASE });
  });

  it("is metered while the switch is off", async () => {
    const clock = { now: noonOf(testDay(22)) };
    const on = free((await serving()) + 1, clock);
    const { owner, org } = await owned();
    const runner = await register(await token(org.login, owner, on), on);
    const off = { ...on, FYRDEN_CI_RUNNERS: undefined } as unknown as Partial<Env>;
    expect(await polled(runner, off)).toEqual({ tasksVersion: 0 });
    expect(await meterOf(runner.id)).toMatchObject({ poll_used: CI_POLL_LEASE });
  });
});

describe("Paid", () => {
  it("leases nothing and caps no fleet", async () => {
    const clock = { now: noonOf(testDay(30)) };
    const paid = free(0, clock, { FYRDEN_PLAN: "paid" });
    expect(runnerAdmissionFor(paid as Env).fleet).toBeNull();
    const { owner, org } = await owned();
    const runners = [
      await register(await token(org.login, owner, paid), paid),
      await register(await token(org.login, owner, paid), paid),
    ];
    for (const runner of runners) {
      expect(await polled(runner, paid)).toEqual({ tasksVersion: 0 });
      expect(await meterOf(runner.id)).toMatchObject({ poll_used: 0, revoked_at: null });
    }
  });
});

describe("revocation reasons", () => {
  it("an owner's delete is 'deleted', and keeps an earlier revocation's time and reason", async () => {
    const clock = { now: noonOf(testDay(40)) };
    const on = free((await serving()) + 2, clock);
    const { owner, org } = await owned();
    const deleted = await register(await token(org.login, owner, on), on);
    const capped = await register(await token(org.login, owner, on), on);
    await env.DIRECTORY.prepare(
      "UPDATE ci_runners SET revoked_at = 5, revoked_reason = 'fleet_cap' WHERE id = ?",
    )
      .bind(capped.id)
      .run();
    expect((await remove(org.login, owner, deleted.id, on)).status).toBe(204);
    expect((await remove(org.login, owner, capped.id, on)).status).toBe(204);
    expect(await meterOf(capped.id)).toMatchObject({ revoked_at: 5, revoked_reason: "fleet_cap" });
    expect(await listed(org.login, owner, on)).toMatchObject([
      { id: deleted.id, revoked_reason: "deleted" },
      { id: capped.id, revoked_reason: "fleet_cap" },
    ]);
  });

  it("the cron stamps ephemeral runners past their end as spent, a page at a time", async () => {
    // Far in the past, so they come first in expiry order.
    const ids = [await runnerRow({ expiresAt: 7 }), await runnerRow({ expiresAt: 8 })];
    const live = await runnerRow({ expiresAt: Date.now() + DAY });
    expect(await stampSpentRunners(env.DIRECTORY, Date.now(), 1)).toBe(1);
    expect(await meterOf(ids[0] as number)).toMatchObject({
      revoked_at: 7,
      revoked_reason: "spent",
    });
    expect(await meterOf(ids[1] as number)).toMatchObject({ revoked_at: null });

    const maintenance = env.MAINTENANCE.getByName(MAINTENANCE_OBJECT);
    for (let run = 0; run < 5 && (await meterOf(ids[1] as number))?.revoked_at === null; run++)
      await maintenance.run();
    expect(await meterOf(ids[1] as number)).toMatchObject({
      revoked_at: 8,
      revoked_reason: "spent",
    });
    expect(await meterOf(live)).toMatchObject({ revoked_at: null });
  });
});
