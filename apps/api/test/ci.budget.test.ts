import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import {
  CI_FREE_DAILY,
  CI_LOG_READS_DAILY,
  CI_NOW,
  CI_POLL_BUDGET,
  CI_RESOURCES,
  CI_VIEWER_SHARE,
  type CiGrantRequest,
  type CiPrice,
  type CiVector,
  ciAllowance,
  ciFleetCap,
  ciJobPrice,
  ciPollBudget,
  ciViewerBudget,
  ciViewerPrice,
  fleetReservation,
  grantCi,
  pruneCiBudget,
  releaseCi,
  settleCi,
} from "../src/ci/budget.js";
import { MAINTENANCE_OBJECT } from "../src/cron/maintenance.js";
import { discretionaryAllowance, FREE_DAILY } from "../src/effects/discretionary.js";
import { LIVE_DAILY } from "../src/live/budget.js";
import { REGISTER_RUNNER_SQL } from "../src/runner/registry.js";

const DAY = 86_400_000;
const MINUTE = 60_000;

/** `db` with D1's clock at `clock.now` (milliseconds) in every ledger statement. */
function clocked(db: D1Database, clock: { now: number }): D1Database {
  const rewrite = (query: string) => query.split(CI_NOW).join(`(${clock.now})`);
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (query: string) => target.prepare(rewrite(query));
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

/** A UTC day of the test's own (days are shared by the file's tests). */
const testDay = (slot: number) => 50_000 + slot * 9;

const zero = (): Record<string, number> => Object.fromEntries(CI_RESOURCES.map((r) => [r, 0]));
const vector = (v: Partial<CiVector> = {}): CiVector => ({ ...zero(), ...v }) as CiVector;
const roomy = (v: Partial<CiVector> = {}): CiVector =>
  ({ ...Object.fromEntries(CI_RESOURCES.map((r) => [r, 1_000_000_000])), ...v }) as CiVector;

const limits = (allowance: CiVector = roomy(), fleetCap: number | null = null) => ({
  allowance,
  fleetCap,
});

function request(over: Partial<CiGrantRequest> & { now: number }): CiGrantRequest {
  const { now, ...rest } = over;
  return {
    key: uniqueId("run/j1/r"),
    kind: "job",
    accountId: uniqueId("acct"),
    validUntil: now + 10 * MINUTE,
    price: {
      fixed: vector({ do_requests: 4 }),
      perMinute: vector({ worker_requests: 45 }),
      minutes: 10,
    },
    spanMs: 10 * MINUTE,
    ...rest,
  };
}

async function dayRow(day: number): Promise<Record<string, number> | null> {
  return env.DIRECTORY.prepare("SELECT * FROM ci_budget_days WHERE day = ?")
    .bind(day)
    .first<Record<string, number>>();
}

async function receipt(key: string): Promise<Record<string, unknown> | null> {
  return env.DIRECTORY.prepare("SELECT * FROM ci_budget_receipts WHERE key = ?")
    .bind(key)
    .first<Record<string, unknown>>();
}

describe("a CI grant", () => {
  it("over midnight charges both days, and settlement refunds by the minutes run in each", async () => {
    const day = testDay(0);
    const clock = { now: day * DAY + 23 * 60 * MINUTE + 30 * MINUTE };
    const db = clocked(env.DIRECTORY, clock);
    const price = ciJobPrice(180);
    const charge = (minutes: number) =>
      Object.fromEntries(
        CI_RESOURCES.map((r) => [r, price.fixed[r] + price.perMinute[r] * minutes]),
      );
    const req = request({ now: clock.now, price, spanMs: 180 * MINUTE });
    const granted = await grantCi(db, req, limits(ciAllowance({}) as CiVector));
    expect(granted).toEqual({ status: "granted", replay: false, firstDay: day, lastDay: day + 1 });
    expect(await dayRow(day)).toMatchObject(charge(180));
    expect(await dayRow(day + 1)).toMatchObject(charge(180));
    expect((await dayRow(day))?.worker_requests).toBe(8_100);
    expect((await dayRow(day))?.do_duration_ms).toBe(10_800_000 + price.fixed.do_duration_ms);

    clock.now += 120 * MINUTE;
    const startedAt = day * DAY + 23 * 60 * MINUTE + 30 * MINUTE;
    expect(await settleCi(db, req.key, { startedAt, endedAt: startedAt + 120 * MINUTE })).toBe(
      "settled",
    );
    expect(await dayRow(day)).toMatchObject(charge(30));
    expect(await dayRow(day + 1)).toMatchObject(charge(90));
    expect(await settleCi(db, req.key, { startedAt, endedAt: startedAt + 120 * MINUTE })).toBe(
      "duplicate",
    );
    expect(await dayRow(day + 1)).toMatchObject(charge(90));
  });

  it("clamps a settlement's times to its span", async () => {
    const day = testDay(1);
    const clock = { now: day * DAY + 10 * 60 * MINUTE };
    const db = clocked(env.DIRECTORY, clock);
    const req = request({ now: clock.now });
    await grantCi(db, req, limits());
    expect(
      await settleCi(db, req.key, {
        startedAt: clock.now - 60 * MINUTE,
        endedAt: clock.now + 70 * MINUTE,
      }),
    ).toBe("settled");
    expect(await dayRow(day)).toMatchObject({ do_requests: 4, worker_requests: 450 });
  });

  it("is charged once for a key, whether retried or its answer lost", async () => {
    const day = testDay(2);
    const clock = { now: day * DAY + 12 * 60 * MINUTE };
    const db = clocked(env.DIRECTORY, clock);
    const req = request({ now: clock.now });
    expect((await grantCi(db, req, limits())).status).toBe("granted");
    const once = await dayRow(day);
    expect(once).toMatchObject({ do_requests: 4, worker_requests: 450 });
    expect(await grantCi(db, req, limits())).toEqual({
      status: "granted",
      replay: true,
      firstDay: day,
      lastDay: day,
    });
    expect(await dayRow(day)).toEqual(once);

    // The batch commits and its answer is lost: the retry gets the receipt back.
    const lost = request({ now: clock.now });
    const losing = new Proxy(db, {
      get(target, prop) {
        if (prop === "batch")
          return async (statements: D1PreparedStatement[]) => {
            await target.batch(statements);
            throw new Error("network connection lost");
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    await expect(grantCi(losing, lost, limits())).rejects.toThrow(/connection lost/);
    expect(await grantCi(db, lost, limits())).toMatchObject({ status: "granted", replay: true });
    expect(await dayRow(day)).toMatchObject({ do_requests: 8, worker_requests: 900 });
  });

  it("refused for the day writes nothing and says when the day turns", async () => {
    const day = testDay(3);
    const clock = { now: day * DAY + 12 * 60 * MINUTE };
    const db = clocked(env.DIRECTORY, clock);
    const allowance = roomy({ worker_requests: 800 });
    expect((await grantCi(db, request({ now: clock.now }), limits(allowance))).status).toBe(
      "granted",
    );
    const before = await dayRow(day);
    const refused = request({ now: clock.now });
    expect(await grantCi(db, refused, limits(allowance))).toEqual({
      status: "refused",
      reason: "daily",
      retryAt: (day + 1) * DAY,
    });
    expect(await receipt(refused.key)).toBeNull();
    expect(await dayRow(day)).toEqual(before);
    clock.now += DAY;
    expect(await grantCi(db, refused, limits(allowance))).toEqual({
      status: "expired",
    });
    expect((await grantCi(db, request({ now: clock.now }), limits(allowance))).status).toBe(
      "granted",
    );
  });

  it("refused when the second day of its span is full, writing nothing on the first", async () => {
    const day = testDay(4);
    const clock = { now: (day + 1) * DAY + 12 * 60 * MINUTE };
    const db = clocked(env.DIRECTORY, clock);
    const allowance = roomy({ worker_requests: 500 });
    expect((await grantCi(db, request({ now: clock.now }), limits(allowance))).status).toBe(
      "granted",
    );
    clock.now = day * DAY + 23 * 60 * MINUTE + 55 * MINUTE;
    const req = request({ now: clock.now });
    expect(await grantCi(db, req, limits(allowance))).toMatchObject({
      status: "refused",
      reason: "daily",
    });
    expect(await dayRow(day)).toBeNull();
    expect(await receipt(req.key)).toBeNull();
  });

  it("too large for the allowance can never fit and writes nothing", async () => {
    const day = testDay(5);
    const clock = { now: day * DAY + 12 * 60 * MINUTE };
    const db = clocked(env.DIRECTORY, clock);
    const req = request({ now: clock.now });
    expect(await grantCi(db, req, limits(roomy({ worker_requests: 449 })))).toEqual({
      status: "refused",
      reason: "too_large",
    });
    expect(await receipt(req.key)).toBeNull();
    expect(await dayRow(day)).toBeNull();
    const earlier = request({ now: clock.now });
    await grantCi(db, earlier, limits());
    expect(await grantCi(db, earlier, limits(roomy({ worker_requests: 1 })))).toMatchObject({
      status: "granted",
      replay: true,
    });
    const late = request({ now: clock.now - 10 * MINUTE });
    expect(await grantCi(db, late, limits(roomy({ worker_requests: 1 })))).toEqual({
      status: "expired",
    });
  });

  it("refuses an unreadable request before reaching the ledger", async () => {
    const now = testDay(5) * DAY;
    const db = clocked(env.DIRECTORY, { now });
    for (const bad of [
      request({ now, spanMs: 0 }),
      request({ now, spanMs: 9 * DAY }),
      request({ now, key: "" }),
      request({ now, price: { ...ciJobPrice(1), minutes: -1 } }),
      request({ now, price: { ...ciJobPrice(1), fixed: vector({ do_requests: 1.5 }) } }),
    ])
      await expect(grantCi(db, bad, limits())).rejects.toThrow(RangeError);
  });

  it("keeps the fixed part on release, and the key then answers released", async () => {
    const day = testDay(6);
    const clock = { now: day * DAY + 12 * 60 * MINUTE };
    const db = clocked(env.DIRECTORY, clock);
    const req = request({ now: clock.now });
    await grantCi(db, req, limits());
    expect(await releaseCi(db, req.key, req.validUntil)).toBe("released");
    expect(await dayRow(day)).toMatchObject({ do_requests: 4, worker_requests: 0 });
    expect(await releaseCi(db, req.key, req.validUntil)).toBe("released");
    expect(await dayRow(day)).toMatchObject({ do_requests: 4, worker_requests: 0 });
    expect(await grantCi(db, req, limits())).toEqual({ status: "released" });
    expect(await settleCi(db, req.key, { startedAt: clock.now, endedAt: clock.now })).toBe(
      "released",
    );
    expect(await dayRow(day)).toMatchObject({ do_requests: 4, worker_requests: 0 });
  });

  it("released before it was granted leaves a tombstone: the grant then answers released", async () => {
    const day = testDay(7);
    const clock = { now: day * DAY + 12 * 60 * MINUTE };
    const db = clocked(env.DIRECTORY, clock);
    const req = request({ now: clock.now });
    expect(await releaseCi(db, req.key, req.validUntil)).toBe("released");
    expect(await receipt(req.key)).toMatchObject({ state: "released", kind: null });
    expect(await grantCi(db, req, limits())).toEqual({ status: "released" });
    expect(await dayRow(day)).toBeNull();
    // Without its validity, a tombstone lasts as long as any validity may.
    const bare = request({ now: clock.now });
    expect(await releaseCi(db, bare.key)).toBe("released");
    expect(await grantCi(db, bare, limits())).toEqual({ status: "released" });
  });

  it("does not release a settled grant", async () => {
    const day = testDay(8);
    const clock = { now: day * DAY + 12 * 60 * MINUTE };
    const db = clocked(env.DIRECTORY, clock);
    const req = request({ now: clock.now });
    await grantCi(db, req, limits());
    await settleCi(db, req.key, { startedAt: clock.now, endedAt: clock.now + 5 * MINUTE });
    expect(await releaseCi(db, req.key, req.validUntil)).toBe("settled");
    expect(await dayRow(day)).toMatchObject({ do_requests: 4, worker_requests: 225 });
  });

  it("retried at or after its validity is expired, before and after its receipt is pruned", async () => {
    const day = testDay(9);
    const clock = { now: day * DAY + 12 * 60 * MINUTE };
    const db = clocked(env.DIRECTORY, clock);
    // Asked at its validity's end.
    const late = request({ now: clock.now - 10 * MINUTE });
    expect(await grantCi(db, late, limits())).toEqual({ status: "expired" });
    expect(await receipt(late.key)).toBeNull();

    const req = request({ now: clock.now });
    await grantCi(db, req, limits());
    const charged = await dayRow(day);
    expect(charged).toMatchObject({ do_requests: 4, worker_requests: 450 });
    clock.now = req.validUntil;
    expect(await grantCi(db, req, limits())).toEqual({ status: "expired" });
    expect(await dayRow(day)).toEqual(charged);
    clock.now = (day + 5) * DAY;
    while ((await pruneCiBudget(db)).receipts > 0);
    expect(await receipt(req.key)).toBeNull();
    expect(await dayRow(day)).toBeNull();
    expect(await grantCi(db, req, limits())).toEqual({ status: "expired" });
    expect(await receipt(req.key)).toBeNull();
    expect(await dayRow(day)).toBeNull();
  });

  it("refuses a validity longer than the ledger keeps tombstones", async () => {
    const day = testDay(10);
    const clock = { now: day * DAY + 12 * 60 * MINUTE };
    const db = clocked(env.DIRECTORY, clock);
    const req = request({ now: clock.now, validUntil: clock.now + DAY });
    expect(await grantCi(db, req, limits())).toEqual({ status: "refused", reason: "invalid" });
    expect(await receipt(req.key)).toBeNull();
  });

  it("is refused while the fleet is over its cap, counting only runners that may serve", async () => {
    const day = testDay(11);
    const clock = { now: day * DAY + 12 * 60 * MINUTE };
    const db = clocked(env.DIRECTORY, clock);
    const account = uniqueId("acct");
    const runner = (revokedAt: number | null, expiresAt: number | null) =>
      env.DIRECTORY.prepare(
        `INSERT INTO ci_runners (uuid, account_id, token_hash, name, ephemeral, created_at, revoked_at, expires_at)
         VALUES (?, ?, 'hash', 'runner', ?, 1, ?, ?)`,
      ).bind(uniqueId("runner"), account, expiresAt === null ? 0 : 1, revokedAt, expiresAt);
    await env.DIRECTORY.batch([
      runner(null, null),
      runner(null, null),
      runner(null, clock.now + MINUTE),
      // Neither serves: one revoked, one past its report window.
      runner(clock.now - DAY, null),
      runner(null, clock.now),
    ]);
    try {
      const active = await env.DIRECTORY.prepare(
        `SELECT count(*) AS n FROM ci_runners
         WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
      )
        .bind(clock.now)
        .first<number>("n");
      expect(active).toBeGreaterThanOrEqual(3);
      const over = request({ now: clock.now });
      expect(await grantCi(db, over, limits(roomy(), (active as number) - 1))).toEqual({
        status: "refused",
        reason: "fleet",
        retryAt: (day + 1) * DAY,
      });
      expect(await receipt(over.key)).toBeNull();
      expect(await dayRow(day)).toBeNull();
      expect((await grantCi(db, over, limits(roomy(), active as number))).status).toBe("granted");
    } finally {
      await env.DIRECTORY.prepare(
        "UPDATE ci_runners SET revoked_at = 1, revoked_reason = 'deleted' WHERE account_id = ?",
      )
        .bind(account)
        .run();
    }
  });

  it("gives viewers together at most their share of the allowance", async () => {
    const day = testDay(12);
    const clock = { now: day * DAY + 12 * 60 * MINUTE };
    const db = clocked(env.DIRECTORY, clock);
    const allowance = roomy({ worker_requests: 400 });
    const viewer = (n: number): CiGrantRequest =>
      request({
        now: clock.now,
        kind: "viewer",
        price: { fixed: vector({ worker_requests: n }), perMinute: vector(), minutes: 0 },
      });
    expect(CI_VIEWER_SHARE).toBe(0.25);
    expect((await grantCi(db, viewer(60), limits(allowance))).status).toBe("granted");
    expect(await grantCi(db, viewer(41), limits(allowance))).toMatchObject({
      status: "refused",
      reason: "daily",
    });
    expect(await grantCi(db, viewer(101), limits(allowance))).toEqual({
      status: "refused",
      reason: "too_large",
    });
    expect((await grantCi(db, viewer(40), limits(allowance))).status).toBe("granted");
    const job = request({
      now: clock.now,
      price: { fixed: vector({ worker_requests: 300 }), perMinute: vector(), minutes: 0 },
    });
    expect((await grantCi(db, job, limits(allowance))).status).toBe("granted");
    expect(await dayRow(day)).toMatchObject({ worker_requests: 400, viewer_worker_requests: 100 });
  });
});

describe("a CI receipt", () => {
  const insertGranted = (key: string, nulled?: string) => {
    const days = { first_day: 1, last_day: 2, span_from: DAY, span_until: 2 * DAY };
    const row = { ...days, ...(nulled ? { [nulled]: null } : {}) };
    return env.DIRECTORY.prepare(
      `INSERT INTO ci_budget_receipts (key, kind, account_id, first_day, last_day, span_from,
         span_until, fixed, per_minute, minutes, mint, valid_until, expires_at, state, created_at)
       VALUES (?, 'job', ?, ?, ?, ?, ?, '{}', '{}', 0, ?, 1, 1, 'granted', 0)`,
    )
      .bind(
        key,
        uniqueId("acct"),
        row.first_day,
        row.last_day,
        row.span_from,
        row.span_until,
        uniqueId("mint"),
      )
      .run();
  };

  it("granted has every day and span bound", async () => {
    await insertGranted(uniqueId("receipt"));
    for (const column of ["first_day", "last_day", "span_from", "span_until"])
      await expect(insertGranted(uniqueId("receipt"), column), column).rejects.toThrow(
        /CHECK constraint failed/,
      );
  });
});

describe("CI grants at once", () => {
  it("with the same key charge once, and both answer the same grant", async () => {
    const day = testDay(16);
    const clock = { now: day * DAY + 12 * 60 * MINUTE };
    const db = clocked(env.DIRECTORY, clock);
    const req = request({ now: clock.now });
    const answers = await Promise.all([grantCi(db, req, limits()), grantCi(db, req, limits())]);
    for (const answer of answers)
      expect(answer).toMatchObject({ status: "granted", firstDay: day, lastDay: day });
    expect(answers.map((a) => (a.status === "granted" ? a.replay : null)).sort()).toEqual([
      false,
      true,
    ]);
    expect(await dayRow(day)).toMatchObject({ do_requests: 4, worker_requests: 450 });
  });

  it("with different keys that together exceed the day: exactly one is granted", async () => {
    const day = testDay(17);
    const clock = { now: day * DAY + 12 * 60 * MINUTE };
    const db = clocked(env.DIRECTORY, clock);
    const allowance = roomy({ worker_requests: 800 });
    const [a, b] = [request({ now: clock.now }), request({ now: clock.now })];
    const answers = await Promise.all([
      grantCi(db, a, limits(allowance)),
      grantCi(db, b, limits(allowance)),
    ]);
    expect(answers.map((x) => x.status).sort()).toEqual(["granted", "refused"]);
    expect(answers.find((x) => x.status === "refused")).toMatchObject({ reason: "daily" });
    expect(await dayRow(day)).toMatchObject({ do_requests: 4, worker_requests: 450 });
  });
});

describe("a CI grant at midnight", () => {
  it("whose span ends exactly at midnight is charged on that day only", async () => {
    const day = testDay(18);
    const clock = { now: (day + 1) * DAY - 10 * MINUTE };
    const db = clocked(env.DIRECTORY, clock);
    const req = request({ now: clock.now });
    expect(await grantCi(db, req, limits())).toMatchObject({
      status: "granted",
      firstDay: day,
      lastDay: day,
    });
    expect(await dayRow(day)).toMatchObject({ worker_requests: 450 });
    expect(await dayRow(day + 1)).toBeNull();
    expect(await settleCi(db, req.key, { startedAt: clock.now, endedAt: (day + 1) * DAY })).toBe(
      "settled",
    );
    expect(await dayRow(day)).toMatchObject({ worker_requests: 450 });
  });

  it("starting exactly at midnight is charged to the new day", async () => {
    const day = testDay(19);
    const clock = { now: (day + 1) * DAY };
    const db = clocked(env.DIRECTORY, clock);
    const req = request({ now: clock.now });
    expect(await grantCi(db, req, limits())).toMatchObject({
      status: "granted",
      firstDay: day + 1,
      lastDay: day + 1,
    });
    expect(await dayRow(day)).toBeNull();
    expect(
      await settleCi(db, req.key, { startedAt: clock.now - MINUTE, endedAt: clock.now + MINUTE }),
    ).toBe("settled");
    expect(await dayRow(day + 1)).toMatchObject({ do_requests: 4, worker_requests: 45 });
    expect(await dayRow(day)).toBeNull();
  });
});

describe("settling a CI grant by the minute", () => {
  it.each([
    [1, 1],
    [59_999, 1],
    [60_000, 1],
    [60_001, 2],
  ])("after %i ms keeps %i minutes", async (ms, minutes) => {
    const day = testDay(20) + ms;
    const clock = { now: day * DAY + 12 * 60 * MINUTE };
    const db = clocked(env.DIRECTORY, clock);
    const req = request({ now: clock.now });
    await grantCi(db, req, limits());
    expect(await settleCi(db, req.key, { startedAt: clock.now, endedAt: clock.now + ms })).toBe(
      "settled",
    );
    expect(await dayRow(day)).toMatchObject({ do_requests: 4, worker_requests: 45 * minutes });
  });
});

describe("settling a CI grant", () => {
  it("after its receipt is pruned is expired and changes nothing", async () => {
    const day = testDay(13);
    const clock = { now: day * DAY + 12 * 60 * MINUTE };
    const db = clocked(env.DIRECTORY, clock);
    const req = request({ now: clock.now });
    await grantCi(db, req, limits());
    const startedAt = clock.now;
    clock.now = (day + 2) * DAY;
    await pruneCiBudget(db);
    expect(await receipt(req.key)).toBeNull();
    const kept = await dayRow(day);
    expect(await settleCi(db, req.key, { startedAt, endedAt: startedAt + MINUTE })).toBe("expired");
    expect(await dayRow(day)).toEqual(kept);
    expect(await settleCi(db, uniqueId("never"), { startedAt, endedAt: startedAt })).toBe(
      "expired",
    );
  });
});

describe("pruning the CI ledger", () => {
  it("removes expired receipts and old days a page at a time, keeping what may still be needed", async () => {
    const day = testDay(14);
    const clock = { now: day * DAY + 12 * 60 * MINUTE };
    const db = clocked(env.DIRECTORY, clock);
    const keys = [];
    for (let i = 0; i < 3; i++) {
      const req = request({ now: clock.now });
      keys.push(req.key);
      await grantCi(db, req, limits());
    }
    // A day and a bit on: past expiry plus a day for none yet.
    clock.now = (day + 1) * DAY + 12 * 60 * MINUTE;
    await pruneCiBudget(db);
    for (const key of keys) expect(await receipt(key)).not.toBeNull();
    clock.now = (day + 2) * DAY;
    expect((await pruneCiBudget(db, { receipts: 1, days: 1 })).receipts).toBe(1);
    while ((await pruneCiBudget(db, { receipts: 1, days: 1 })).receipts > 0);
    for (const key of keys) expect(await receipt(key)).toBeNull();
    // Days within three of today are kept.
    expect(await dayRow(day)).not.toBeNull();
    clock.now = (day + 4) * DAY;
    const logDay = (d: number) =>
      db.prepare("SELECT day FROM ci_log_read_days WHERE day = ?").bind(d).first();
    await db
      .prepare("INSERT INTO ci_log_read_days (day, class_b) VALUES (?, 1), (?, 1)")
      .bind(day, day + 1)
      .run();
    while ((await pruneCiBudget(db, { receipts: 1, days: 1 })).days > 0);
    expect(await dayRow(day)).toBeNull();
    expect(await logDay(day)).toBeNull();
    expect(await logDay(day + 1)).not.toBeNull();
  });

  it("refuses a page outside its bounds", async () => {
    await expect(pruneCiBudget(env.DIRECTORY, { receipts: 0 })).rejects.toThrow(RangeError);
    await expect(pruneCiBudget(env.DIRECTORY, { days: 1_000 })).rejects.toThrow(RangeError);
  });

  it("runs in the five-minute maintenance with no watched or live work due", async () => {
    const key = uniqueId("ancient");
    await env.DIRECTORY.batch([
      env.DIRECTORY.prepare(
        `INSERT INTO ci_budget_receipts (key, state, valid_until, expires_at, created_at)
         VALUES (?, 'released', 1, 1, 1)`,
      ).bind(key),
      env.DIRECTORY.prepare("INSERT INTO ci_budget_days (day, worker_requests) VALUES (1, 5)"),
    ]);
    const maintenance = env.MAINTENANCE.getByName(MAINTENANCE_OBJECT);
    for (let run = 0; run < 5 && ((await receipt(key)) || (await dayRow(1))); run++)
      await maintenance.run();
    expect(await receipt(key)).toBeNull();
    expect(await dayRow(1)).toBeNull();
  });
});

describe("CI prices", () => {
  it("prices a job's minutes as refundable and its control work as fixed", () => {
    const price: CiPrice = ciJobPrice(180);
    expect(price.minutes).toBe(180);
    expect(price.perMinute).toMatchObject({
      worker_requests: 45,
      do_requests: 45,
      do_duration_ms: 60_000,
      do_rows_written: 10,
      do_rows_read: 100,
    });
    expect(price.fixed).toMatchObject({
      do_requests: 4,
      do_rows_written: 20,
      d1_rows_written: 90,
      d1_rows_read: 300,
      worker_requests: 0,
    });
  });

  it("budgets a log viewer from the log stored when its ticket is issued and while rows flow", () => {
    const none = { chunks: 0, rereadBytes: 0, reads: 0 };
    const small = ciViewerBudget({ stored: none, activeMs: 60 * MINUTE });
    const large = ciViewerBudget({
      stored: { chunks: 1, rereadBytes: 7 * 3 * 1024 * 1024, reads: 7 },
      activeMs: 60 * MINUTE,
    });
    expect(small.readBytes).toBe(4 * 1024 * 1024);
    expect(large.readBytes).toBe(25 * 1024 * 1024);
    expect(large.getAttempts - small.getAttempts).toBe(7 + 1);
    // Its first check, one a minute rows flow, two an attempt, and a margin.
    expect(small.checks).toBe(1 + 60 + 2 * small.getAttempts + 16);
    expect(large.checks - small.checks).toBe(2 * (7 + 1));
    const longer = ciViewerBudget({ stored: none, activeMs: 120 * MINUTE });
    expect(longer.checks - small.checks).toBe(60);
    expect(ciViewerBudget({ stored: none, activeMs: 0 }).checks).toBe(
      1 + 2 * small.getAttempts + 16,
    );
  });

  it("prices a log viewer for the budget its socket is held to", () => {
    const budget = ciViewerBudget({
      stored: { chunks: 2, rereadBytes: 3 * 1024 * 1024, reads: 5 },
      activeMs: 30 * MINUTE,
    });
    const price = ciViewerPrice(budget);
    expect(price.fixed).toMatchObject({
      worker_requests: 2,
      do_requests: 2 + budget.checks,
      do_rows_read: 10 * budget.checks,
      d1_rows_read: 5 * budget.checks,
      r2_class_b: budget.getAttempts,
    });
    expect(price.minutes).toBe(0);
    expect(ciJobPrice(180).fixed.r2_class_b + ciJobPrice(180).perMinute.r2_class_b).toBe(0);
  });

  it("gives a viewer an attempt for each read of each chunk, and one more a chunk", () => {
    const one = ciViewerBudget({
      stored: { chunks: 1, rereadBytes: 100 * 1024, reads: 1 },
      activeMs: MINUTE,
    });
    const many = ciViewerBudget({
      stored: { chunks: 100, rereadBytes: 100 * 1024, reads: 100 },
      activeMs: MINUTE,
    });
    expect(many.readBytes).toBe(one.readBytes);
    expect(many.getAttempts - one.getAttempts).toBe(2 * 99);
  });
});

describe("the CI allowance", () => {
  it("is null on Paid: nothing is granted", () => {
    expect(ciAllowance({ FYRDEN_PLAN: "paid" })).toBeNull();
    expect(ciAllowance({ FYRDEN_PLAN: "paid", FYRDEN_CI_DAILY: "worker_requests=5" })).toBeNull();
  });

  it("has Free's proposed shares when nothing is set", () => {
    expect(ciAllowance({})).toEqual({
      do_requests: 15_000,
      do_rows_read: 500_000,
      do_rows_written: 10_000,
      do_duration_ms: 20_312_500,
      d1_rows_read: 500_000,
      d1_rows_written: 10_000,
      queue_ops: 1_000,
      worker_requests: 15_000,
      r2_class_b: 32_258,
    });
    // R2's monthly 10 million Class B operations, a 31-day month's daily share.
    expect(CI_FREE_DAILY).toEqual({
      ...FREE_DAILY,
      worker_requests: 100_000,
      r2_class_b: 322_580,
    });
  });

  it("takes set values, each at most what Free leaves after the fleet, log pages, live and discretionary work", () => {
    const fleet = fleetReservation(2);
    const ceiling = (r: (typeof CI_RESOURCES)[number]) =>
      CI_FREE_DAILY[r] -
      fleet[r] -
      (r === "r2_class_b" || r === "d1_rows_read" || r === "d1_rows_written"
        ? CI_LOG_READS_DAILY
        : 0) -
      (r === "worker_requests" || r === "r2_class_b"
        ? 0
        : LIVE_DAILY[r] + (discretionaryAllowance({})?.[r] as number));
    expect(
      ciAllowance({ FYRDEN_CI_DAILY: "worker_requests=99999, do_requests=7,d1_rows_read=0" }),
    ).toMatchObject({
      worker_requests: ceiling("worker_requests"),
      do_requests: 7,
      d1_rows_read: 0,
      do_rows_written: 10_000,
    });
    expect(ciAllowance({ FYRDEN_CI_DAILY: "r2_class_b=999999999" })?.r2_class_b).toBe(
      ceiling("r2_class_b"),
    );
    expect(ciAllowance({ FYRDEN_CI_DAILY: "worker_requests=99999" })?.worker_requests).toBe(
      100_000 - 45_360,
    );
  });

  it("shrinks with the fleet's cap and with a hand-set discretionary allowance, never below zero", () => {
    expect(
      ciAllowance({ FYRDEN_CI_FLEET: "0", FYRDEN_CI_DAILY: "worker_requests=99999" })
        ?.worker_requests,
    ).toBe(99_999);
    expect(ciAllowance({ FYRDEN_CI_FLEET: "5" })?.worker_requests).toBe(0);
    expect(
      ciAllowance({ FYRDEN_DISCRETIONARY_DAILY: "queue_ops=10000", FYRDEN_CI_DAILY: "queue_ops=5" })
        ?.queue_ops,
    ).toBe(0);
  });

  it("ignores a variable it cannot read whole, as unset", () => {
    for (const bad of [
      "worker_requests=",
      "worker_requests=1e4",
      "worker_requests=-1",
      "rows=5",
      "worker_requests=5;do_requests=1",
      "worker_requests=5,worker_requests=6",
    ])
      expect(ciAllowance({ FYRDEN_CI_DAILY: bad }), bad).toEqual(ciAllowance({}));
  });

  it("reserves the fleet at its daily poll budget with slack, on Free two runners unless set", () => {
    expect(ciFleetCap({})).toBe(2);
    expect(ciFleetCap({ FYRDEN_CI_FLEET: "7" })).toBe(7);
    expect(ciFleetCap({ FYRDEN_CI_FLEET: "x" })).toBe(2);
    expect(ciFleetCap({ FYRDEN_PLAN: "paid" })).toBeNull();
    expect(ciFleetCap({ FYRDEN_PLAN: "paid", FYRDEN_CI_FLEET: "3" })).toBeNull();
    expect(CI_POLL_BUDGET).toBe(21_600);
    const two = fleetReservation(2);
    expect(two.worker_requests).toBe(45_360);
    expect(two.d1_rows_read).toBeGreaterThan(45_360);
    expect(two.d1_rows_written).toBe(2 * Math.ceil(45_360 / 60));
    expect(fleetReservation(0)).toEqual(vector());
  });

  it("takes a lower poll budget when set, never a higher one", () => {
    expect(ciPollBudget({})).toBe(CI_POLL_BUDGET);
    expect(ciPollBudget({ FYRDEN_CI_POLL_BUDGET: "120" })).toBe(120);
    expect(ciPollBudget({ FYRDEN_CI_POLL_BUDGET: "99999" })).toBe(CI_POLL_BUDGET);
    expect(ciPollBudget({ FYRDEN_CI_POLL_BUDGET: "0" })).toBe(CI_POLL_BUDGET);
    expect(ciPollBudget({ FYRDEN_CI_POLL_BUDGET: "1e3" })).toBe(CI_POLL_BUDGET);
    // Polls are leased 60 at a time.
    expect(ciPollBudget({ FYRDEN_CI_POLL_BUDGET: "59" })).toBe(CI_POLL_BUDGET);
    expect(ciPollBudget({ FYRDEN_CI_POLL_BUDGET: "60" })).toBe(60);
    expect(ciPollBudget({ FYRDEN_CI_POLL_BUDGET: "179" })).toBe(120);
  });

  it("indexes inactive runners by their poll day, for registration's sum of today's polls", async () => {
    const { results } = await env.DIRECTORY.prepare(`EXPLAIN QUERY PLAN ${REGISTER_RUNNER_SQL}`)
      .bind(...Array.from({ length: 11 }, () => 1))
      .all<{ detail: string }>();
    expect(results.map((r) => r.detail).join("\n")).toMatch(
      /USING INDEX ci_runners_polls \(poll_day=\?\)/,
    );
  });
});
