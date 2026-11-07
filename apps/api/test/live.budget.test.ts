// Live hints' ledger: grants debited atomically against their UTC days
// (D1's clock, set by the test), once per identity, within live's daily
// allowance, its protected part and the ordinary debt limit; replays of an
// identity get the first grant back; nothing is half applied.

import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import { DISCRETIONARY_RESOURCES } from "../src/effects/discretionary.js";
import {
  expireLiveReceipts,
  LIVE_DAILY,
  LIVE_ESCROW_ENTRIES,
  LIVE_ORDINARY_DEBT_LIMIT,
  LIVE_PROTECTED,
  LIVE_RECEIPTS_OVERDUE,
  type LiveDurationCompletion,
  type LiveGrantResult,
  liveReceiptDeadlines,
  makeLiveGrant,
  reserveLive,
  settleLiveDuration,
} from "../src/live/budget.js";
import {
  beginLiveDuration,
  finishLiveDuration,
  type LiveDurationGuard,
  liveLocalDeadline,
  reserveDuration,
} from "../src/live/duration.js";
import {
  clockedD1,
  DAY,
  dayRow,
  isolated,
  ledger,
  plan,
  testDay,
  vector,
  ZERO,
} from "./helpers/live-budget.js";

const R = DISCRETIONARY_RESOURCES.filter((r) => r !== "queue_ops");

/** The ledger at noon of `day` (D1's clock as the test sets it). */
function at(day: number, ms = DAY / 2) {
  const clock = { now: day * DAY + ms };
  return { clock, db: clockedD1(env.DIRECTORY, clock) };
}

const receipts = () =>
  env.DIRECTORY.prepare("SELECT count(*) AS n FROM live_budget_receipts")
    .first<{ n: number }>()
    .then((r) => r?.n ?? 0);

const granted = (r: LiveGrantResult) => r.status === "granted";

describe("the live ledger's schema", () => {
  it("refuses a vector without all seven resources, queue work, or more escrow than 64", async () => {
    const day = testDay(0);
    const bad = [
      JSON.stringify({ do_requests: 1 }),
      JSON.stringify({ ...ZERO, queue_ops: 1 }),
      JSON.stringify({ ...ZERO, do_requests: -1 }),
      JSON.stringify({ ...ZERO, do_requests: 1.5 }),
      JSON.stringify({ ...ZERO, extra: 0 }),
    ];
    for (const debt of bad)
      await expect(
        env.DIRECTORY.prepare(
          "INSERT INTO live_budget_days (day, retain_until, cleanup_debt) VALUES (?, 0, ?)",
        )
          .bind(day, debt)
          .run(),
      ).rejects.toThrow(/CHECK/);
    const escrow = JSON.stringify(Array.from({ length: 65 }, (_, i) => ({ id: `o${i}`, ms: 1 })));
    await expect(
      env.DIRECTORY.prepare(
        "INSERT INTO live_budget_days (day, retain_until, cleanup_debt, escrow) VALUES (?, 0, ?, ?)",
      )
        .bind(day, JSON.stringify(ZERO), escrow)
        .run(),
    ).rejects.toThrow(/CHECK/);
    // Protected spending is part of the total.
    await expect(
      env.DIRECTORY.prepare(
        "INSERT INTO live_budget_days (day, retain_until, cleanup_debt, protected_do_requests) VALUES (?, 0, ?, 1)",
      )
        .bind(day, JSON.stringify(ZERO))
        .run(),
    ).rejects.toThrow(/CHECK/);
    expect(await dayRow(day)).toBeNull();
  });
});

