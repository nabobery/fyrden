// Discretionary work: watched entries ride an effect of their own, admitted
// at journaling against the deployment's daily allowance (priced for their
// whole life, by the database's hour), delivered once within their window,
// and reported to every feed reader while a refusal may have left
// something out.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  createIdFactory,
  type DomainEvent,
  type Envelope,
  FEED_HORIZON_MS,
  type FeedBlock,
  type FeedEntry,
  type FeedRecipient,
  secureRandomBytes,
} from "@fyrden/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { feedHooks, type UserDO } from "../src/do/UserDO.js";
import { FEED_POLICY, Feed } from "../src/do/user/feed.js";
import {
  DISCRETIONARY_WINDOW_MS,
  deliveryState,
  forgetDeliveryState,
} from "../src/effects/discretionary.js";
import { deliverEffects, invocationBudget, recoverEffects } from "../src/effects/dispatcher.js";
import { MESSAGE_CALLS, type PlannedEffect } from "../src/effects/journal.js";
import { feedSink, WATCH_PRICE, watchPrice } from "../src/feed/sink.js";
import { applyEnvelope } from "../src/queues/events-consumer.js";
import { recordingPublish } from "./helpers/effects.js";
import { entry as byHand, countingExec } from "./helpers/feed.js";

const newId = createIdFactory(Date.now, secureRandomBytes);
const OWNER = "usr_01K742SG00NAWD8WB4RTMJF8H9";
const DAY = 24 * 60 * 60 * 1000;

async function listedRepo(): Promise<string> {
  const id = newId("rep");
  await env.DIRECTORY.prepare(
    "INSERT INTO principals (id, type, handle, created_at) VALUES (?, 'user', 'watch-owner', 0) ON CONFLICT DO NOTHING",
  )
    .bind(OWNER)
    .run();
  await env.DIRECTORY.prepare(
    `INSERT INTO repos (id, owner_id, name, network_id, org_shard, visibility, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'default', 'private', 0, 0)`,
  )
    .bind(id, OWNER, id.toLowerCase(), newId("net"))
    .run();
  return id;
}

const recipient = (principal: string, priority: "P1" | "P2"): FeedRecipient => ({
  principal,
  kind: "activity",
  reasons: [priority === "P2" ? "watching" : "commenter"],
  priority,
  state: "open",
  silent: false,
});

/** A comment on pull 1 telling `told` (P1) and its `watchers` (P2). */
function block(version: number, told: readonly string[], watchers: readonly string[]): FeedBlock {
  return {
    threadKey: "pull/1",
    subject: { kind: "pull", number: 1, title: "A pull request", version },
    action: "comment",
    actorRoot: OWNER,
    actorTrust: "write",
    member: `comment/${version}`,
    excerpt: null,
    audience: told.map((p) => recipient(p, "P1")),
    ...(watchers.length > 0 && { watchers: watchers.map((p) => recipient(p, "P2")) }),
  };
}

function event(repoId: string, seq: number, feed: FeedBlock): DomainEvent {
  return {
    id: { sourceId: repoId, epochGen: 1, sourceSeq: seq },
    type: "issue_comment.created",
    at: Date.now(),
    actor: OWNER,
    actChain: [],
    ownerGen: 1,
    entity: null,
    data: null,
    stored: false,
    feed,
  };
}

const envelope = (repoId: string, events: DomainEvent[]): Envelope => ({
  sourceId: repoId,
  events,
});

/** Feeds recording each call; `vars` the deployment's (its plan and allowance). */
function deployment(vars: Record<string, string>, failing = new Set<string>()) {
  const calls: { principal: string; entries: FeedEntry[] }[] = [];
  const on = {
    ...env,
    ...vars,
    USER: {
      getByName: (principal: string) => ({
        applyFeed: async (entries: FeedEntry[]) => {
          calls.push({ principal, entries });
          if (failing.has(principal)) throw new Error(`${principal} is down`);
          return { changed: entries.length, notified: entries.length };
        },
      }),
    },
  } as unknown as Env;
  const told = () => calls.flatMap((c) => c.entries.map((e) => `${c.principal} ${e.eventKey}`));
  return { on, calls, told };
}

