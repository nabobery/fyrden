// Why a live grant was refused: the ledger's one list of gates decides it and
// names it, each gate closed in turn here. The name travels upward (funding,
// an owned run, an opening) and reaches the wire: a 4412's close reason, a
// live_temporary problem's `reason`, through the MCP bridge too.

import {
  createExecutionContext,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  countedD1,
  createMetrics,
  type Metrics,
  measureInvocation,
} from "@fyrden/adapters-cloudflare/obs";
import { uniqueId } from "@fyrden/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { UserDO } from "../src/do/UserDO.js";
import { DISCRETIONARY_RESOURCES } from "../src/effects/discretionary.js";
import {
  LIVE_DAILY,
  LIVE_ESCROW_ENTRIES,
  LIVE_ORDINARY_DEBT_LIMIT,
  LIVE_PROTECTED,
  LIVE_RECEIPTS_OVERDUE,
  type LiveGrantPlan,
  liveReceiptDeadlines,
  makeLiveGrant,
  reserveLive,
} from "../src/live/budget.js";
import { fund, liveTarget, ownedCall, ownedRun, planFor } from "../src/live/funding.js";
import { LIVE_PRICES, type LiveManifestEntry } from "../src/live/manifest.js";
import { LIVE_OWNER_LIMITS } from "../src/live/owners.js";
import { ListenStream, workerClock } from "../src/mcp/listen.js";
import { user, type Who } from "./helpers/api.js";
import { clockedD1, DAY, isolated, plan, testDay, vector, ZERO } from "./helpers/live-budget.js";
import { holdAlarms } from "./setup/hold-alarms.js";

const R = DISCRETIONARY_RESOURCES.filter((r) => r !== "queue_ops");

function at(day: number, ms = DAY / 2) {
  const clock = { now: day * DAY + ms };
  return { clock, db: clockedD1(env.DIRECTORY, clock) };
}

/** What a refused grant of `planned` answers. */
async function refusalOf(db: D1Database, planned: LiveGrantPlan) {
  const result = await reserveLive(db, await makeLiveGrant(planned));
  expect(result.status).toBe("refused");
  return result as Extract<typeof result, { status: "refused" }>;
}

const held = (day: number, ms = 10) => ({
  day,
  resources: vector({ do_duration_ms: ms }),
  duration: { day, from: day * DAY, until: day * DAY + DAY / 2 + 60_000, ms },
});

