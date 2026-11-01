// A feed's alarm, set by one policy: the earliest of its schedule's rows and
// of funded live work's eligible deadline, moved later or deleted when the
// schedule says so, left alone when it already rings then; while the epoch
// cannot be read, overdue rows wait for the retry and nothing else changes;
// funded live work wakes it only when ready; a recovery holds the live row
// back. No other code of the object writes the alarm.

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { afterEach, describe, expect, it } from "vitest";
import { feedHooks, type UserDO } from "../src/do/UserDO.js";
import userSource from "../src/do/UserDO.ts?raw";

const MINUTE = 60_000;

/** A fresh feed's object, its schedule `rows` (by kind, minutes from now), its alarm at `alarm`. */
async function feed(rows: Record<string, number>, alarm?: number) {
  const stub = env.USER.getByName(`usr_${uniqueId("arm")}`);
  const now = Date.now();
  await runInDurableObject(stub, async (_: UserDO, state) => {
    for (const [kind, minutes] of Object.entries(rows))
      state.storage.sql.exec(
        "INSERT INTO user_schedule (kind, due_at) VALUES (?, ?)",
        kind,
        now + minutes * MINUTE,
      );
    if (alarm !== undefined) await state.storage.setAlarm(alarm);
  });
  return { stub, now };
}

const alarmOf = (stub: DurableObjectStub<UserDO>) =>
  runInDurableObject(stub, (_: UserDO, state) => state.storage.getAlarm());

const scheduleOf = (stub: DurableObjectStub<UserDO>) =>
  runInDurableObject(stub, (_: UserDO, state) =>
    state.storage.sql.exec("SELECT kind, due_at FROM user_schedule ORDER BY kind").toArray(),
  );

afterEach(() => {
  delete feedHooks.beforeEpochRead;
  delete feedHooks.liveReadiness;
});

describe("a feed's alarm", () => {
  it("moves later when the schedule is later, and goes when nothing is scheduled", async () => {
    // An alarm earlier than anything scheduled, and an entry that is not the alarm (a cold
    // object's first call takes its epoch, then arms).
    const { stub, now } = await feed({ retain: 30 }, Date.now() + 1_000);
    await runInDurableObject(stub, (instance: UserDO) => instance.liveTicket("tok_arm"));
    expect(await alarmOf(stub)).toBe(now + 30 * MINUTE);
    const empty = await feed({}, Date.now() + 1_000);
    await runInDurableObject(empty.stub, (instance: UserDO) => instance.liveTicket("tok_arm"));
    expect(await alarmOf(empty.stub)).toBeNull();
  });

  it("is not written again when it already rings when the schedule wants", async () => {
    const { stub, now } = await feed({ retain: 30 });
    await runDurableObjectAlarm(stub).catch(() => false);
    await runInDurableObject(stub, async (_: UserDO, state) => {
      await state.storage.setAlarm(now + 30 * MINUTE);
    });
    const writes = await runInDurableObject(stub, async (instance: UserDO, state) => {
      let n = 0;
      const set = state.storage.setAlarm.bind(state.storage);
      state.storage.setAlarm = (async (...args: Parameters<typeof set>) => {
        n++;
        return set(...args);
      }) as typeof state.storage.setAlarm;
      await instance.alarm();
      return n;
    });
    expect(writes).toBe(0);
  });

  it("while its epoch cannot be read, retries overdue work and keeps future work's time", async () => {
    feedHooks.beforeEpochRead = async () => {
      throw new Error("directory unavailable");
    };
    // Overdue email and future retention: the retry (a minute on) is earlier than retention.
    const mixed = await feed({ email: -5, retain: 30 });
    await runInDurableObject(mixed.stub, (instance: UserDO) => instance.alarm());
    const at = (await alarmOf(mixed.stub)) as number;
    expect(at).toBeGreaterThanOrEqual(mixed.now + MINUTE - 1_000);
    expect(at).toBeLessThan(mixed.now + 2 * MINUTE);
    // The schedule itself as it was.
    expect((await scheduleOf(mixed.stub)).map((r) => r.kind)).toEqual(["email", "retain"]);
    // Only future work: its own time, no retry.
    const future = await feed({ retain: 30 });
    await runInDurableObject(future.stub, (instance: UserDO) => instance.alarm());
    expect(await alarmOf(future.stub)).toBe(future.now + 30 * MINUTE);
    // Funded live work ready meanwhile wakes nothing while the epoch cannot be read.
    feedHooks.liveReadiness = () => ({
      status: "ready",
      at: Date.now(),
      validUntil: Date.now() + 10 * MINUTE,
      generation: 1,
    });
    const funded = await feed({});
    await runInDurableObject(funded.stub, (instance: UserDO) => instance.alarm());
    expect(await alarmOf(funded.stub)).toBeNull();
  });

  it("is woken by funded live work only while it is ready", async () => {
    let ready = true;
    feedHooks.liveReadiness = () =>
      ready
        ? {
            status: "ready",
            at: Date.now() + 5 * MINUTE,
            validUntil: Date.now() + 10 * MINUTE,
            generation: 1,
          }
        : { status: "blocked" };
    const { stub, now } = await feed({ retain: 30 });
    await runInDurableObject(stub, (instance: UserDO) => instance.alarm());
    const woken = (await alarmOf(stub)) as number;
    expect(woken).toBeGreaterThanOrEqual(now + 5 * MINUTE);
    expect(woken).toBeLessThan(now + 6 * MINUTE);
    ready = false;
    await runInDurableObject(stub, (instance: UserDO) => instance.alarm());
    expect(await alarmOf(stub)).toBe(now + 30 * MINUTE);
  });
});

describe("a feed's alarm while it is reconciled", () => {
  afterEach(() => {
    delete feedHooks.beforeAlarmWrite;
  });

  it("follows readiness that lapses while the alarm is read", async () => {
    let ready = true;
    feedHooks.liveReadiness = () =>
      ready
        ? {
            status: "ready",
            at: Date.now() + 5 * MINUTE,
            validUntil: Date.now() + 10 * MINUTE,
            generation: 1,
          }
        : { status: "blocked" };
    const { stub, now } = await feed({ retain: 30 });
    feedHooks.beforeAlarmWrite = async () => {
      ready = false;
    };
    await runInDurableObject(stub, (instance: UserDO) => instance.alarm());
    expect(await alarmOf(stub)).toBe(now + 30 * MINUTE);
  });
});

describe("the feed object's source", () => {
  it("writes the alarm only where it reconciles it", () => {
    const code = userSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code.match(/\.setAlarm\(/g)).toHaveLength(1);
    expect(code.match(/\.deleteAlarm\(/g)).toHaveLength(1);
    const reconcile = code.slice(code.indexOf("async #reconcileAlarm()"));
    const body = reconcile.slice(0, reconcile.indexOf("\n  }\n"));
    expect(body).toContain(".setAlarm(");
    expect(body).toContain(".deleteAlarm(");
  });
});
