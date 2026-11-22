// CI minutes in an account's object: a job reserves its minutes by key
// before it may start, settles what it ran, or releases them. Each call is
// idempotent by key; a release leaves a tombstone that a later reserve of
// the key is answered with; a reserve at or after the key's validity
// expires; a hold past its settlement time counts as used. Quotas are per
// UTC month, for the account and for each agent.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ciVariableOverrides } from "../src/ci/budget.js";
import type { OrgDO } from "../src/do/OrgDO.js";
import {
  CI_FREE_ACCOUNT_MINUTES,
  CI_FREE_AGENT_MINUTES,
  ciMinuteLimits,
} from "../src/do/org/ci-minutes.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const account = () => env.ORG.getByName(uniqueId("acct"));

function reservation(over: Partial<Parameters<OrgDO["reserveCiMinutes"]>[0]> = {}) {
  const now = Date.now();
  return {
    key: uniqueId("run/j1/r1"),
    agentId: null,
    minutes: 100,
    validUntil: now + 10 * MINUTE,
    settleBy: now + 5 * HOUR,
    ...over,
  };
}

async function rowOf(stub: DurableObjectStub<OrgDO>, key: string) {
  return runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec("SELECT * FROM ci_minutes WHERE key = ?", key).toArray(),
  );
}

/** Mid-month, so no test's steps cross into another month. */
const BASE = Date.UTC(2031, 2, 10, 12);

beforeEach(() => {
  // On Free's defaults: 2,000 minutes an account and 500 an agent a month.
  ciVariableOverrides.FYRDEN_PLAN = "free";
  vi.setSystemTime(BASE);
});

describe("CI minute limits", () => {
  it("are Free's defaults, any variable set, and none on Paid unless set", () => {
    expect(ciMinuteLimits({})).toEqual({
      account: CI_FREE_ACCOUNT_MINUTES,
      agent: CI_FREE_AGENT_MINUTES,
    });
    expect(CI_FREE_ACCOUNT_MINUTES).toBe(2_000);
    expect(CI_FREE_AGENT_MINUTES).toBe(500);
    expect(ciMinuteLimits({ QUOTA_CI_MINUTES: "30", QUOTA_CI_AGENT_MINUTES: 7 })).toEqual({
      account: 30,
      agent: 7,
    });
    expect(ciMinuteLimits({ FYRDEN_PLAN: "paid" })).toEqual({ account: null, agent: null });
    expect(ciMinuteLimits({ FYRDEN_PLAN: "paid", QUOTA_CI_MINUTES: "9" })).toEqual({
      account: 9,
      agent: null,
    });
    expect(ciMinuteLimits({ QUOTA_CI_MINUTES: "-1", QUOTA_CI_AGENT_MINUTES: "x" })).toEqual({
      account: CI_FREE_ACCOUNT_MINUTES,
      agent: CI_FREE_AGENT_MINUTES,
    });
  });
});

describe("reserving CI minutes", () => {
  it("holds a key once: asked again, the same grant", async () => {
    const stub = account();
    const req = reservation();
    expect(await stub.reserveCiMinutes(req)).toEqual({ status: "granted", replay: false });
    expect(await stub.reserveCiMinutes(req)).toEqual({ status: "granted", replay: true });
    expect(await rowOf(stub, req.key)).toEqual([
      expect.objectContaining({ key: req.key, reserved: 100, used: 0, state: "held" }),
    ]);
    // One hold: 1,900 more fit, 1,901 do not.
    expect(await stub.reserveCiMinutes(reservation({ minutes: 1_901 }))).toMatchObject({
      status: "refused",
      reason: "account",
    });
    expect(await stub.reserveCiMinutes(reservation({ minutes: 1_900 }))).toMatchObject({
      status: "granted",
    });
  });

  it("refuses past the account's month, with the next UTC midnight to ask again", async () => {
    const stub = account();
    expect((await stub.reserveCiMinutes(reservation({ minutes: 1_950 }))).status).toBe("granted");
    const refused = await stub.reserveCiMinutes(reservation({ minutes: 51 }));
    const midnight = Date.UTC(2031, 2, 11);
    // Held, not used: the month may still have room once the hold settles.
    expect(refused).toEqual({
      status: "refused",
      reason: "account",
      retryAt: midnight,
      resetsAt: null,
    });
  });

  it("refuses past an agent's month while the account has room", async () => {
    const stub = account();
    const agentId = uniqueId("agt");
    expect((await stub.reserveCiMinutes(reservation({ agentId, minutes: 400 }))).status).toBe(
      "granted",
    );
    expect(await stub.reserveCiMinutes(reservation({ agentId, minutes: 101 }))).toMatchObject({
      status: "refused",
      reason: "agent",
    });
    // Another agent, and the account's own work, still fit.
    expect(
      (await stub.reserveCiMinutes(reservation({ agentId: uniqueId("agt"), minutes: 101 }))).status,
    ).toBe("granted");
    expect((await stub.reserveCiMinutes(reservation({ minutes: 101 }))).status).toBe("granted");
  });

  it("answers too_large, and holds nothing, for minutes no month of the account or agent can hold", async () => {
    const stub = account();
    expect(await stub.reserveCiMinutes(reservation({ minutes: 2_001 }))).toEqual({
      status: "too_large",
      reason: "account",
      limit: 2_000,
    });
    const agentId = uniqueId("agt");
    expect(await stub.reserveCiMinutes(reservation({ agentId, minutes: 501 }))).toEqual({
      status: "too_large",
      reason: "agent",
      limit: 500,
    });
    // Nothing was held: the whole month still fits.
    expect((await stub.reserveCiMinutes(reservation({ minutes: 2_000 }))).status).toBe("granted");
  });

  it("records minutes on Paid with no quota set, refusing none", async () => {
    ciVariableOverrides.FYRDEN_PLAN = "paid";
    const stub = account();
    const req = reservation({ minutes: 10_000 });
    expect((await stub.reserveCiMinutes(req)).status).toBe("granted");
    expect((await stub.reserveCiMinutes(reservation({ minutes: 10_000 }))).status).toBe("granted");
    expect(await rowOf(stub, req.key)).toEqual([
      expect.objectContaining({ reserved: 10_000, state: "held" }),
    ]);
  });

  it("is expired at or after the key's validity, whether or not the key is held", async () => {
    const stub = account();
    const now = Date.now();
    const late = reservation({ validUntil: now - 1 });
    expect(await stub.reserveCiMinutes(late)).toEqual({ status: "expired" });
    expect(await rowOf(stub, late.key)).toEqual([]);
    const held = reservation();
    expect((await stub.reserveCiMinutes(held)).status).toBe("granted");
    vi.setSystemTime(held.validUntil);
    expect(await stub.reserveCiMinutes(held)).toEqual({ status: "expired" });
    expect(await rowOf(stub, held.key)).toEqual([expect.objectContaining({ state: "held" })]);
  });
});

