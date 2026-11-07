// What a hint costs a feed: sockets held for hours as a browser holds them
// (renewing, acknowledging), a mention an hour reaching them through the
// repository's real path, the turns counted against the same hours with no
// mention. The ledger's clock moves with the test's, so blocks and turns
// expire as they would. Every wait is on the feed's own state; time moves only
// when a step here moves it.

import {
  createExecutionContext,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { DomainEvent } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { RepoDO } from "../src/do/RepoDO.js";
import { feedHooks, type UserDO } from "../src/do/UserDO.js";
import { expireLiveReceipts, type LiveEnvelope } from "../src/live/budget.js";
import { applyEnvelope } from "../src/queues/events-consumer.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { countingExec } from "./helpers/feed.js";
import { clockedD1, DAY } from "./helpers/live-budget.js";
import { say } from "./helpers/live-sockets.js";
import { scopedToken } from "./helpers/principals.js";
import { inRepo } from "./helpers/repo-git.js";

const ORIGIN = "https://fyrden.test";
const HOUR = 3_600_000;
const RENEW_BEFORE = 90_000;

const resetLedger = () =>
  env.DIRECTORY.batch([
    env.DIRECTORY.prepare("DELETE FROM live_socket_deps"),
    env.DIRECTORY.prepare("DELETE FROM live_sockets"),
    env.DIRECTORY.prepare("DELETE FROM live_budget_days"),
    env.DIRECTORY.prepare("DELETE FROM live_budget_receipts"),
    env.DIRECTORY.prepare("DELETE FROM live_recovery_targets"),
    env.DIRECTORY.prepare(
      `UPDATE live_budget_state SET debt_do_requests = 0, debt_do_rows_read = 0,
         debt_do_rows_written = 0, debt_do_duration_ms = 0, debt_d1_rows_read = 0,
         debt_d1_rows_written = 0, debt_queue_ops = 0 WHERE id = 1`,
    ),
  ]);

afterEach(async () => {
  vi.useRealTimers();
  delete feedHooks.turnStep;
  await resetLedger();
});

type Rows = { read: number; written: number; d1Read: number; d1Written: number };
type Turn = { at: number; kind: string; steps: string[]; rows: Rows };

/** The rows `who`'s feed's object and its invocations read and wrote while `fn` ran. */
async function rows(who: Who, fn: () => Promise<unknown>): Promise<Rows> {
  const sql = await runInDurableObject(
    env.USER.getByName(who.principalId),
    (_: UserDO, state) => state.storage.sql,
  );
  const dataset = env.METRICS as unknown as { writeDataPoint: (point: unknown) => void };
  const write = dataset.writeDataPoint;
  const d1 = { d1Read: 0, d1Written: 0 };
  dataset.writeDataPoint = (point: unknown) => {
    const p = point as { indexes?: string[]; blobs?: string[]; doubles?: number[] };
    if (p.indexes?.[0] === "d1.invocation_rows") {
      if (p.blobs?.[2] === "read") d1.d1Read += p.doubles?.[0] ?? 0;
      if (p.blobs?.[2] === "written") d1.d1Written += p.doubles?.[0] ?? 0;
    }
    write.call(dataset, point);
  };
  const count = countingExec(sql);
  try {
    await fn();
  } finally {
    dataset.writeDataPoint = write;
  }
  return { ...count.stop(), ...d1 };
}

/** A held feed's shape: its hours, minutes between mentions (0: none), its sockets' credentials. */
interface Holding {
  readonly hours: number;
  readonly everyMinutes: number;
  /** Hours from the start before the first mention (default: the next whole interval). */
  readonly firstMentionAfter?: number;
  /** One entry a socket: which of the reader's credentials it uses. */
  readonly sockets: readonly number[];
}

/** Holds a feed's sockets for its hours from 00:30 UTC, a browser's renewals and acknowledgements. */
async function hold({ hours, everyMinutes, sockets, firstMentionAfter }: Holding) {
  const ledger = { now: 0 };
  const moveTo = (at: number) => {
    vi.setSystemTime(at);
    ledger.now = at;
  };
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = (Math.floor(Date.now() / DAY) + 1) * DAY + 30 * 60_000;
  moveTo(start);

  const owner = await user();
  const reader = await user();
  const tokens = [reader.token, await scopedToken(reader.principalId, [])];
  // A test's token lasts an hour; these outlast the hours held.
  await env.DIRECTORY.prepare("UPDATE tokens SET expires_at = ? WHERE principal_id IN (?, ?)")
    .bind(start + 2 * DAY, owner.principalId, reader.principalId)
    .run();
  const repo = (
    await json<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("hint") }),
    )
  ).body;
  const path = `/repos/${owner.handle}/${repo.name}`;
  expect(
    (
      await api("PUT", `${path}/collaborators/${reader.handle}`, owner.token, {
        permission: "pull",
      })
    ).status,
  ).toBe(200);
  expect((await api("POST", `${path}/issues`, owner.token, { title: "x" })).status).toBe(201);

  const feed = env.USER.getByName(reader.principalId);
  // The feed's object on the moving ledger clock, as the Worker is below.
  await runInDurableObject(feed, (instance: UserDO) => {
    const object = instance as unknown as { env: Env };
    object.env = { ...object.env, DIRECTORY: clockedD1(object.env.DIRECTORY, ledger) };
  });
  const vars = {
    ...env,
    DIRECTORY: clockedD1(env.DIRECTORY, ledger),
    FYRDEN_LIVE: "on",
    FYRDEN_LIVE_SOCKETS: "500",
  };
  const call = async (request: Request) => {
    const ctx = createExecutionContext();
    const response = await createApp().fetch(request, vars as unknown as Env, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  };
  const locals = () =>
    runInDurableObject(feed, (_: UserDO, s) =>
      s.storage.sql
        .exec<{ socket_id: string; deadline: number; sent: number; acked: number }>(
          "SELECT socket_id, deadline, sent, acked FROM live_local",
        )
        .toArray(),
    );
  const held = new Map<string, WebSocket>();
  const frames: { t: string; refresh?: boolean }[] = [];
  for (const which of sockets) {
    const token = tokens[which] as string;
    const issued = (await (
      await call(
        new Request(`${ORIGIN}/api/notifications/live`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": crypto.randomUUID() },
        }),
      )
    ).json()) as { ticket: string };
    const before = new Set(held.keys());
    const opened = await call(
      new Request(`${ORIGIN}/api/notifications/live?ticket=${encodeURIComponent(issued.ticket)}`, {
        headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` },
      }),
    );
    const ws = opened.webSocket as WebSocket;
    ws.accept();
    ws.addEventListener("message", (event) => {
      frames.push(JSON.parse(String(event.data)) as { t: string });
    });
    const id = (await locals()).find((l) => !before.has(l.socket_id))?.socket_id as string;
    held.set(id, ws);
  }

  let steps: string[] = [];
  feedHooks.turnStep = (step) => steps.push(step);
  const state = () =>
    runInDurableObject(feed, async (_: UserDO, s) => {
      const turn = s.storage.sql
        .exec<{ envelope_json: string }>("SELECT envelope_json FROM live_turn")
        .toArray()[0];
      return {
        alarm: await s.storage.getAlarm(),
        kind: turn ? (JSON.parse(turn.envelope_json) as LiveEnvelope).plan.kind : "none",
      };
    });

  let cursor = 0;
  /** A comment from `owner` naming the reader, through the repository's real feed path. */
  const mention = async () => {
    expect(
      (
        await api("POST", `${path}/issues/1/comments`, owner.token, {
          body: `@${reader.handle} look`,
        })
      ).status,
    ).toBe(201);
    const events = await inRepo(env.REPO.getByName(repo.id), (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ event: string; source_seq: number }>(
          "SELECT event, source_seq FROM outbox WHERE source_seq > ? ORDER BY source_seq",
          cursor,
        )
        .toArray(),
    );
    cursor = events.at(-1)?.source_seq ?? cursor;
    const parsed = events.map((e) => JSON.parse(e.event) as DomainEvent);
    expect(await applyEnvelope(env, { sourceId: repo.id, events: parsed })).toBe("applied");
  };

  const end = start + hours * HOUR;
  const turns: Turn[] = [];
  let hints = 0;
  const every = everyMinutes * 60_000;
  let nextMention =
    firstMentionAfter !== undefined
      ? start + firstMentionAfter * HOUR
      : every > 0
        ? Math.ceil(start / every) * every
        : Number.POSITIVE_INFINITY;
  const asked = new Map<string, number>();
  for (;;) {
    const now = await state();
    const open = await locals();
    if (open.length !== sockets.length) throw new Error(`sockets left: ${open.length}`);
    const renewing = open
      .filter((l) => asked.get(l.socket_id) !== l.deadline)
      .sort((a, b) => a.deadline - b.deadline)[0];
    const renewAt = renewing ? renewing.deadline - RENEW_BEFORE : Number.POSITIVE_INFINITY;
    const alarm = now.alarm ?? Number.POSITIVE_INFINITY;
    const at = Math.max(Math.min(alarm, renewAt, nextMention), Date.now());
    if (at >= end) break;
    moveTo(at);
    // What the cron's maintenance does within minutes: expired receipts would close the ledger.
    await expireLiveReceipts(vars.DIRECTORY);
    if (alarm <= at) {
      steps = [];
      const used = await rows(reader, () => runDurableObjectAlarm(feed));
      if (steps.length > 0) turns.push({ at: at - start, kind: now.kind, steps, rows: used });
      for (const l of await locals())
        if (l.sent > l.acked)
          await say(reader, { ws: held.get(l.socket_id) ?? null }, { t: "ack", n: l.sent });
    } else if (renewing && renewAt <= at) {
      asked.set(renewing.socket_id, renewing.deadline);
      await say(reader, { ws: held.get(renewing.socket_id) ?? null }, { t: "renew" });
    } else {
      await mention();
      hints++;
      nextMention += every;
    }
  }
  const sent = (await locals()).map((l) => l.sent);
  for (const ws of held.values()) ws.close(1000, "done");
  return { turns, hints, sent };
}

/** The turns `everyMinutes`' mentions add to the same feed held quiet, each mention. */
async function turnsAHint(shape: Omit<Holding, "everyMinutes">, everyMinutes: number) {
  await resetLedger();
  const quiet = await hold({ ...shape, everyMinutes: 0 });
  await resetLedger();
  const busy = await hold({ ...shape, everyMinutes });
  return { ...busy, perHint: (busy.turns.length - quiet.turns.length) / busy.hints };
}

const meanD1Written = (turns: Turn[], kind: string, work: (steps: string[]) => boolean) => {
  const some = turns.filter((t) => t.kind === kind && work(t.steps));
  return some.reduce((sum, t) => sum + t.rows.d1Written, 0) / some.length;
};

// Capacity is worked out from these: a renewal turn brought due runs nothing and its pump successor
// delivers, so a change to them is a change to what a deployment can hold.
describe("a hint", () => {
  it("takes two turns of its feed's, a little more with the refills blocks expiring ask for", async () => {
    const held = await turnsAHint({ hours: 12, sockets: [0] }, 60);
    expect(held.hints).toBe(12);
    expect(held.perHint).toBeGreaterThanOrEqual(2);
    expect(held.perHint).toBeLessThanOrEqual(2.25);
    const idle = meanD1Written(held.turns, "renewal", (s) => !s.includes("renewal"));
    const pump = meanD1Written(held.turns, "pump", (s) => s.includes("delivery"));
    expect(idle + pump).toBeLessThanOrEqual(70);
    // None is lost: the change that found every mark block expired is owed as a refresh.
    expect(held.sent).toEqual([12]);
  });

  it("loses no hint past its mark block's expiry, on a feed quiet till then", async () => {
    // Hourly mentions spend a block down to its refill before it expires. Quiet, it expires at
    // 12:30 with nothing refilled: this one change, at 13:30, finds every block gone.
    const quiet = await hold({ hours: 15, everyMinutes: 0, sockets: [0] });
    await resetLedger();
    const held = await hold({
      hours: 15,
      everyMinutes: 24 * 60,
      firstMentionAfter: 13,
      sockets: [0],
    });
    expect(held.hints).toBe(1);
    expect(held.sent).toEqual([1]);
    // A refill and a delivery more than the quiet feed's: no turn loops.
    expect(held.turns.length).toBeLessThanOrEqual(quiet.turns.length + 3);
  });

  it("takes about three when its feed's sockets hold two credentials", async () => {
    // A pump serves one credential: the other's waits for the next turn.
    const held = await turnsAHint({ hours: 12, sockets: [0, 1] }, 60);
    expect(held.perHint).toBeGreaterThanOrEqual(2.5);
    expect(held.perHint).toBeLessThanOrEqual(3.25);
  });
});