type EffectRow = {
  effect_id: string;
  state: string;
  attempts: number;
  max_attempts: number | null;
  deliver_until: number | null;
  last_error: string | null;
  created_at: number;
};

async function effects(repoId: string): Promise<EffectRow[]> {
  const { results } = await env.ORG_READ.prepare(
    `SELECT effect_id, state, attempts, max_attempts, deliver_until, last_error, created_at
     FROM effects WHERE effect_id LIKE ? ORDER BY effect_id`,
  )
    .bind(`${repoId}:%`)
    .all<EffectRow>();
  return results;
}

const state = () =>
  env.ORG_READ.prepare("SELECT refused_day, warn_until FROM discretionary_state").first<{
    refused_day: number;
    warn_until: number;
  }>();
const granted = async () =>
  (await env.ORG_READ.prepare(
    "SELECT coalesce(sum(granted), 0) AS n, coalesce(sum(do_requests), 0) AS requests FROM discretionary_hours",
  ).first<{ n: number; requests: number }>()) ?? { n: 0, requests: 0 };

/** The database's own clock (admission's), in UTC days and hours since the epoch. */
const clock = async () =>
  (await env.ORG_READ.prepare(
    "SELECT CAST(unixepoch() / 86400 AS INTEGER) AS day, CAST(unixepoch() / 3600 AS INTEGER) AS hour",
  ).first<{ day: number; hour: number }>()) as { day: number; hour: number };

beforeEach(async () => {
  await env.ORG_READ.batch([
    env.ORG_READ.prepare("DELETE FROM discretionary_hours"),
    env.ORG_READ.prepare("DELETE FROM discretionary_state"),
  ]);
  forgetDeliveryState();
});

describe("a watch effect", () => {
  it("is planned apart from the event's audience, priced for its watchers", () => {
    const planned = feedSink.plan(event("rep_0", 1, block(1, ["usr_p"], ["usr_w1", "usr_w2"])));
    expect(planned.map((p) => p.target)).toEqual(["feed", "watch"]);
    const [core, watch] = planned as [PlannedEffect, PlannedEffect];
    expect((core.payload.feed as FeedBlock).watchers).toBeUndefined();
    expect(core.admission).toBeUndefined();
    expect((watch.payload.feed as FeedBlock).audience.map((r) => r.principal)).toEqual([
      "usr_w1",
      "usr_w2",
    ]);
    expect(watch.admission).toEqual({
      price: watchPrice(2),
      maxAttempts: 1,
      windowMs: DISCRETIONARY_WINDOW_MS,
      warnMs: FEED_HORIZON_MS,
    });
    expect(watchPrice(2)).toMatchObject({
      do_requests: 2,
      do_rows_written: 2 * WATCH_PRICE.recipient.do_rows_written,
      queue_ops: WATCH_PRICE.effect.queue_ops,
    });
    // Watchers alone (no one else told) still make one.
    expect(feedSink.plan(event("rep_0", 2, block(2, [], ["usr_w1"]))).map((p) => p.target)).toEqual(
      ["watch"],
    );
  });
});