describe("settling and releasing CI minutes", () => {
  it("settles once, at the minutes run and never above the hold", async () => {
    const stub = account();
    const req = reservation({ minutes: 100 });
    await stub.reserveCiMinutes(req);
    expect(await stub.settleCiMinutes(req.key, 30 * MINUTE + 1)).toBe("settled");
    expect(await stub.settleCiMinutes(req.key, 90 * MINUTE)).toBe("duplicate");
    expect(await rowOf(stub, req.key)).toEqual([
      expect.objectContaining({ reserved: 100, used: 31, state: "settled" }),
    ]);
    const over = reservation({ minutes: 10 });
    await stub.reserveCiMinutes(over);
    expect(await stub.settleCiMinutes(over.key, 50 * MINUTE)).toBe("settled");
    expect(await rowOf(stub, over.key)).toEqual([expect.objectContaining({ used: 10 })]);
    // 31 + 10 used: 1,959 fit.
    expect((await stub.reserveCiMinutes(reservation({ minutes: 1_960 }))).status).toBe("refused");
    expect((await stub.reserveCiMinutes(reservation({ minutes: 1_959 }))).status).toBe("granted");
  });

  it("releases a hold to nothing, once; a settled key stays settled", async () => {
    const stub = account();
    const req = reservation({ minutes: 1_500 });
    await stub.reserveCiMinutes(req);
    expect(await stub.releaseCiMinutes(req.key)).toBe("released");
    expect(await stub.releaseCiMinutes(req.key)).toBe("released");
    expect(await stub.settleCiMinutes(req.key, MINUTE)).toBe("released");
    expect((await stub.reserveCiMinutes(reservation({ minutes: 2_000 }))).status).toBe("granted");
    const settled = reservation({ minutes: 0, agentId: uniqueId("agt") });
    await stub.reserveCiMinutes(settled);
    await stub.settleCiMinutes(settled.key, 0);
    expect(await stub.releaseCiMinutes(settled.key)).toBe("settled");
  });

  it("released before it was reserved: a tombstone the later reserve is answered with", async () => {
    const stub = account();
    const req = reservation();
    expect(await stub.releaseCiMinutes(req.key)).toBe("released");
    expect(await stub.reserveCiMinutes(req)).toEqual({ status: "released" });
    expect(await rowOf(stub, req.key)).toEqual([
      expect.objectContaining({ state: "released", reserved: 0, used: 0 }),
    ]);
    expect(await stub.settleCiMinutes(uniqueId("never"), MINUTE)).toBe("unknown");
  });

  it("counts a hold past its settlement time as used: refused until the month resets", async () => {
    const stub = account();
    const now = Date.now();
    await stub.reserveCiMinutes(reservation({ minutes: 1_950, settleBy: now + HOUR }));
    vi.setSystemTime(now + HOUR);
    const refused = await stub.reserveCiMinutes(reservation({ minutes: 51 }));
    expect(refused).toMatchObject({
      status: "refused",
      reason: "account",
      resetsAt: Date.UTC(2031, 3, 1),
    });
    // It never lapses to nothing: still counted later on.
    vi.setSystemTime(now + 3 * HOUR);
    expect((await stub.reserveCiMinutes(reservation({ minutes: 51 }))).status).toBe("refused");
  });
});
