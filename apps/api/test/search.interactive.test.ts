// Searches' reads, an allowance of their own: a reservation the day can hold
// is made (exactly to the limit, never past it, however many ask; never less
// than a search's least charge), one it cannot is refused until the next UTC
// day; a read batch reads only as its reservation's day's (one that ran on a
// later day is not used, and is charged to that day); a settlement gives back
// what was not used, once, and charges more than reserved all the same.
// Nothing of the projections' or the reconciliations' allowances moves, and
// nothing is reserved or settled while the read model is under maintenance
// (a reservation not settled stays spent).

import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_ORG_SHARD, readModelFor } from "../src/events/read-model.js";
import { OperationError } from "../src/ops/execute.js";
import { pauseReadModel, resumeReadModel } from "../src/read-model/maintenance.js";
import {
  INTERACTIVE,
  InteractiveDayEnded,
  readOnDay,
  reserveInteractive,
  settleInteractive,
} from "../src/search/interactive.js";

const db = readModelFor(env, DEFAULT_ORG_SHARD);
const TODAY = "CAST(unixepoch() / 86400 AS INTEGER)";

const budget = () =>
  db
    .prepare(`SELECT rows, reads, interactive_reads FROM search_budget WHERE day = ${TODAY}`)
    .first<{ rows: number; reads: number; interactive_reads: number }>()
    .then((r) => r ?? { rows: 0, reads: 0, interactive_reads: 0 });

/** Today's searches' reads set to `n`. */
const spent = (n: number) =>
  db.batch([
    db.prepare(`INSERT INTO search_budget (day) VALUES (${TODAY}) ON CONFLICT (day) DO NOTHING`),
    db.prepare(`UPDATE search_budget SET interactive_reads = ? WHERE day = ${TODAY}`).bind(n),
  ]);

afterEach(() => spent(0));

async function refusal(work: Promise<unknown>): Promise<OperationError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(OperationError);
    return error as OperationError;
  }
  throw new Error("not refused");
}

describe("searches' reads", () => {
  it("are reserved up to the day's allowance exactly, and refused past it until the next UTC day", async () => {
    await spent(INTERACTIVE.dailyReads - 2 * INTERACTIVE.searchReads);
    const before = await budget();
    // A search's least charge, however little it asks for.
    expect((await reserveInteractive(db, 0)).reads).toBe(INTERACTIVE.searchReads);
    const reserved = await reserveInteractive(db, INTERACTIVE.searchReads);
    expect(reserved.reads).toBe(INTERACTIVE.searchReads);
    expect((await budget()).interactive_reads).toBe(INTERACTIVE.dailyReads);
    const refused = await refusal(reserveInteractive(db, 1));
    expect(refused.status).toBe(429);
    expect(refused.code).toBe("search_budget");
    expect(refused.retryAfter).toBeGreaterThan(0);
    expect(refused.retryAfter).toBeLessThanOrEqual(86_400);
    // The other allowances untouched.
    const after = await budget();
    expect({ rows: after.rows, reads: after.reads }).toEqual({
      rows: before.rows,
      reads: before.reads,
    });
  });

  it("are never reserved past the allowance by reservations at once", async () => {
    await spent(INTERACTIVE.dailyReads - 1_500);
    const tries = await Promise.allSettled([
      reserveInteractive(db, 1_000),
      reserveInteractive(db, 1_000),
    ]);
    expect(tries.filter((t) => t.status === "fulfilled")).toHaveLength(1);
    expect((await budget()).interactive_reads).toBe(INTERACTIVE.dailyReads - 500);
  });

  it("are settled at what was read: the rest given back once, more than reserved charged", async () => {
    await spent(0);
    const reservation = await reserveInteractive(db, 5_000);
    const outstanding = await reserveInteractive(db, 4_000);
    await settleInteractive(db, reservation, 3_000);
    expect((await budget()).interactive_reads).toBe(7_000);
    // Once: a second settlement is refused, the other reservation untouched.
    await expect(settleInteractive(db, reservation, 3_000)).rejects.toThrow(/settled already/);
    expect((await budget()).interactive_reads).toBe(7_000);
    // Never below a search's least charge; more than reserved, all of it.
    await settleInteractive(db, outstanding, 0);
    expect((await budget()).interactive_reads).toBe(3_000 + INTERACTIVE.searchReads);
    const over = await reserveInteractive(db, 1_000);
    await settleInteractive(db, over, 2_500);
    expect((await budget()).interactive_reads).toBe(5_500 + INTERACTIVE.searchReads);
  });

  it("are counts", async () => {
    const before = await budget();
    for (const n of [-500, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])
      await expect(reserveInteractive(db, n)).rejects.toThrow(RangeError);
    const reservation = await reserveInteractive(db, 1_000);
    await expect(settleInteractive(db, reservation, -1)).rejects.toThrow(RangeError);
    expect((await budget()).interactive_reads).toBe(before.interactive_reads + 1_000);
  });

  it("are read only as their reservation's day's", async () => {
    const today = await reserveInteractive(db, 10);
    const [read] = await readOnDay(db, today, [db.prepare("SELECT 1 AS one")]);
    expect(read?.results).toEqual([{ one: 1 }]);
    // One that ran on a later day is charged to it, held or not, its results not used.
    await spent(INTERACTIVE.dailyReads);
    const yesterday = { day: today.day - 1, reads: 10 };
    try {
      await readOnDay(db, yesterday, [db.prepare("SELECT count(*) AS n FROM search_budget")]);
      throw new Error("read on a day that ended");
    } catch (error) {
      expect(error).toBeInstanceOf(InteractiveDayEnded);
      const { reads } = error as InteractiveDayEnded;
      expect(reads).toBeGreaterThan(0);
      expect((await budget()).interactive_reads).toBe(INTERACTIVE.dailyReads + reads);
    }
  });

  it("are neither reserved nor settled while the read model is under maintenance", async () => {
    await spent(0);
    const reservation = await reserveInteractive(db, 5_000);
    for (let step = 0; step < 5; step++)
      if ((await pauseReadModel(env, DEFAULT_ORG_SHARD)).phase === "paused") break;
    try {
      for (const work of [reserveInteractive(db, 10), settleInteractive(db, reservation, 0)]) {
        const refused = await refusal(work);
        expect(refused.status).toBe(503);
        expect(refused.code).toBe("read_model_maintenance");
      }
    } finally {
      await resumeReadModel(env, DEFAULT_ORG_SHARD);
    }
    // The reservation not settled stays spent, and settles no more.
    expect((await budget()).interactive_reads).toBe(5_000);
    await expect(settleInteractive(db, reservation, 0)).rejects.toThrow(/settled already/);
  });
});