describe("admission", () => {
  it("journals watch effects while the day's allowance admits them; the first refusal ends the day's, core delivered throughout", async () => {
    const repoId = await listedRepo();
    const { on, told } = deployment({ FYRDEN_DISCRETIONARY_DAILY: "do_requests=3" });
    const apply = (seq: number, watchers: string[]) =>
      applyEnvelope(on, envelope(repoId, [event(repoId, seq, block(seq, ["usr_p"], watchers))]), {
        sinks: [feedSink],
      });
    await apply(1, ["usr_w1", "usr_w2"]); // 2 of 3: admitted
    await apply(2, ["usr_w3", "usr_w4"]); // 4 of 3: refused
    await apply(3, ["usr_w5"]); // 3 of 3 would fit, but the day has refused: refused
    expect(
      (await effects(repoId)).map((e) => `${e.effect_id.slice(repoId.length + 1)} ${e.state}`),
    ).toEqual([
      "1:1:feed:feed done",
      "1:1:feed:watch done",
      "1:2:feed:feed done",
      "1:3:feed:feed done",
    ]);
    expect(told()).toEqual(
      expect.arrayContaining([
        `usr_w1 ${repoId}:1:1`,
        `usr_w2 ${repoId}:1:1`,
        `usr_p ${repoId}:1:2`,
        `usr_p ${repoId}:1:3`,
      ]),
    );
    expect(told().filter((t) => /usr_w[345]/.test(t))).toEqual([]);
    expect(await granted()).toEqual({ n: 1, requests: 2 });
    // The day's refusal, and a warning until feeds no longer keep what it would have delivered.
    const { day } = await clock();
    expect(await state()).toEqual({
      refused_day: day,
      warn_until: (day + 1) * DAY + FEED_HORIZON_MS,
    });
  });

  it("counts what a later hour admitted, as a batch made before midnight and run after it finds it", async () => {
    const repoId = await listedRepo();
    const { on } = deployment({ FYRDEN_DISCRETIONARY_DAILY: "do_requests=3" });
    await env.ORG_READ.prepare(
      "INSERT INTO discretionary_hours (hour, do_requests, granted) VALUES (?, 3, 1)",
    )
      .bind((await clock()).hour + 1)
      .run();
    await applyEnvelope(on, envelope(repoId, [event(repoId, 1, block(1, [], ["usr_w1"]))]), {
      sinks: [feedSink],
    });
    expect(await effects(repoId)).toEqual([]);
    expect(await state()).toMatchObject({ refused_day: (await clock()).day });
  });

  it("counts the hour before the day's start, and not the ones before it", async () => {
    const repoId = await listedRepo();
    const { on } = deployment({ FYRDEN_DISCRETIONARY_DAILY: "do_requests=3" });
    const start = (await clock()).day * 24;
    await env.ORG_READ.prepare(
      "INSERT INTO discretionary_hours (hour, do_requests, granted) VALUES (?, 2, 1), (?, 100, 1)",
    )
      .bind(start - 1, start - 2)
      .run();
    await applyEnvelope(on, envelope(repoId, [event(repoId, 1, block(1, [], ["usr_w1"]))]), {
      sinks: [feedSink],
    });
    await applyEnvelope(on, envelope(repoId, [event(repoId, 2, block(2, [], ["usr_w2"]))]), {
      sinks: [feedSink],
    });
    // 2 + 1 fits; 2 + 1 + 1 does not.
    expect((await effects(repoId)).map((e) => e.effect_id)).toEqual([`${repoId}:1:1:feed:watch`]);
  });

  it("admits nothing again for an event delivered again", async () => {
    const repoId = await listedRepo();
    const { on, told } = deployment({ FYRDEN_DISCRETIONARY_DAILY: "do_requests=10" });
    const again = envelope(repoId, [event(repoId, 1, block(1, [], ["usr_w1", "usr_w2"]))]);
    await applyEnvelope(on, again, { sinks: [feedSink] });
    await applyEnvelope(on, again, { sinks: [feedSink] });
    expect(await granted()).toEqual({ n: 1, requests: 2 });
    expect(told()).toEqual([`usr_w1 ${repoId}:1:1`, `usr_w2 ${repoId}:1:1`]);
    expect(await state()).toBeNull();
  });

  it("admits nothing at a zero allowance, nor a price larger than a whole day's", async () => {
    const repoId = await listedRepo();
    for (const [allowance, seq] of [
      ["do_requests=0", 1],
      ["do_rows_written=10", 2],
    ] as const) {
      const { on } = deployment({ FYRDEN_DISCRETIONARY_DAILY: allowance });
      await applyEnvelope(on, envelope(repoId, [event(repoId, seq, block(seq, [], ["usr_w"]))]), {
        sinks: [feedSink],
      });
    }
    expect(await effects(repoId)).toEqual([]);
    expect(await granted()).toEqual({ n: 0, requests: 0 });
  });

  it("admits nothing for a deleted repository's events", async () => {
    const repoId = await listedRepo();
    const { on } = deployment({ FYRDEN_DISCRETIONARY_DAILY: "do_requests=10" });
    // The read model's tombstone for it.
    await env.ORG_READ.prepare(
      `INSERT INTO repos (repo_id, owner_id, name, visibility, deleted, epoch_gen, version,
         owner_gen, updated_seq, updated_at) VALUES (?, ?, 'gone', 'private', 1, 1, 1, 1, 1, 0)`,
    )
      .bind(repoId, OWNER)
      .run();
    await applyEnvelope(on, envelope(repoId, [event(repoId, 1, block(1, [], ["usr_w"]))]), {
      sinks: [feedSink],
    });
    expect(await granted()).toEqual({ n: 0, requests: 0 });
    expect(await state()).toBeNull();
  });

  it("journals them unadmitted where nothing is capped (Paid without an allowance), still once within their window", async () => {
    const repoId = await listedRepo();
    const { on } = deployment({ FYRDEN_PLAN: "paid" });
    const t0 = Date.now();
    await applyEnvelope(on, envelope(repoId, [event(repoId, 1, block(1, [], ["usr_w"]))]), {
      sinks: [feedSink],
      now: () => t0,
    });
    expect(await effects(repoId)).toMatchObject([
      { state: "done", max_attempts: 1, deliver_until: t0 + DISCRETIONARY_WINDOW_MS },
    ]);
    expect(await granted()).toEqual({ n: 0, requests: 0 });
  });
});