describe("a refused grant", () => {
  it("names validity, before it starts and past its end", () =>
    isolated(async () => {
      const day = testDay(0);
      const { db, clock } = at(day);
      expect(await refusalOf(db, await plan({ day, from: clock.now + 1_000 }))).toMatchObject({
        reason: "temporary",
        gate: "validity",
      });
      expect(await refusalOf(db, await plan({ day, from: clock.now - 120_000 }))).toMatchObject({
        reason: "expired",
        gate: "validity",
      });
    }));

  it("names first_day when its first charge is not today's", () =>
    isolated(async () => {
      const day = testDay(1);
      const { db, clock } = at(day, 30_000);
      const charge = (d: number) => ({
        day: d,
        resources: vector({ do_requests: 1 }),
        duration: null,
      });
      expect(
        await refusalOf(
          db,
          await plan({
            day: day - 1,
            from: clock.now - 60_000,
            validMs: 120_000,
            charges: [charge(day - 1), charge(day)],
          }),
        ),
      ).toMatchObject({ reason: "temporary", gate: "first_day" });
    }));

  it("names the day's total and the ordinary share as daily refusals", () =>
    isolated(async () => {
      const day = testDay(2);
      const { db } = at(day);
      expect(
        await refusalOf(
          db,
          await plan({
            day,
            class: "cleanup",
            kind: "maintenance",
            resources: vector({ do_requests: LIVE_DAILY.do_requests + 1 }),
          }),
        ),
      ).toEqual({
        status: "refused",
        reason: "daily",
        retryAt: (day + 1) * DAY,
        gate: "daily_total",
      });
      expect(
        await refusalOf(
          db,
          await plan({
            day,
            resources: vector({
              do_requests: LIVE_DAILY.do_requests - LIVE_PROTECTED.do_requests + 1,
            }),
          }),
        ),
      ).toEqual({
        status: "refused",
        reason: "daily",
        retryAt: (day + 1) * DAY,
        gate: "ordinary_share",
      });
    }));

  it("names second_day when only a later day's charge does not fit", () =>
    isolated(async () => {
      const day = testDay(3);
      const { db } = at(day);
      expect(
        await refusalOf(
          db,
          await plan({
            day,
            charges: [
              { day, resources: vector({ do_requests: 1 }), duration: null },
              {
                day: day + 1,
                resources: vector({ do_requests: LIVE_DAILY.do_requests + 1 }),
                duration: null,
              },
            ],
          }),
        ),
      ).toMatchObject({ reason: "temporary", gate: "second_day" });
    }));

  it("names duration_closed while ordinary duration is blocked", () =>
    isolated(async () => {
      const day = testDay(4);
      const { db } = at(day);
      await env.DIRECTORY.prepare(
        "UPDATE live_budget_state SET ordinary_duration_blocked = 1 WHERE id = 1",
      ).run();
      expect(await refusalOf(db, await plan({ day, charges: [held(day)] }))).toMatchObject({
        reason: "temporary",
        gate: "duration_closed",
      });
    }));

  it("names escrow_full with the day's places taken", () =>
    isolated(async () => {
      const day = testDay(5);
      const { db } = at(day);
      const cleanup = { class: "cleanup", kind: "maintenance" } as const;
      expect(
        (await reserveLive(db, await makeLiveGrant(await plan({ day, ...cleanup })))).status,
      ).toBe("granted");
      await env.DIRECTORY.prepare("UPDATE live_budget_days SET escrow = ? WHERE day = ?")
        .bind(JSON.stringify(Array.from({ length: LIVE_ESCROW_ENTRIES }, (_, i) => ({ i }))), day)
        .run();
      expect(
        await refusalOf(db, await plan({ day, ...cleanup, charges: [held(day)] })),
      ).toMatchObject({ reason: "temporary", gate: "escrow_full" });
    }));

  it("names the resource whose debt is at its limit", () =>
    isolated(async () => {
      const day = testDay(6);
      const { db } = at(day);
      for (const r of R) {
        await env.DIRECTORY.prepare(`UPDATE live_budget_state SET debt_${r} = ? WHERE id = 1`)
          .bind(LIVE_ORDINARY_DEBT_LIMIT[r])
          .run();
        expect(
          await refusalOf(db, await plan({ day, directoryCleanupDebt: vector({ [r]: 1 }) })),
        ).toMatchObject({ reason: "temporary", gate: `debt:${r}` });
        await env.DIRECTORY.prepare(
          `UPDATE live_budget_state SET debt_${r} = 0 WHERE id = 1`,
        ).run();
      }
    }));

  it("names a turn's debt after what it retires", () =>
    isolated(async () => {
      const day = testDay(7);
      const { db } = at(day);
      await env.DIRECTORY.prepare(
        "UPDATE live_budget_state SET debt_d1_rows_written = ? WHERE id = 1",
      )
        .bind(LIVE_ORDINARY_DEBT_LIMIT.d1_rows_written)
        .run();
      expect(
        await refusalOf(
          db,
          await plan({
            day,
            kind: "pump",
            producesLocal: true,
            recipient: `usr_${uniqueId("turn")}`,
            directoryCleanupDebt: vector({ d1_rows_written: 1 }),
          }),
        ),
      ).toMatchObject({ reason: "temporary", gate: "debt:d1_rows_written" });
    }));

  it("names overdue_receipts once expired receipts call for cleanup", () =>
    isolated(async () => {
      const day = testDay(8);
      const { db, clock } = at(day);
      const first = await plan({ day });
      expect((await reserveLive(db, await makeLiveGrant(first))).status).toBe("granted");
      clock.now = liveReceiptDeadlines(first).expiresAt + LIVE_RECEIPTS_OVERDUE.graceMs;
      const now = Math.floor(clock.now / DAY);
      expect(await refusalOf(db, await plan({ day: now, from: clock.now }))).toMatchObject({
        reason: "temporary",
        gate: "overdue_receipts",
      });
    }));

  it("names old_days with a retired day left past its keeping", () =>
    isolated(async () => {
      const day = testDay(9);
      const { db } = at(day);
      await env.DIRECTORY.prepare(
        "INSERT INTO live_budget_days (day, retain_until, cleanup_debt) VALUES (?, 0, ?)",
      )
        .bind(day - 8, JSON.stringify(ZERO))
        .run();
      expect(await refusalOf(db, await plan({ day }))).toMatchObject({
        reason: "temporary",
        gate: "old_days",
      });
    }));

  it("names epoch and target_incarnation, which say nothing of the ledger's room", () =>
    isolated(async () => {
      const day = testDay(10);
      const { db } = at(day);
      expect(await refusalOf(db, await plan({ day, epoch: 5 }))).toMatchObject({
        reason: "fenced",
        gate: "epoch",
      });
      expect(await refusalOf(db, await plan({ day, incarnation: "0".repeat(32) }))).toMatchObject({
        reason: "fenced",
        gate: "target_incarnation",
      });
      const feed = `usr_${uniqueId("target")}`;
      await env.DIRECTORY.prepare(
        `INSERT INTO live_recovery_targets (feed, incarnation, through_seq, next_attempt_at, attempts,
           local_cleanup_debt, turn_debt) VALUES (?, ?, 1, 0, 0, ?, 0)`,
      )
        .bind(feed, "0".repeat(32), JSON.stringify(ZERO))
        .run();
      expect(
        await refusalOf(db, await plan({ day, recipient: feed, producesLocal: true })),
      ).toMatchObject({ reason: "temporary", gate: "target_incarnation" });
    }));

  it("names unknown for an answer lost", () =>
    isolated(async () => {
      const day = testDay(11);
      const { db } = at(day);
      const lossy = new Proxy(db, {
        get(target, prop) {
          if (prop === "batch") return () => Promise.reject(new Error("lost"));
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      expect(await refusalOf(lossy, await plan({ day }))).toEqual({
        status: "refused",
        reason: "temporary",
        gate: "unknown",
      });
    }));

  it("is counted by kind and gate; a grant is not", () =>
    isolated(async () => {
      const day = testDay(12);
      const { db } = at(day);
      const points: { name: string; dimensions: Record<string, string>; value: number }[] = [];
      const metrics: Metrics = {
        count: (name, dimensions, value = 1) => {
          points.push({ name, dimensions: dimensions as Record<string, string>, value });
        },
      };
      expect(
        (await reserveLive(db, await makeLiveGrant(await plan({ day })), metrics)).status,
      ).toBe("granted");
      expect(points).toEqual([]);
      await reserveLive(db, await makeLiveGrant(await plan({ day, epoch: 5 })), metrics);
      expect(points).toEqual([
        { name: "live.grant_refusal", dimensions: { unit: "pump", gate: "epoch" }, value: 1 },
      ]);
    }));
});

/** A grant of a real turn's price for a new feed, with the ledger's clock its run is timed on. */
async function funded(db: D1Database) {
  const recipient = `usr_${uniqueId("owned")}`;
  const target = await liveTarget(db, recipient);
  const result = await fund(
    db,
    await makeLiveGrant(
      planFor(
        LIVE_PRICES.pump as LiveManifestEntry,
        {
          incarnation: target.incarnation,
          epoch: target.epoch,
          recipientType: "UserDO",
          recipient,
          class: "ordinary",
          kind: "pump",
          producesLocal: true,
        },
        target.ledger.now,
      ),
    ),
  );
  if (result.status !== "funded") throw new Error(`not funded: ${result.gate}`);
  return { envelope: result.value, ledger: target.ledger };
}

describe("an owned run refused", () => {
  const db = env.DIRECTORY;
  const work = async () => "ran";
  const refused = (gate: string) => ({ status: "refused", reason: "temporary", gate });

  /**
   * `envelope`'s run given up on: its call reached (a signal, not a wait), then its pending bound
   * passed by moving the timers, which only this helper fakes.
   */
  async function givenUp({ envelope, ledger }: Awaited<ReturnType<typeof funded>>) {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(now);
    const pendingMs = 1_000;
    let reached!: () => void;
    const called = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const run = ownedRun(
      db,
      envelope,
      "test",
      () => {
        reached();
        return new Promise<string>(() => {});
      },
      { ledger, pendingMs },
    );
    await called;
    vi.advanceTimersByTime(pendingMs);
    const result = await run;
    holdAlarms();
    return result;
  }

  /** `db`, doing `before` first when asked for its `n`th batch. */
  const beforeBatch = (n: number, before: () => Promise<unknown>) => {
    let batches = 0;
    return new Proxy(db, {
      get(target, prop) {
        if (prop === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (++batches === n) await before();
            return target.batch(statements);
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };

  it("names why its dispatch could not be recorded", () =>
    isolated(async () => {
      // An owned run's batches: its owner's admission, then its dispatch.
      const DISPATCH = 2;
      const setBlocked = (to: number) =>
        db
          .prepare("UPDATE live_budget_state SET ordinary_duration_blocked = ? WHERE id = 1")
          .bind(to)
          .run();
      const blocked = await funded(db);
      expect(
        await ownedRun(
          beforeBatch(DISPATCH, () => setBlocked(1)),
          blocked.envelope,
          "test",
          work,
          {
            ledger: blocked.ledger,
          },
        ),
      ).toEqual(refused("owner:blocked"));
      await setBlocked(0);
      const already = await funded(db);
      expect(
        await ownedRun(
          beforeBatch(DISPATCH, () =>
            db
              .prepare(
                "UPDATE live_duration_owners SET status = 'dispatched', instance = 'i', started_at = ? WHERE operation_id = ?",
              )
              .bind(already.ledger.now, already.envelope.operationId)
              .run(),
          ),
          already.envelope,
          "test",
          work,
          { ledger: already.ledger },
        ),
      ).toEqual(refused("conflict"));
      const missing = await funded(db);
      expect(
        await ownedRun(
          beforeBatch(DISPATCH, () =>
            db
              .prepare("DELETE FROM live_duration_owners WHERE operation_id = ?")
              .bind(missing.envelope.operationId)
              .run(),
          ),
          missing.envelope,
          "test",
          work,
          { ledger: missing.ledger },
        ),
      ).toEqual(refused("owner:unfunded"));
      // Timed past its dispatch window by the ledger's clock.
      const late = await funded(db);
      expect(
        await ownedRun(db, late.envelope, "test", work, {
          ledger: { ...late.ledger, now: late.envelope.plan.validUntil },
        }),
      ).toEqual(refused("validity"));
    }));

  it("names its owner's capacity, a block on duration, and funding that went", () =>
    isolated(async () => {
      // One owner left dispatched, holding the deployment's one place.
      await givenUp(await funded(db));
      const full = await funded(db);
      expect(
        await ownedRun(db, full.envelope, "test", work, {
          ledger: full.ledger,
          limits: {
            ...LIVE_OWNER_LIMITS,
            deploymentTotal: 1,
            deploymentOrdinary: 1,
            deploymentCleanup: 0,
          },
        }),
      ).toEqual(refused("owner:capacity"));
      const blocked = await funded(db);
      const setBlocked = (to: number) =>
        db
          .prepare("UPDATE live_budget_state SET ordinary_duration_blocked = ? WHERE id = 1")
          .bind(to)
          .run();
      await setBlocked(1);
      expect(
        await ownedRun(db, blocked.envelope, "test", work, { ledger: blocked.ledger }),
      ).toEqual(refused("owner:blocked"));
      await setBlocked(0);
      const gone = await funded(db);
      await db
        .prepare("DELETE FROM live_budget_receipts WHERE operation_id = ?")
        .bind(gone.envelope.operationId)
        .run();
      expect(await ownedRun(db, gone.envelope, "test", work, { ledger: gone.ledger })).toEqual(
        refused("owner:unfunded"),
      );
    }));

  it("names a second run of one grant as a conflict", () =>
    isolated(async () => {
      const given = await funded(db);
      // Left dispatched by a call given up on: its owner still holds the grant.
      await givenUp(given);
      expect(await ownedRun(db, given.envelope, "test", work, { ledger: given.ledger })).toEqual(
        refused("conflict"),
      );
    }));

  it("names a call given up on, and one that failed", () =>
    isolated(async () => {
      expect(await givenUp(await funded(db))).toEqual(refused("given_up"));
      const failing = await funded(db);
      expect(
        await ownedRun(db, failing.envelope, "test", () => Promise.reject(new Error("no")), {
          ledger: failing.ledger,
        }),
      ).toEqual(refused("unknown"));
    }));

  it("carries a refused grant's gate through an owned call", () =>
    isolated(async () => {
      const { envelope } = await funded(db);
      expect(
        await ownedCall(db, await makeLiveGrant({ ...envelope.plan, epoch: 5 }), "test", work),
      ).toEqual(refused("epoch"));
    }));
});

describe("on the wire", () => {
  const LIVE = { FYRDEN_LIVE: "on", FYRDEN_LIVE_SOCKETS: "500" };
  const ORIGIN = "https://fyrden.test";

  afterEach(async () => {
    await env.DIRECTORY.batch([
      env.DIRECTORY.prepare("DELETE FROM live_socket_deps"),
      env.DIRECTORY.prepare("DELETE FROM live_sockets"),
      // Left behind, a later test's day far ahead would find these receipts overdue.
      env.DIRECTORY.prepare("DELETE FROM live_budget_receipts"),
      env.DIRECTORY.prepare("DELETE FROM live_recovery_targets"),
      env.DIRECTORY.prepare("DELETE FROM live_duration_owners"),
      env.DIRECTORY.prepare("DELETE FROM live_budget_days"),
      env.DIRECTORY.prepare(
        `UPDATE live_budget_state SET ${DISCRETIONARY_RESOURCES.map((r) => `debt_${r} = 0`).join(", ")} WHERE id = 1`,
      ),
    ]);
  });

  async function call(request: Request, vars: Record<string, string> = LIVE): Promise<Response> {
    const ctx = createExecutionContext();
    const response = await createApp().fetch(request, { ...env, ...vars } as unknown as Env, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }
  const ticket = (who: Who, vars?: Record<string, string>) =>
    call(
      new Request(`${ORIGIN}/api/notifications/live`, {
        method: "POST",
        headers: { Authorization: `Bearer ${who.token}`, "Idempotency-Key": crypto.randomUUID() },
      }),
      vars,
    );
  const upgrade = (who: Who, issued: string, vars?: Record<string, string>) =>
    call(
      new Request(`${ORIGIN}/api/notifications/live?ticket=${encodeURIComponent(issued)}`, {
        headers: { Upgrade: "websocket", Authorization: `Bearer ${who.token}` },
      }),
      vars,
    );
  const closeOf = (response: Response) => {
    const ws = response.webSocket as WebSocket;
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.addEventListener("close", (e) => resolve({ code: e.code, reason: e.reason })),
    );
    ws.accept();
    return closed;
  };
  const closeDebtGate = () =>
    env.DIRECTORY.prepare("UPDATE live_budget_state SET debt_d1_rows_written = ? WHERE id = 1")
      .bind(LIVE_ORDINARY_DEBT_LIMIT.d1_rows_written)
      .run();

  it("gives a refused ticket its reason", async () => {
    const who = await user();
    await closeDebtGate();
    const response = await ticket(who);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "live_temporary",
      retry_after: 60,
      reason: "debt:d1_rows_written",
    });
  });

  it("gives a refused listen its reason", async () => {
    const who = await user();
    await closeDebtGate();
    const response = await call(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${who.token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "subscriptions/listen",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "listen-1",
          method: "subscriptions/listen",
          params: {
            notifications: { resourceSubscriptions: [`fyrden://feed/${who.principalId}`] },
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": { name: "fyrden-test", version: "0.0.0" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      }),
    );
    expect(await response.json()).toMatchObject({
      error: { data: { code: "live_temporary", reason: "debt:d1_rows_written" } },
    });
  });

  it("closes a refused upgrade 4412 with why: the ledger's gate", async () => {
    const who = await user();
    const issued = (await (await ticket(who)).json()) as { ticket: string };
    await closeDebtGate();
    expect(await closeOf(await upgrade(who, issued.ticket))).toEqual({
      code: 4412,
      reason: "try again soon: debt:d1_rows_written",
    });
  });

  it("closes a refused upgrade 4412 with why: no room in the deployment", async () => {
    const who = await user();
    const issued = (await (await ticket(who)).json()) as { ticket: string };
    await env.DIRECTORY.prepare(
      `INSERT INTO live_sockets (socket_id, ticket_id, feed, credential_id, state, pending_until,
         expires_at) VALUES (?, ?, 'usr_x', 'tok_x', 'open', 0, ?)`,
    )
      .bind(uniqueId("lsk"), uniqueId("t"), Date.now() + 60_000)
      .run();
    expect(
      await closeOf(await upgrade(who, issued.ticket, { ...LIVE, FYRDEN_LIVE_SOCKETS: "1" })),
    ).toEqual({ code: 4412, reason: "try again soon: allowance" });
  });

  describe("measured as a whole attempt", () => {
    type Point = { name: string; blobs: string[]; value: number };

    /** `fn` run as one Worker invocation over a counted directory; the metrics it wrote. */
    async function measured(fn: () => Promise<unknown>) {
      const dataset = env.METRICS as unknown as { writeDataPoint: (point: unknown) => void };
      const write = dataset.writeDataPoint;
      const points: Point[] = [];
      dataset.writeDataPoint = (point: unknown) => {
        const p = point as { indexes?: string[]; blobs?: string[]; doubles?: number[] };
        points.push({
          name: p.indexes?.[0] ?? "",
          blobs: p.blobs ?? [],
          value: p.doubles?.[0] ?? 0,
        });
        write.call(dataset, point);
      };
      try {
        await measureInvocation(createMetrics(env.METRICS), { where: "worker", op: "test" }, fn);
      } finally {
        dataset.writeDataPoint = write;
      }
      const named = (name: string) => points.filter((p) => p.name === name);
      return {
        attempts: named("live.refusal").map((p) => [p.blobs[0], p.blobs[1], p.value]),
        grants: named("live.grant_refusal").map((p) => [p.blobs[0], p.blobs[1], p.value]),
        rows: named("live.refused_rows").map((p) => [p.blobs[0], p.value]),
        whole: named("d1.invocation_rows").find((p) => p.blobs[2] === "read")?.value ?? 0,
      };
    }

    const COUNTED = { DIRECTORY: countedD1(env.DIRECTORY) } as unknown as Record<string, string>;
    const on = { ...LIVE, ...COUNTED };
    const listenRequest = (who: Who) =>
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${who.token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "subscriptions/listen",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "listen-1",
          method: "subscriptions/listen",
          params: {
            notifications: { resourceSubscriptions: [`fyrden://feed/${who.principalId}`] },
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": { name: "fyrden-test", version: "0.0.0" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
    const fillDeployment = () =>
      env.DIRECTORY.prepare(
        `INSERT INTO live_sockets (socket_id, ticket_id, feed, credential_id, state, pending_until,
           expires_at) VALUES (?, ?, 'usr_x', 'tok_x', 'open', 0, ?)`,
      )
        .bind(uniqueId("lsk"), uniqueId("t"), Date.now() + 60_000)
        .run();

    it("counts a refused listen once, with every row it read", async () => {
      const who = await user();
      await closeDebtGate();
      const seen = await measured(async () => (await call(listenRequest(who), on)).text());
      const gate = "debt:d1_rows_written";
      expect(seen.attempts).toEqual([["listen", gate, 1]]);
      // Refused from what the ledger shows, before any grant.
      expect(seen.grants).toEqual([]);
      // Authentication, the credential and the ledger's target too, not only the refused batch.
      expect(seen.whole).toBeGreaterThan(0);
      expect(seen.rows).toEqual([["listen", seen.whole]]);
    });

    it("counts a listen the isolate remembers as refused, with the rows it still read", async () => {
      const who = await user();
      await closeDebtGate();
      await (await call(listenRequest(who), on)).text();
      const seen = await measured(async () => (await call(listenRequest(who), on)).text());
      expect(seen.attempts).toEqual([["listen", "debt:d1_rows_written", 1]]);
      expect(seen.grants).toEqual([]);
      expect(seen.rows).toEqual([["listen", seen.whole]]);
    });

    it("counts a refused ticket once", async () => {
      const who = await user();
      await closeDebtGate();
      const seen = await measured(async () => (await ticket(who, on)).text());
      expect(seen.attempts).toEqual([["ticket", "debt:d1_rows_written", 1]]);
      // All but the row the operation's idempotency key reads once the refusal is its answer.
      expect(seen.rows).toEqual([["ticket", seen.whole - 1]]);
    });

    it("counts an opening its grants paid for but the deployment had no room for", async () => {
      const who = await user();
      await fillDeployment();
      const seen = await measured(async () =>
        (await call(listenRequest(who), { ...on, FYRDEN_LIVE_SOCKETS: "1" })).text(),
      );
      expect(seen.grants).toEqual([]);
      expect(seen.attempts).toEqual([["listen", "allowance", 1]]);
    });

    it("counts a refused upgrade once, after its transport's accounting", async () => {
      const who = await user();
      const issued = (await (await ticket(who)).json()) as { ticket: string };
      await fillDeployment();
      let response: Response | undefined;
      const seen = await measured(async () => {
        response = await upgrade(who, issued.ticket, { ...on, FYRDEN_LIVE_SOCKETS: "1" });
      });
      await closeOf(response as Response);
      expect(seen.attempts).toEqual([["upgrade", "allowance", 1]]);
      expect(seen.rows).toEqual([["upgrade", seen.whole]]);
    });

    it("counts no opening that succeeded", async () => {
      const who = await user();
      const abort = new AbortController();
      const seen = await measured(async () => {
        const opened = await call(new Request(listenRequest(who), { signal: abort.signal }), on);
        abort.abort();
        await opened.body?.cancel();
      });
      expect(seen.attempts).toEqual([]);
      expect(seen.rows).toEqual([]);
    });

    it("counts a feed's turn refused its owner", async () => {
      const who = await user();
      const issued = (await (await ticket(who)).json()) as { ticket: string };
      const response = await upgrade(who, issued.ticket);
      const ws = response.webSocket as WebSocket;
      ws.accept();
      await env.DIRECTORY.prepare(
        "UPDATE live_budget_state SET ordinary_duration_blocked = 1 WHERE id = 1",
      ).run();
      const feed = env.USER.getByName(who.principalId);
      try {
        // Its first turn brought due now, rather than a minute on.
        await runInDurableObject(feed, (_: UserDO, state) => {
          state.storage.sql.exec("UPDATE live_turn SET intended_at = 0");
          return state.storage.setAlarm(Date.now());
        });
        const seen = await measured(() => runDurableObjectAlarm(feed));
        expect(seen.grants).toContainEqual(["pump", "owner:blocked", 1]);
      } finally {
        await env.DIRECTORY.prepare(
          "UPDATE live_budget_state SET ordinary_duration_blocked = 0 WHERE id = 1",
        ).run();
        ws.close(1000, "done");
      }
    });
  });

  it("carries a socket's reason through the MCP bridge", async () => {
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    client.accept();
    server.accept();
    const stream = new ListenStream({
      id: "listen-1",
      serverInfo: { name: "fyrden", version: "0" },
      requestId: "req",
      feed: { uri: "fyrden://feed/usr_x", socket: client, deadline: Date.now() + 60_000 },
      clock: workerClock,
    });
    const reader = stream.readable.getReader();
    server.close(4412, "try again soon: owner:capacity");
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as { error?: { data?: unknown } })
      .find((message) => message.error);
    expect(data?.error?.data).toMatchObject({ code: "live_temporary", reason: "owner:capacity" });
  });
});