describe("a live grant", () => {
  it.each(R)("is the last one a day's %s allows: two at once, exactly one granted", async (r) => {
    await isolated(async () => {
      const day = testDay(1);
      const { db } = at(day);
      const price = LIVE_DAILY[r] - LIVE_PROTECTED[r] > 0 ? 1 : 0;
      // Ordinary duration leaves the day's reserve to cleanup too.
      const reserve =
        r === "do_duration_ms"
          ? ((
              await env.DIRECTORY.prepare(
                "SELECT duration_reserve_ms AS n FROM live_budget_state WHERE id = 1",
              ).first<{ n: number }>()
            )?.n ?? 0)
          : 0;
      // All but one of the ordinary part spent.
      const fill = await reserveLive(
        db,
        await makeLiveGrant(
          await plan({
            day,
            class: "cleanup",
            kind: "maintenance",
            resources: vector({ [r]: LIVE_DAILY[r] - LIVE_PROTECTED[r] - price - reserve }),
            ...(r === "do_duration_ms" && {
              charges: [
                {
                  day,
                  resources: vector({ [r]: LIVE_DAILY[r] - LIVE_PROTECTED[r] - price - reserve }),
                  duration: {
                    day,
                    from: day * DAY,
                    until: (day + 1) * DAY,
                    ms: LIVE_DAILY[r] - LIVE_PROTECTED[r] - price - reserve,
                  },
                },
              ],
            }),
          }),
        ),
      );
      expect(fill.status).toBe("granted");
      const one = async () =>
        reserveLive(
          db,
          await makeLiveGrant(
            await plan({
              day,
              producesLocal: true,
              recipient: "usr_last_credit",
              localCleanupDebt: vector({ do_rows_written: 1 }),
              resources: vector({ [r]: 1 }),
              ...(r === "do_duration_ms" && {
                charges: [
                  {
                    day,
                    resources: vector({ [r]: 1 }),
                    duration: { day, from: day * DAY, until: day * DAY + 1_000, ms: 1 },
                  },
                ],
              }),
            }),
          ),
        );
      // The fill was cleanup: it counts as protected spending, so ordinary room is all the part's.
      await env.DIRECTORY.prepare(`UPDATE live_budget_days SET protected_${r} = 0 WHERE day = ?`)
        .bind(day)
        .run();
      const results = await Promise.all([one(), one()]);
      expect(results.filter(granted)).toHaveLength(1);
      // Past the day's allowance: daily; ordinary duration past what leaves the reserve: temporary
      // (the reserve is cleanup's, and may yet be given back).
      expect(results.find((x) => !granted(x))).toMatchObject({
        status: "refused",
        reason: reserve > 0 ? "temporary" : "daily",
      });
      expect((await dayRow(day))?.[r]).toBe(LIVE_DAILY[r] - LIVE_PROTECTED[r] - reserve);
      expect(await receipts()).toBe(2);
      const target = await env.DIRECTORY.prepare(
        "SELECT through_seq, local_cleanup_debt FROM live_recovery_targets WHERE feed = 'usr_last_credit'",
      ).first<{ through_seq: number; local_cleanup_debt: string }>();
      expect(JSON.parse(target?.local_cleanup_debt ?? "{}").do_rows_written).toBe(1);
    });
  });

  it("refuses queue work, whatever else it asks", async () => {
    await isolated(async () => {
      const day = testDay(2);
      const { db } = at(day);
      const p = await plan({ day, resources: { ...ZERO, do_requests: 1, queue_ops: 1 } });
      expect(await reserveLive(db, await makeLiveGrant(p))).toEqual({
        status: "refused",
        reason: "invalid",
        gate: "validity",
      });
      expect(await receipts()).toBe(0);
    });
  });

  it("keeps the protected part for cleanup once ordinary work spent the rest", async () => {
    await isolated(async () => {
      const day = testDay(3);
      const { db } = at(day);
      const ordinaryPart = LIVE_DAILY.do_requests - LIVE_PROTECTED.do_requests;
      expect(
        (
          await reserveLive(
            db,
            await makeLiveGrant(
              await plan({ day, resources: vector({ do_requests: ordinaryPart }) }),
            ),
          )
        ).status,
      ).toBe("granted");
      expect(
        await reserveLive(
          db,
          await makeLiveGrant(await plan({ day, resources: vector({ do_requests: 1 }) })),
        ),
      ).toMatchObject({ status: "refused", reason: "daily" });
      const cleanup = await reserveLive(
        db,
        await makeLiveGrant(
          await plan({
            day,
            class: "cleanup",
            kind: "maintenance",
            resources: vector({ do_requests: 10 }),
          }),
        ),
      );
      expect(cleanup.status).toBe("granted");
      const row = await dayRow(day);
      expect([row?.do_requests, row?.protected_do_requests]).toEqual([ordinaryPart + 10, 10]);
    });
  });

  it("leaves the ordinary debt limit unpassed: two grants racing for its last room, one wins", async () => {
    await isolated(async () => {
      const day = testDay(4);
      const { db } = at(day);
      const limit = LIVE_ORDINARY_DEBT_LIMIT.do_rows_written;
      await env.DIRECTORY.prepare(
        "UPDATE live_budget_state SET debt_do_rows_written = ? WHERE id = 1",
      )
        .bind(limit - 5)
        .run();
      const one = async () =>
        reserveLive(
          db,
          await makeLiveGrant(
            await plan({ day, directoryCleanupDebt: vector({ do_rows_written: 5 }) }),
          ),
        );
      const results = await Promise.all([one(), one()]);
      expect(results.filter(granted)).toHaveLength(1);
      expect(results.find((x) => !granted(x))).toEqual({
        status: "refused",
        reason: "temporary",
        gate: "debt:do_rows_written",
      });
      expect((await ledger())?.debt_do_rows_written).toBe(limit);
    });
  });

  it("debits neither day when the second day does not fit", async () => {
    await isolated(async () => {
      const day = testDay(5);
      const { db } = at(day, DAY - 60_000);
      await env.DIRECTORY.prepare(
        "INSERT INTO live_budget_days (day, do_requests, retain_until, cleanup_debt) VALUES (?, ?, 0, ?)",
      )
        .bind(day + 1, LIVE_DAILY.do_requests - LIVE_PROTECTED.do_requests, JSON.stringify(ZERO))
        .run();
      const before = await ledger();
      const result = await reserveLive(
        db,
        await makeLiveGrant(
          await plan({
            day,
            from: (day + 1) * DAY - 60_000,
            validMs: 120_000,
            directoryCleanupDebt: vector({ do_rows_written: 1 }),
            charges: [
              { day, resources: vector({ do_requests: 1 }), duration: null },
              { day: day + 1, resources: vector({ do_requests: 1 }), duration: null },
            ],
          }),
        ),
      );
      expect(result).toEqual({ status: "refused", reason: "temporary", gate: "second_day" });
      expect(await dayRow(day)).toBeNull();
      expect((await dayRow(day + 1))?.do_requests).toBe(
        LIVE_DAILY.do_requests - LIVE_PROTECTED.do_requests,
      );
      expect(await receipts()).toBe(0);
      expect(await ledger()).toEqual(before);
    });
  });

  it("changes nothing when a statement of its batch fails", async () => {
    await isolated(async () => {
      const day = testDay(6);
      const { db } = at(day);
      const request = await makeLiveGrant(
        await plan({
          day,
          producesLocal: true,
          recipient: "usr_rollback",
          localCleanupDebt: vector({ do_rows_written: 2 }),
        }),
      );
      await env.DIRECTORY.prepare(
        `CREATE TRIGGER live_budget_test_fail BEFORE INSERT ON live_recovery_targets
         BEGIN SELECT RAISE(ABORT, 'test'); END`,
      ).run();
      const before = await ledger();
      try {
        expect(await reserveLive(db, request)).toEqual({
          status: "refused",
          reason: "temporary",
          gate: "unknown",
        });
      } finally {
        await env.DIRECTORY.prepare("DROP TRIGGER live_budget_test_fail").run();
      }
      expect(await ledger()).toEqual(before);
      expect(await dayRow(day)).toBeNull();
      expect(await receipts()).toBe(0);
      // The same identity, once the failure is gone, is granted once.
      expect((await reserveLive(db, request)).status).toBe("granted");
    });
  });

  it("is granted once when its answer was lost: the retry gets the same grant, nothing charged again", async () => {
    await isolated(async () => {
      const day = testDay(7);
      const { db } = at(day);
      const lossy = new Proxy(db, {
        get(target, prop) {
          if (prop === "batch")
            return async (statements: D1PreparedStatement[]) => {
              await target.batch(statements);
              throw new Error("Network connection lost.");
            };
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as D1Database;
      const request = await makeLiveGrant(
        await plan({
          day,
          producesLocal: true,
          recipient: "usr_lost",
          localCleanupDebt: vector({ do_rows_written: 3 }),
          charges: [
            {
              day,
              resources: vector({ do_requests: 2, do_duration_ms: 500 }),
              duration: { day, from: day * DAY, until: day * DAY + DAY / 2 + 120_000, ms: 500 },
            },
          ],
        }),
      );
      expect(await reserveLive(lossy, request)).toEqual({
        status: "refused",
        reason: "temporary",
        gate: "unknown",
      });
      const first = (await ledger())?.grant_seq as number;
      const retry = await reserveLive(db, request);
      expect(retry).toMatchObject({ status: "granted", replay: true, grant: { seq: first } });
      const row = await dayRow(day);
      expect([row?.do_requests, row?.do_duration_ms]).toEqual([2, 500]);
      expect(JSON.parse(String(row?.escrow))).toHaveLength(1);
      expect((await ledger())?.grant_seq).toBe(first);
      const target = await env.DIRECTORY.prepare(
        "SELECT local_cleanup_debt FROM live_recovery_targets WHERE feed = 'usr_lost'",
      ).first<{ local_cleanup_debt: string }>();
      expect(JSON.parse(target?.local_cleanup_debt ?? "{}").do_rows_written).toBe(3);
    });
  });

  it("is fenced on replay by a restore since it was granted", async () => {
    await isolated(async () => {
      const day = testDay(12);
      const { db } = at(day);
      const recipient = `usr_${uniqueId("replay")}`;
      const request = await makeLiveGrant(await plan({ day, recipient }));
      expect((await reserveLive(db, request)).status).toBe("granted");
      await env.DIRECTORY.prepare("INSERT INTO source_epochs (source_id, epoch_gen) VALUES (?, 4)")
        .bind(`feed:${recipient}`)
        .run();
      expect(await reserveLive(db, request)).toEqual({
        status: "refused",
        reason: "fenced",
        gate: "epoch",
      });
    });
  });

  it("refuses an identity presented with another plan", async () => {
    await isolated(async () => {
      const day = testDay(8);
      const { db } = at(day);
      const request = await makeLiveGrant(await plan({ day }));
      const altered = { ...request, plan: { ...request.plan, recipient: "usr_other" } };
      expect(await reserveLive(db, altered)).toEqual({
        status: "refused",
        reason: "invalid",
        gate: "validity",
      });
      expect(await receipts()).toBe(0);
    });
  });

  it("holds 64 unsettled durations a day, refusing the 65th whole", async () => {
    await isolated(async () => {
      const day = testDay(9);
      const { db } = at(day);
      const hold = async () =>
        reserveLive(
          db,
          await makeLiveGrant(
            await plan({
              day,
              class: "cleanup",
              kind: "maintenance",
              charges: [
                {
                  day,
                  resources: vector({ do_duration_ms: 10 }),
                  duration: { day, from: day * DAY, until: day * DAY + DAY / 2 + 60_000, ms: 10 },
                },
              ],
            }),
          ),
        );
      for (let i = 0; i < LIVE_ESCROW_ENTRIES; i++) expect((await hold()).status).toBe("granted");
      const before = await dayRow(day);
      expect(await hold()).toEqual({ status: "refused", reason: "temporary", gate: "escrow_full" });
      const after = await dayRow(day);
      expect(JSON.parse(String(after?.escrow))).toHaveLength(LIVE_ESCROW_ENTRIES);
      expect(after).toEqual(before);
      expect(await receipts()).toBe(LIVE_ESCROW_ENTRIES);
    });
  });

  it("waits for overdue cleanup when ordinary, once it calls for a run: a page, or two hours; not when cleanup", async () => {
    await isolated(async () => {
      const day = testDay(10);
      const { db, clock } = at(day);
      const ordinary = async () =>
        (
          await reserveLive(
            db,
            await makeLiveGrant(await plan({ day: Math.floor(clock.now / DAY), from: clock.now })),
          )
        ).status;
      expect(await ordinary()).toBe("granted");
      // Its receipt's expiry: overdue from then, not yet removed.
      const expiry = day * DAY + DAY / 2 + 60_000 + 60 * 60_000;
      clock.now = expiry + LIVE_RECEIPTS_OVERDUE.graceMs - 60_000;
      expect(await ordinary()).toBe("granted");
      clock.now = expiry + LIVE_RECEIPTS_OVERDUE.graceMs;
      expect(await ordinary()).toBe("refused");
      const cleanup = await reserveLive(
        db,
        await makeLiveGrant(
          await plan({
            day: Math.floor(clock.now / DAY),
            from: clock.now,
            class: "cleanup",
            kind: "maintenance",
          }),
        ),
      );
      expect(cleanup.status).toBe("granted");
    });
    await isolated(async () => {
      const day = testDay(11);
      const { db, clock } = at(day);
      const grant = async (from: number) =>
        (await reserveLive(db, await makeLiveGrant(await plan({ day, from })))).status;
      // A page but one expiring at once, the last a half hour later.
      const noon = day * DAY + DAY / 2;
      for (let i = 1; i < LIVE_RECEIPTS_OVERDUE.page; i++)
        expect(await grant(noon)).toBe("granted");
      clock.now = noon + 30 * 60_000;
      expect(await grant(clock.now)).toBe("granted");
      const ordinary = async () =>
        (
          await reserveLive(
            db,
            await makeLiveGrant(await plan({ day: Math.floor(clock.now / DAY), from: clock.now })),
          )
        ).status;
      const expiry = noon + 60_000 + 60 * 60_000;
      clock.now = expiry + 60_000;
      expect(await ordinary()).toBe("granted");
      // The page's last just expired: the cron's next run has yet to come.
      clock.now = expiry + 31 * 60_000;
      expect(await ordinary()).toBe("granted");
      // A page expired for as long as two of the cron's runs take: maintenance isn't clearing them.
      clock.now = expiry + 30 * 60_000 + LIVE_RECEIPTS_OVERDUE.pageAfterMs - 1_000;
      expect(await ordinary()).toBe("granted");
      clock.now = expiry + 30 * 60_000 + LIVE_RECEIPTS_OVERDUE.pageAfterMs;
      expect(await ordinary()).toBe("refused");
    });
  });

  it("is fenced by the ledger's incarnation and the feed's epoch, and expired past its validity", async () => {
    await isolated(async () => {
      const day = testDay(11);
      const { db, clock } = at(day);
      const recipient = `usr_${uniqueId("epoch")}`;
      await env.DIRECTORY.prepare("INSERT INTO source_epochs (source_id, epoch_gen) VALUES (?, 3)")
        .bind(`feed:${recipient}`)
        .run();
      expect(
        await reserveLive(db, await makeLiveGrant(await plan({ day, recipient, epoch: 2 }))),
      ).toEqual({ status: "refused", reason: "fenced", gate: "epoch" });
      expect(
        await reserveLive(
          db,
          await makeLiveGrant(
            await plan({ day, recipient, epoch: 3, incarnation: "0".repeat(32) }),
          ),
        ),
      ).toEqual({ status: "refused", reason: "fenced", gate: "target_incarnation" });
      const request = await makeLiveGrant(await plan({ day, recipient, epoch: 3 }));
      clock.now = request.plan.validUntil;
      expect(await reserveLive(db, request)).toEqual({
        status: "refused",
        reason: "expired",
        gate: "validity",
      });
      expect(await receipts()).toBe(0);
    });
  });
});

describe("a live grant's duration", () => {
  /** A grant holding the duration of one run dispatched up to `dispatchMs` after `from`. */
  async function durationGrant(
    day: number,
    from: number,
    dispatchMs: number,
    pendingMs: number,
    tailMs: number,
  ) {
    const holds = reserveDuration(from, from + dispatchMs, pendingMs, tailMs);
    const p = await plan({
      day,
      from,
      validMs: dispatchMs + 1,
      charges: holds.map((h) => ({
        day: h.day,
        resources: vector({ do_duration_ms: h.ms }),
        duration: h,
      })),
    });
    return makeLiveGrant(p);
  }

  it("is held on both days when a run can cross midnight, and settled day by day", async () => {
    await isolated(async () => {
      const day = testDay(20);
      const from = (day + 1) * DAY - 30_000;
      const { db, clock } = at(day, DAY - 30_000);
      const request = await durationGrant(day, from, 10_000, 60_000, 1_000);
      expect(request.plan.charges.map((c) => [c.day, c.duration?.ms])).toEqual([
        [day, 30_000],
        [day + 1, 61_000 - 20_000],
      ]);
      const result = await reserveLive(db, request);
      if (result.status !== "granted") throw new Error(JSON.stringify(result));
      expect((await dayRow(day))?.do_duration_ms).toBe(30_000);
      expect((await dayRow(day + 1))?.do_duration_ms).toBe(41_000);
      // Dispatched 5 s in, finished 40 s later: 25 s before midnight, 15 s + 1 s tail after.
      const guard = beginLiveDuration(result.grant, from + 5_000, 60_000, 1_000);
      expect(guard).not.toBeNull();
      const completion = finishLiveDuration(guard as LiveDurationGuard, from + 45_000);
      expect(completion?.actual).toEqual([
        { day, ms: 25_000 },
        { day: day + 1, ms: 16_000 },
      ]);
      clock.now = from + 60_000;
      expect(await settleLiveDuration(db, completion as LiveDurationCompletion)).toBe("settled");
      expect([
        (await dayRow(day))?.do_duration_ms,
        (await dayRow(day + 1))?.do_duration_ms,
      ]).toEqual([25_000, 16_000]);
      expect(JSON.parse(String((await dayRow(day))?.escrow))).toEqual([]);
      // Again: a duplicate, nothing changes; another vector: refused.
      expect(await settleLiveDuration(db, completion as LiveDurationCompletion)).toBe("duplicate");
      const other = {
        ...(completion as LiveDurationCompletion),
        actual: [
          { day, ms: 1 },
          { day: day + 1, ms: 1 },
        ],
      };
      expect(await settleLiveDuration(db, other)).toBe("invalid");
      expect([
        (await dayRow(day))?.do_duration_ms,
        (await dayRow(day + 1))?.do_duration_ms,
      ]).toEqual([25_000, 16_000]);
    });
  });

  it("is refunded to its own day only, settled a day later", async () => {
    await isolated(async () => {
      const day = testDay(21);
      const from = day * DAY + DAY / 2;
      const { db, clock } = at(day);
      const result = await reserveLive(db, await durationGrant(day, from, 1_000, 60_000, 0));
      if (result.status !== "granted") throw new Error(JSON.stringify(result));
      const guard = beginLiveDuration(result.grant, from, 60_000, 0) as LiveDurationGuard;
      const completion = finishLiveDuration(guard, from + 10_000) as LiveDurationCompletion;
      clock.now = (day + 1) * DAY + 1_000;
      expect(await settleLiveDuration(db, completion)).toBe("settled");
      expect((await dayRow(day))?.do_duration_ms).toBe(10_000);
      expect(await dayRow(day + 1)).toBeNull();
    });
  });

  it("is not settled past its deadline, nor for another recipient, epoch, day or more than held", async () => {
    await isolated(async () => {
      const day = testDay(22);
      const from = day * DAY + DAY / 2;
      const { db, clock } = at(day);
      const result = await reserveLive(db, await durationGrant(day, from, 1_000, 60_000, 0));
      if (result.status !== "granted") throw new Error(JSON.stringify(result));
      const good = finishLiveDuration(
        beginLiveDuration(result.grant, from, 60_000, 0) as LiveDurationGuard,
        from + 1_000,
      ) as LiveDurationCompletion;
      const wrong: LiveDurationCompletion[] = [
        { ...good, recipient: "usr_other" },
        { ...good, epoch: good.epoch + 1 },
        { ...good, actual: [{ day: day + 1, ms: 1 }] },
        {
          ...good,
          actual: [
            { day, ms: 1 },
            { day: day + 1, ms: 1 },
          ],
        },
        { ...good, actual: [{ day, ms: 60_001 }] },
        { ...good, finishedAt: from + 120_000 },
      ];
      for (const c of wrong) expect(await settleLiveDuration(db, c)).toBe("invalid");
      expect((await dayRow(day))?.do_duration_ms).toBe(60_000);
      clock.now = (
        await env.DIRECTORY.prepare(
          "SELECT settle_until FROM live_budget_receipts WHERE operation_id = ?",
        )
          .bind(result.grant.operationId)
          .first<{ settle_until: number }>()
      )?.settle_until as number;
      expect(await settleLiveDuration(db, good)).toBe("expired");
      expect((await dayRow(day))?.do_duration_ms).toBe(60_000);
    });
  });

  it("keeps its whole charge for a run past what was held, or started past the grant's local deadline", async () => {
    await isolated(async () => {
      const day = testDay(23);
      const from = day * DAY + DAY / 2;
      const { db } = at(day);
      const result = await reserveLive(db, await durationGrant(day, from, 1_000, 60_000, 0));
      if (result.status !== "granted") throw new Error(JSON.stringify(result));
      const guard = beginLiveDuration(result.grant, from, 60_000, 0) as LiveDurationGuard;
      expect(finishLiveDuration(guard, from + 60_001)).toBeNull();
      // Asked at `from`, answered late: the validity's end is counted from the ask, locally.
      const deadline = liveLocalDeadline(from, result.grant.ledgerAt, result.grant.plan.validUntil);
      expect(deadline).toBeLessThanOrEqual(result.grant.plan.validUntil);
      expect(beginLiveDuration(result.grant, deadline, 60_000, 0)).toBeNull();
      // A guard needing more than was held.
      expect(beginLiveDuration(result.grant, from, 120_000, 0)).toBeNull();
    });
  });
});

describe("how long a receipt is kept", () => {
  const HOUR = 60 * 60_000;

  it("is an hour past its validity, or until its settlement window closes", async () => {
    const day = testDay(40);
    const noon = day * DAY + DAY / 2;
    expect(liveReceiptDeadlines(await plan({ day, from: noon }))).toEqual({
      settleUntil: noon + 60_000,
      expiresAt: noon + 60_000 + HOUR,
    });
    const until = noon + 60_000;
    expect(
      liveReceiptDeadlines(
        await plan({
          day,
          from: noon,
          charges: [
            {
              day,
              resources: vector({ do_duration_ms: 10 }),
              duration: { day, from: noon, until, ms: 10 },
            },
          ],
        }),
      ),
    ).toEqual({ settleUntil: until + DAY, expiresAt: until + DAY });
  });

  it("is accepted by the table's rule, and its debt leaves with its row", () =>
    isolated(async () => {
      const day = testDay(41);
      const { db, clock } = at(day);
      const debt = vector({ d1_rows_written: 7 });
      const planned = await plan({ day, from: clock.now, directoryCleanupDebt: debt });
      const before = (await ledger())?.debt_d1_rows_written as number;
      expect((await reserveLive(db, await makeLiveGrant(planned))).status).toBe("granted");
      expect((await ledger())?.debt_d1_rows_written).toBe(before + 7);
      clock.now = planned.validUntil + HOUR - 1;
      expect(await expireLiveReceipts(db)).toEqual({ expired: 0 });
      clock.now = planned.validUntil + HOUR;
      expect(await expireLiveReceipts(db)).toEqual({ expired: 1 });
      expect((await ledger())?.debt_d1_rows_written).toBe(before);
    }));

  it("keeps every receipt and its dates when its table is rebuilt", () =>
    isolated(async () => {
      const day = testDay(43);
      const { db, clock } = at(day);
      const planned = await plan({ day, from: clock.now });
      expect((await reserveLive(db, await makeLiveGrant(planned))).status).toBe("granted");
      const all = () =>
        env.DIRECTORY.prepare("SELECT * FROM live_budget_receipts ORDER BY seq").all();
      const before = (await all()).results;
      expect(before.length).toBeGreaterThan(0);
      const migrations = (
        env as unknown as { DIRECTORY_MIGRATIONS: { name: string; queries: string[] }[] }
      ).DIRECTORY_MIGRATIONS;
      const rebuild = migrations.find((m) => m.name.includes("live_receipts_retention"));
      expect(rebuild).toBeDefined();
      await env.DIRECTORY.batch(
        (rebuild?.queries ?? []).map((query) => env.DIRECTORY.prepare(query)),
      );
      expect((await all()).results).toEqual(before);
    }));

  it("refuses a row kept less than the hour", async () => {
    await isolated(async () => {
      const day = testDay(42);
      const { db, clock } = at(day);
      const planned = await plan({ day, from: clock.now });
      expect((await reserveLive(db, await makeLiveGrant(planned))).status).toBe("granted");
      await expect(
        env.DIRECTORY.prepare(
          "UPDATE live_budget_receipts SET expires_at = valid_until + 3599999, settle_until = valid_until WHERE valid_from = ?",
        )
          .bind(planned.validFrom)
          .run(),
      ).rejects.toThrow(/CHECK/);
    });
  });
});