describe("a watch effect's delivery", () => {
  it("is never retried: a failed call ends it, its attempts spent, with no message for later", async () => {
    const repoId = await listedRepo();
    const { on, calls } = deployment({ FYRDEN_PLAN: "paid" }, new Set(["usr_w2"]));
    const { publish, sent } = recordingPublish();
    await applyEnvelope(
      on,
      envelope(repoId, [event(repoId, 1, block(1, [], ["usr_w1", "usr_w2"]))]),
      {
        sinks: [feedSink],
        publish,
      },
    );
    expect(await effects(repoId)).toMatchObject([
      { state: "failed", attempts: 1, last_error: "usr_w2 is down" },
    ]);
    expect(sent).toEqual([]);
    expect(calls.map((c) => c.principal).sort()).toEqual(["usr_w1", "usr_w2"]);
  });

  it("keeps its attempt when given back unstarted, and is ended by the cron rather than claimed again", async () => {
    const repoId = await listedRepo();
    const { on, calls } = deployment({ FYRDEN_PLAN: "paid" });
    const { publish } = recordingPublish();
    const t0 = Date.now();
    await applyEnvelope(
      on,
      envelope(repoId, [
        event(repoId, 1, block(1, [], ["usr_w1", "usr_w2"])),
        event(repoId, 2, block(2, [], ["usr_w3", "usr_w4"])),
      ]),
      { sinks: [feedSink], publish, now: () => t0, inline: { batched: 0 } },
    );
    const ids = (await effects(repoId)).map((e) => e.effect_id);
    expect(ids).toHaveLength(2);
    // An invocation with calls left for one (two recipients): both are claimed, the second given
    // back.
    const deps = { db: env.ORG_READ, env: on, sinks: [feedSink], now: () => t0, publish };
    await deliverEffects(deps, "feed", ids, {
      ...invocationBudget(t0),
      calls: MESSAGE_CALLS + 3,
      started: true,
    });
    expect(calls).toHaveLength(2);
    expect((await effects(repoId)).map((e) => [e.state, e.attempts])).toEqual([
      ["done", 1],
      ["pending", 1],
    ]);
    // Never claimed again; the cron ends it.
    await deliverEffects(deps, "feed", ids, invocationBudget(t0));
    expect(calls).toHaveLength(2);
    const later = t0 + 60 * 60 * 1000 - 1;
    await recoverEffects({ ...deps, now: () => later });
    expect((await effects(repoId))[1]).toMatchObject({
      state: "failed",
      last_error: "attempts spent",
    });
  });

  it("drops its entries past its window, ending it expired, while the same call's core entries are delivered", async () => {
    const repoId = await listedRepo();
    const { on, calls } = deployment({ FYRDEN_PLAN: "paid" });
    const { publish } = recordingPublish();
    // Journaled more than its window ago (by the dispatcher's clock, claimed just in time).
    const t0 = Date.now() - DISCRETIONARY_WINDOW_MS - 1_000;
    await applyEnvelope(on, envelope(repoId, [event(repoId, 1, block(1, ["usr_p"], ["usr_w"]))]), {
      sinks: [feedSink],
      publish,
      now: () => t0,
      inline: { batched: 0 },
    });
    const ids = (await effects(repoId)).map((e) => e.effect_id);
    await deliverEffects(
      { db: env.ORG_READ, env: on, sinks: [feedSink], now: () => t0, publish },
      "feed",
      ids,
      invocationBudget(t0),
    );
    expect(calls.map((c) => c.principal)).toEqual(["usr_p"]);
    expect(
      (await effects(repoId)).map((e) => [e.effect_id.split(":").at(-1), e.state, e.last_error]),
    ).toEqual([
      ["feed", "done", null],
      ["watch", "failed", "expired: past its admission window"],
    ]);
  });
});

