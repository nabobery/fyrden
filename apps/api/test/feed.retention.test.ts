// The activity feed's retention: items and tombstones past 7 days and
// items past the cap are deleted in an alarm, and the low watermark
// expires cursors below what went.

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it, vi } from "vitest";
import type { UserDO } from "../src/do/UserDO.js";
import { FEED_POLICY } from "../src/do/user/feed.js";
import { DAY, entry, feedIn } from "./helpers/feed.js";

describe("retention", () => {
  it("deletes items past 7 days in an alarm, and expires cursors below the low watermark", async () => {
    const stub = env.USER.getByName(uniqueId("usr"));
    const t0 = Date.now();
    await stub.applyFeed([entry({ thread: 1, version: 1 })]);
    const alarm = await runInDurableObject(stub, (_: UserDO, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThanOrEqual(t0 + FEED_POLICY.retentionMs);
    const before = await stub.listFeed(null, 50, {});
    if (before.expired) throw new Error("expired");
    vi.setSystemTime(t0 + 3 * DAY);
    await stub.applyFeed([entry({ thread: 2, version: 1 })]);
    vi.setSystemTime(t0 + FEED_POLICY.retentionMs + 1_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const after = await stub.listFeed(null, 50, {});
    expect(after).toMatchObject({ items: [{ threadKey: "pull/2" }] });
    // A cursor before what retention deleted has missed it.
    expect(await stub.listFeed({ ...before.head, seq: 0 }, 50, {})).toEqual({ expired: true });
    expect(await stub.listFeed(before.head, 50, {})).toMatchObject({ expired: false });
    // The next alarm is when the remaining item expires.
    const next = await runInDurableObject(stub, (_: UserDO, state) => state.storage.getAlarm());
    expect(next).toBeGreaterThanOrEqual(t0 + 3 * DAY + FEED_POLICY.retentionMs);
  });

  it("deletes tombstones on the same clock", async () => {
    const stub = env.USER.getByName(uniqueId("usr"));
    const t0 = Date.now();
    await stub.applyFeed([entry({ kind: "approved", version: 2, state: "resolved" })]);
    const tombstones = () =>
      runInDurableObject(stub, (_: UserDO, state) =>
        state.storage.sql.exec("SELECT version FROM feed_items WHERE feed_seq IS NULL").toArray(),
      );
    expect(await tombstones()).toEqual([{ version: 2 }]);
    const alarm = await runInDurableObject(stub, (_: UserDO, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThanOrEqual(t0 + FEED_POLICY.retentionMs);
    vi.setSystemTime(t0 + FEED_POLICY.retentionMs + 1_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await tombstones()).toEqual([]);
    // Nothing shown was deleted: cursors stay good.
    expect(
      await stub.listFeed({ epoch: (await stub.syncFeed(null, 1, null)).epoch, seq: 0 }, 50, {}),
    ).toMatchObject({ expired: false, items: [] });
    expect(await runInDurableObject(stub, (_: UserDO, state) => state.storage.getAlarm())).toBe(
      null,
    );
  });

  it("trims a feed past its cap, the items changed longest ago first", async () => {
    const stub = env.USER.getByName(uniqueId("usr"));
    const count = FEED_POLICY.maxItems + 3;
    await runInDurableObject(stub, (_: UserDO, state) => {
      const { apply } = feedIn(state.storage);
      apply(Array.from({ length: count }, (_, i) => entry({ thread: i + 1, version: 1 })));
    });
    await stub.applyFeed([entry({ thread: 1, version: 2 })]);
    // Past the cap: retention is due at once.
    const alarm = await runInDurableObject(stub, (_: UserDO, state) => state.storage.getAlarm());
    expect(alarm).toBeLessThanOrEqual(Date.now());
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const meta = await runInDurableObject(stub, (_: UserDO, state) =>
      state.storage.sql
        .exec<{ items: number; low_watermark: number; n: number }>(
          "SELECT items, low_watermark, (SELECT count(*) FROM feed_items) AS n FROM feed_meta",
        )
        .one(),
    );
    // Threads 2-4 went (thread 1 changed last); the cursor after them is still good.
    expect(meta).toEqual({
      items: FEED_POLICY.maxItems,
      low_watermark: 4,
      n: FEED_POLICY.maxItems,
    });
    const page = await stub.listFeed(null, 1, {});
    expect(page).toMatchObject({ items: [{ threadKey: "pull/5" }] });
  });
});