describe("the delivery a feed reports", () => {
  it("is degraded while a refusal's warning lasts, the same for everyone, read at most once a minute", async () => {
    const now = Date.now();
    expect(await deliveryState(env.ORG_READ, now)).toBe("complete");
    await env.ORG_READ.prepare(
      "INSERT INTO discretionary_state (id, refused_day, warn_until) VALUES (1, ?, ?)",
    )
      .bind((await clock()).day, now + DAY)
      .run();
    // Within the minute: what the isolate read.
    expect(await deliveryState(env.ORG_READ, now + 1_000)).toBe("complete");
    expect(await deliveryState(env.ORG_READ, now + 60_000)).toBe("degraded");
    // Past the warning.
    expect(await deliveryState(env.ORG_READ, now + DAY + 60_000)).toBe("complete");
  });

  it("is read once for callers asking at once", async () => {
    let reads = 0;
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const now = Date.now();
    const db = {
      prepare: () => ({
        first: async () => {
          reads++;
          await gate;
          return { warn_until: now + DAY };
        },
      }),
    } as unknown as D1Database;
    const asking = Array.from({ length: 20 }, () => deliveryState(db, now));
    open();
    expect(await Promise.all(asking)).toEqual(Array(20).fill("degraded"));
    expect(reads).toBe(1);
  });

  it("keeps what it knew when the read fails, tries again only once the minute is past, then reads on", async () => {
    const now = Date.now();
    await env.ORG_READ.prepare(
      "INSERT INTO discretionary_state (id, refused_day, warn_until) VALUES (1, ?, ?)",
    )
      .bind((await clock()).day, now + DAY)
      .run();
    expect(await deliveryState(env.ORG_READ, now)).toBe("degraded");
    let tries = 0;
    const failing = (fails: "at once" | "later") =>
      ({
        prepare: () => {
          tries++;
          if (fails === "at once") throw new Error("D1 unavailable");
          return { first: () => Promise.reject(new Error("D1 unavailable")) };
        },
      }) as unknown as D1Database;
    expect(await deliveryState(failing("at once"), now + 60_000)).toBe("degraded");
    expect(await deliveryState(failing("later"), now + 61_000)).toBe("degraded");
    expect(await deliveryState(failing("later"), now + 119_000)).toBe("degraded");
    expect(tries).toBe(1);
    expect(await deliveryState(failing("later"), now + 120_000)).toBe("degraded");
    expect(tries).toBe(2);
    // Healthy again, past the minute: read, and the warning (since removed) is gone.
    await env.ORG_READ.prepare("DELETE FROM discretionary_state").run();
    expect(await deliveryState(env.ORG_READ, now + 180_000)).toBe("complete");
  });

  it("raises a later refusal's warning, and keeps the day's first", async () => {
    const repoId = await listedRepo();
    const { on } = deployment({ FYRDEN_DISCRETIONARY_DAILY: "do_requests=0" });
    // An earlier day's refusal, its warning ending sooner.
    await env.ORG_READ.prepare(
      "INSERT INTO discretionary_state (id, refused_day, warn_until) VALUES (1, ?, ?)",
    )
      .bind((await clock()).day - 3, ((await clock()).day - 2) * DAY + FEED_HORIZON_MS)
      .run();
    await applyEnvelope(on, envelope(repoId, [event(repoId, 1, block(1, [], ["usr_w"]))]), {
      sinks: [feedSink],
    });
    const { day } = await clock();
    expect(await state()).toEqual({
      refused_day: day,
      warn_until: (day + 1) * DAY + FEED_HORIZON_MS,
    });
  });
});

describe("a feed given watched entries", () => {
  it("drops those past their window once it is ready, answering their events, and applies the rest", async () => {
    const stub = env.USER.getByName(newId("usr"));
    const repoId = newId("rep");
    const entry = (seq: number, priority: "P1" | "P2", until?: number): FeedEntry => ({
      eventKey: `${repoId}:1:${seq}`,
      repoId,
      occurredAt: Date.now(),
      actor: OWNER,
      epochGen: 1,
      feed: {
        threadKey: `pull/${seq}`,
        subject: { kind: "pull", number: seq, title: "T", version: 1 },
        action: "comment",
        actorRoot: OWNER,
        actorTrust: "write",
        member: `comment/${seq}`,
        excerpt: null,
      },
      recipient: { ...recipient("usr_reader", priority), principal: "usr_reader" },
      ...(until !== undefined && { until }),
    });
    // Its first call waits on the directory (a cold object's epoch read) until the window passed.
    const until = Date.now() + 1_000;
    feedHooks.beforeEpochRead = async () => {
      vi.setSystemTime(until);
    };
    try {
      expect(
        await stub.applyFeed([entry(1, "P1"), entry(2, "P2", until), entry(3, "P2", until + DAY)]),
      ).toEqual({ changed: 2, notified: 2, expired: [`${repoId}:1:2`] });
    } finally {
      delete feedHooks.beforeEpochRead;
    }
    // A duplicate within its window: no change, and nothing expired.
    expect(await stub.applyFeed([entry(3, "P2", Date.now() + DAY)])).toEqual({
      changed: 0,
      notified: 0,
    });
  });

  it("writes and reads within a watched entry's price at its worst", async () => {
    const measured: { read: number; written: number }[] = [];
    const call = async (stub: DurableObjectStub<UserDO>, entries: FeedEntry[]) =>
      runInDurableObject(stub, async (instance: UserDO, state) => {
        const counting = countingExec(state.storage.sql);
        try {
          await instance.applyFeed(entries);
        } finally {
          measured.push(counting.stop());
        }
      });
    const at = (thread: number, priority: "P1" | "P2" = "P2") =>
      byHand({ version: 1, thread, priority, repoId: "rep_watched" });
    // A stream at its cap, with its fences: a new watched item evicts the oldest.
    const full = env.USER.getByName(newId("usr"));
    await full.applyFeed(
      Array.from({ length: FEED_POLICY.streamItems + FEED_POLICY.streamFences + 20 }, (_, i) =>
        at(i + 1, "P1"),
      ),
    );
    await call(full, [at(50_000)]);
    // A feed's first entry (its schema made before the call: priced apart, see `WATCH_PRICE`).
    await call(env.USER.getByName(newId("usr")), [at(1)]);
    for (const { read, written } of measured) {
      expect(read).toBeLessThanOrEqual(WATCH_PRICE.recipient.do_rows_read);
      // The alarm it may set writes a row too.
      expect(written + 1).toBeLessThanOrEqual(WATCH_PRICE.recipient.do_rows_written);
    }
    expect(measured[0]?.written).toBeGreaterThanOrEqual(10);
  });
});

/** `db`, summing the rows its statements read and write (as D1 reports them) into `rows`. */
function metered(db: D1Database, rows: { read: number; written: number }): D1Database {
  const add = (result: D1Result | undefined) => {
    rows.read += result?.meta.rows_read ?? 0;
    rows.written += result?.meta.rows_written ?? 0;
  };
  const statement = (prepared: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(prepared, {
      get(target, prop) {
        if (prop === "bind") return (...args: unknown[]) => statement(target.bind(...args));
        if (prop === "run" || prop === "all")
          return async () => {
            const result = await (target[prop] as () => Promise<D1Result>).call(target);
            add(result);
            return result;
          };
        if (prop === "first")
          return async (column?: string) => {
            const result = await target.all();
            add(result);
            const row = result.results[0] as Record<string, unknown> | undefined;
            return column === undefined ? (row ?? null) : (row?.[column] ?? null);
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (query: string) => statement(target.prepare(query));
      if (prop === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          for (const result of results) add(result);
          return results;
        };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("a watch effect's price", () => {
  it("covers its journal row's life in D1, at its worst (sent, recovered, given back, ended, pruned)", async () => {
    await env.ORG_READ.prepare("DELETE FROM effects").run();
    const t0 = Date.now();
    /** The read model's rows read and written through an event's whole life, with or without watchers. */
    const life = async (watchers: string[]) => {
      const rows = { read: 0, written: 0 };
      const db = metered(env.ORG_READ, rows);
      const repoId = await listedRepo();
      const { on } = deployment({ FYRDEN_DISCRETIONARY_DAILY: "do_requests=1000" });
      const deployed = { ...on, ORG_READ: db } as Env;
      const { publish } = recordingPublish();
      await applyEnvelope(
        deployed,
        envelope(repoId, [event(repoId, 1, block(1, ["usr_p"], watchers))]),
        { sinks: [feedSink], publish, now: () => t0, inline: { batched: 0 } },
      );
      const deps = { db, env: deployed, sinks: [feedSink], now: () => t0, publish };
      // Overdue: the cron sends it again.
      await recoverEffects({ ...deps, now: () => t0 + 20 * 60 * 1000 });
      const ids = [`${repoId}:1:1:feed:watch`, `${repoId}:1:1:feed:feed`].slice(
        watchers.length > 0 ? 0 : 1,
      );
      // Claimed with too few calls left for it: given back, keeping its attempt.
      await deliverEffects(deps, "feed", ids, {
        ...invocationBudget(t0),
        calls: MESSAGE_CALLS + 1,
        started: true,
      });
      await deliverEffects(deps, "feed", ids, invocationBudget(t0));
      // Ended by the cron, then pruned.
      await recoverEffects({ ...deps, now: () => t0 + 40 * 60 * 1000 });
      const { pruneEffects } = await import("../src/effects/dispatcher.js");
      await pruneEffects({ ...deps, now: () => t0 + 365 * DAY });
      return rows;
    };
    const without = await life([]);
    const withWatchers = await life(["usr_w1", "usr_w2"]);
    const watch = {
      read: withWatchers.read - without.read,
      written: withWatchers.written - without.written,
    };
    expect(watch.written).toBeGreaterThan(5);
    expect(watch.written).toBeLessThanOrEqual(watchPrice(2).d1_rows_written);
    expect(watch.read).toBeLessThanOrEqual(watchPrice(2).d1_rows_read - 2 * 2);
  });

  it("covers its item's later deletion in a feed", async () => {
    const stub = env.USER.getByName(newId("usr"));
    const count = 200;
    const t0 = Date.now();
    await stub.applyFeed(
      Array.from({ length: count }, (_, i) =>
        byHand({ version: 1, thread: i + 1, priority: "P2", repoId: "rep_gone", occurredAt: t0 }),
      ),
    );
    const deleted = await runInDurableObject(stub, (_: UserDO, state) => {
      const feed = new Feed(state.storage.sql, () => t0 + FEED_POLICY.retentionMs + 1);
      const counting = countingExec(state.storage.sql);
      while (state.storage.transactionSync(() => feed.retainStep()));
      return counting.stop();
    });
    // The rest of a recipient's price: its call at its worst (measured above) and the alarm.
    expect(Math.ceil(deleted.written / count)).toBeLessThanOrEqual(
      WATCH_PRICE.recipient.do_rows_written - 15 - 1,
    );
    expect(Math.ceil(deleted.read / count)).toBeLessThanOrEqual(
      WATCH_PRICE.recipient.do_rows_read - 122,
    );
  });
});
