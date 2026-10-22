// Audiences past what an event carries: the repository keeps the further
// recipients as pages, frozen with the event, and the event names them in
// a manifest; the feed sink delivers each page as an effect of its own,
// read from the repository only while the event is still its, before the
// deadline, and as the manifest says; pages go a day after the deadline.
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import {
  type DomainEvent,
  eventKey,
  FEED_HORIZON_MS,
  type FeedBlock,
  MAX_FEED_AUDIENCE,
} from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { FEED_PAGE_GRACE_MS } from "../src/do/repo/feed.js";
import type { UserDO } from "../src/do/UserDO.js";
import { deliverEffects, invocationBudget } from "../src/effects/dispatcher.js";
import { effectCalls, INLINE_RECIPIENTS } from "../src/effects/journal.js";
import { FEED_CALLS_IN_FLIGHT, feedSink } from "../src/feed/sink.js";
import { applyEnvelope } from "../src/queues/events-consumer.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { recordingPublish } from "./helpers/effects.js";
import { inRepo } from "./helpers/repo-git.js";

let owner: Who;
let repo: { id: string; name: string };
let path: string;

const stub = () => env.REPO.getByName(repo.id);
const fake = (i: number) => `usr_page${uniqueId("p").slice(-6)}${String(i).padStart(4, "0")}`;
let names: string[] = [];

/** The outbox's events since `from` that carry a feed block. */
const fed = async (from = 0) =>
  (
    await inRepo(stub(), (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ event: string }>(
          "SELECT event FROM outbox WHERE source_seq > ? ORDER BY source_seq",
          from,
        )
        .toArray()
        .map((row) => JSON.parse(row.event) as DomainEvent),
    )
  ).filter((e) => e.feed);
const seq = () =>
  inRepo(
    stub(),
    (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ s: number | null }>("SELECT max(source_seq) AS s FROM outbox")
        .one().s ?? 0,
  );
const pageRows = () =>
  inRepo(stub(), (r: RepoDO) =>
    r.git.context.storage.sql
      .exec<{ event_key: string; page: number; bytes: number; expires_at: number }>(
        "SELECT event_key, page, bytes, expires_at FROM feed_audience_pages ORDER BY event_key, page",
      )
      .toArray(),
  );

/** Gives issue 1 `n` participants who read the repository (its object holds it public). */
async function participants(n: number) {
  names = Array.from({ length: n }, (_, i) => fake(i));
  await inRepo(stub(), (r: RepoDO) => {
    const sql = r.git.context.storage.sql;
    sql.exec("UPDATE repo_meta SET visibility = 'public'");
    const { next_seq } = sql
      .exec<{ next_seq: number }>("SELECT next_seq FROM feed_participation WHERE number = 1")
      .one();
    for (const [i, name] of names.entries())
      sql.exec(
        `INSERT INTO feed_participants (number, principal, root, reason, joined_seq)
         VALUES (1, ?1, ?1, 'commenter', ?2)`,
        name,
        next_seq + i,
      );
    sql.exec(
      "UPDATE feed_participation SET participants = participants + ?1, next_seq = ?2 WHERE number = 1",
      n,
      next_seq + n,
    );
  });
}

/** Comments on issue 1 as the owner; the event that tells feeds of it. */
async function commentEvent(): Promise<DomainEvent> {
  const from = await seq();
  expect(
    (await api("POST", `${path}/issues/1/comments`, owner.token, { body: "Hello all" })).status,
  ).toBe(201);
  const [event] = await fed(from);
  if (!event) throw new Error("the comment told no feed");
  return event;
}

/** Journals the event's feed effects and delivers them as the feed queue would, at `now`. */
async function deliver(event: DomainEvent, now = Date.now(), metrics?: Metrics, via: Env = env) {
  const { publish, sent } = recordingPublish();
  await applyEnvelope(
    env,
    { sourceId: repo.id, events: [event] },
    { sinks: [feedSink], publish, inline: { batched: 0 }, now: () => now },
  );
  for (let next = sent.shift(); next; next = sent.shift())
    await deliverEffects(
      {
        db: env.ORG_READ,
        env: via,
        sinks: [feedSink],
        now: () => now,
        publish,
        ...(metrics && { metrics }),
      },
      next.sink,
      next.ids,
      invocationBudget(now),
    );
}

const effects = async () =>
  (
    await env.ORG_READ.prepare(
      "SELECT target, state, last_error FROM effects WHERE effect_id LIKE ? ORDER BY target",
    )
      .bind(`${repo.id}:%`)
      .all<{ target: string; state: string; last_error: string | null }>()
  ).results;

const items = async (principal: string) => {
  const page = await env.USER.getByName(principal).listFeed(null, 100, {});
  if (page.expired) throw new Error("expired");
  return page.items.filter((i) => i.repoId === repo.id).map((i) => i.threadKey);
};

beforeEach(async () => {
  owner = await user();
  repo = (
    await json<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    )
  ).body;
  path = `/repos/${owner.handle}/${repo.name}`;
  expect((await api("POST", `${path}/issues`, owner.token, { title: "Busy" })).status).toBe(201);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("audience pages", () => {
  it("keep the recipients past those an event carries, frozen with it, named in its manifest", async () => {
    await participants(250);
    const event = await commentEvent();
    const block = event.feed as FeedBlock;
    expect(block.audience).toHaveLength(MAX_FEED_AUDIENCE);
    expect(block.audience.map((a) => a.principal)).toEqual(names.slice(0, 100));
    expect(block.pages?.map((p) => [p.n, p.count])).toEqual([
      [1, 100],
      [2, 50],
    ]);
    expect(block.deadline).toBe(event.at + FEED_HORIZON_MS);
    const rows = await pageRows();
    expect(rows.map((r) => [r.event_key, r.page, r.bytes])).toEqual(
      (block.pages ?? []).map((p) => [eventKey(event.id), p.n, p.bytes]),
    );
    expect(
      rows.every((r) => r.expires_at === (block.deadline as number) + FEED_PAGE_GRACE_MS),
    ).toBe(true);
    const page = await stub().feedAudiencePage({
      eventKey: eventKey(event.id),
      page: 2,
      epochGen: event.id.epochGen,
      ownerGen: event.ownerGen,
    });
    expect("recipients" in page && page.recipients.map((r) => r.principal)).toEqual(
      names.slice(200),
    );
  });

  it("carry no manifest for an audience that fits the event", async () => {
    await participants(99);
    const event = await commentEvent();
    expect(event.feed?.pages).toBeUndefined();
    expect(event.feed?.deadline).toBeUndefined();
    expect(await pageRows()).toEqual([]);
  });

  it("reach every recipient once, each page an effect of its own, a repeat adding nothing", async () => {
    await participants(250);
    const event = await commentEvent();
    await deliver(event);
    expect((await effects()).map((e) => [e.target, e.state])).toEqual([
      ["feed", "done"],
      ["page:1", "done"],
      ["page:2", "done"],
    ]);
    for (const name of [names[0], names[150], names[249]] as string[])
      expect(await items(name)).toEqual(["issue/1"]);
    // The envelope delivered again: no effect more, nothing told twice.
    await deliver(event);
    expect(await effects()).toHaveLength(3);
    expect(await items(names[249] as string)).toEqual(["issue/1"]);
  });

  it("time a delivery's page reads and its calls to feeds (`feed.stage_ms`)", async () => {
    await participants(150);
    const event = await commentEvent();
    const points: { stage: string; ms: number }[] = [];
    const metrics = {
      count(name: string, dimensions: Record<string, string>, value = 1) {
        if (name === "feed.stage_ms") points.push({ stage: dimensions.stage ?? "", ms: value });
      },
    } as unknown as Metrics;
    await deliver(event, Date.now(), metrics);
    // Delivered together: its page read, then the calls to every recipient's feed.
    expect(points.map((p) => p.stage)).toEqual(["pages", "calls"]);
    expect(points.every((p) => p.ms >= 0)).toBe(true);
  });

  it("keep up to 32 calls to feeds under way at once, one slow call holding up no other", async () => {
    await participants(150);
    const event = await commentEvent();
    let inFlight = 0;
    let most = 0;
    let slow: () => void = () => {};
    let first = true;
    let doneMeanwhile = 0;
    const counting = {
      ...env,
      USER: {
        getByName: (name: string) => ({
          applyFeed: async (...args: Parameters<DurableObjectStub<UserDO>["applyFeed"]>) => {
            inFlight++;
            most = Math.max(most, inFlight);
            try {
              // The first call waits until every other has ended (lockstep rounds never would).
              if (first) {
                first = false;
                await new Promise<void>((resolve) => {
                  slow = resolve;
                });
              }
              const result = await env.USER.getByName(name).applyFeed(...args);
              doneMeanwhile++;
              if (doneMeanwhile === 149) slow();
              return result;
            } finally {
              inFlight--;
            }
          },
        }),
      },
    } as unknown as Env;
    await deliver(event, Date.now(), undefined, counting);
    expect(most).toBe(FEED_CALLS_IN_FLIGHT);
    expect(FEED_CALLS_IN_FLIGHT).toBe(32);
    expect(doneMeanwhile).toBe(150);
    for (const name of [names[0], names[149]] as string[])
      expect(await items(name)).toEqual(["issue/1"]);
  });

  it("count a page's recipients in the calls its effect makes", () => {
    const [, page] = feedSink.plan({
      id: { sourceId: "rep_x", epochGen: 1, sourceSeq: 1 },
      type: "issue_comment.created",
      at: 1,
      actor: null,
      actChain: [],
      ownerGen: 1,
      entity: null,
      data: null,
      stored: false,
      feed: {
        threadKey: "issue/1",
        subject: { kind: "issue", number: 1, title: "T", version: 1 },
        action: "comment",
        actorRoot: null,
        actorTrust: "write",
        member: null,
        excerpt: null,
        audience: [
          {
            principal: "usr_a",
            kind: "activity",
            reasons: ["commenter"],
            priority: "P1",
            state: "open",
            silent: false,
          },
        ],
        pages: [{ n: 1, count: 37, bytes: 5_000 }],
        deadline: 2,
      },
    });
    expect(page?.target).toBe("page:1");
    expect(effectCalls(feedSink, page as NonNullable<typeof page>)).toBe(38);
  });

  describe("are read only while the event is the repository's", () => {
    let event: DomainEvent;
    const ask = (page = 1) =>
      stub().feedAudiencePage({
        eventKey: eventKey(event.id),
        page,
        epochGen: event.id.epochGen,
        ownerGen: event.ownerGen,
      });
    beforeEach(async () => {
      await participants(150);
      event = await commentEvent();
      expect(await ask()).toMatchObject({ recipients: expect.any(Array) });
    });

    it("not for a page it never kept", async () => {
      expect(await ask(2)).toEqual({ missing: "absent" });
    });

    it("not once it is transferred", async () => {
      // As a transfer's landing leaves it: the next ownership generation.
      await inRepo(stub(), (r: RepoDO) =>
        r.git.context.storage.sql.exec(
          "UPDATE repo_meta SET owner_gen = owner_gen + 1 WHERE id = 1",
        ),
      );
      expect(await ask()).toEqual({ missing: "transferred" });
    });

    it("not once a restore gave it a newer generation, its object starting cold", async () => {
      // The restore runbook takes the next generation in the directory; the restored object
      // (its storage as it was) learns of it when it next starts.
      await env.DIRECTORY.prepare(
        "UPDATE source_epochs SET epoch_gen = epoch_gen + 1 WHERE source_id = ?",
      )
        .bind(repo.id)
        .run();
      await evictDurableObject(stub());
      expect(await ask()).toEqual({ missing: "restored" });
    });

    it("not once it is deleted", async () => {
      expect((await api("DELETE", `/repos/${owner.handle}/${repo.name}`, owner.token)).status).toBe(
        200,
      );
      expect(await ask()).toEqual({ missing: "deleted" });
    });
  });

  it("fail a page that could not be read, to be tried again", async () => {
    await participants(150);
    const event = await commentEvent();
    const { publish, sent } = recordingPublish();
    // Its repository object cannot answer for now (the feeds still can).
    const unavailable = {
      ...env,
      REPO: {
        getByName: () => ({
          feedAudiencePage: async () => {
            throw new Error("repository object overloaded");
          },
        }),
      },
    } as unknown as Env;
    const now = Date.now();
    await applyEnvelope(
      unavailable,
      { sourceId: repo.id, events: [event] },
      { sinks: [feedSink], publish, inline: { batched: 0 }, now: () => now },
    );
    // The first messages only: a retry goes out again, delayed, for later.
    for (const next of sent.splice(0))
      await deliverEffects(
        { db: env.ORG_READ, env: unavailable, sinks: [feedSink], now: () => now, publish },
        next.sink,
        next.ids,
        invocationBudget(now),
      );
    expect((await effects()).find((e) => e.target === "page:1")).toMatchObject({
      state: "pending",
      last_error: "repository object overloaded",
    });
  });

  it("end a page whose repository moved on, and one past its deadline, without delivering it", async () => {
    await participants(150);
    const event = await commentEvent();
    // Past the deadline: ended without reading the page.
    await deliver(event, (event.feed?.deadline as number) + 1);
    const rows = await effects();
    expect(rows.find((e) => e.target === "page:1")).toMatchObject({
      state: "failed",
      last_error: expect.stringMatching(/^expired: /),
    });
    expect(await items(names[120] as string)).toEqual([]);
  });

  it("end a page the repository no longer holds, apart from the pages it does", async () => {
    await participants(250);
    const event = await commentEvent();
    await inRepo(stub(), (r: RepoDO) =>
      r.git.context.storage.sql.exec("DELETE FROM feed_audience_pages WHERE page = 1"),
    );
    await deliver(event);
    const rows = await effects();
    expect(rows.map((e) => [e.target, e.state])).toEqual([
      ["feed", "done"],
      ["page:1", "failed"],
      ["page:2", "done"],
    ]);
    expect(rows.find((e) => e.target === "page:1")?.last_error).toMatch(/^page missing: absent/);
    expect(await items(names[249] as string)).toEqual(["issue/1"]);
    expect(await items(names[150] as string)).toEqual([]);
  });

  it("go a day after their deadline, by a job the alarm runs with nothing else happening", async () => {
    await participants(150);
    const event = await commentEvent();
    const expiresAt = (event.feed?.deadline as number) + FEED_PAGE_GRACE_MS;
    const job = () =>
      inRepo(stub(), (r: RepoDO) =>
        r.git.context.storage.sql
          .exec<{ state: string; next_run_at: number }>(
            "SELECT state, next_run_at FROM jobs WHERE kind = 'feed_pages_prune'",
          )
          .toArray(),
      );
    expect(await job()).toEqual([{ state: "queued", next_run_at: expiresAt }]);
    // Time passes: the page's time, and the job's, are up.
    await inRepo(stub(), (r: RepoDO) => {
      const sql = r.git.context.storage.sql;
      sql.exec("UPDATE feed_audience_pages SET expires_at = 1");
      sql.exec("UPDATE jobs SET next_run_at = 1 WHERE kind = 'feed_pages_prune'");
    });
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await pageRows()).toEqual([]);
    expect((await job()).map((j) => j.state)).toEqual(["done"]);
  });

  it("are pruned a bounded slice at a time, the oldest first", async () => {
    await participants(150);
    await commentEvent();
    const slices = await inRepo(stub(), (r: RepoDO) => {
      const sql = r.git.context.storage.sql;
      for (let i = 0; i < 12; i++)
        sql.exec(
          `INSERT INTO feed_audience_pages (event_key, page, epoch_gen, owner_gen, recipients,
             bytes, expires_at) VALUES (?, 1, 1, 1, '[]', 2, ?)`,
          `x:1:${i + 1}`,
          100 + i,
        );
      return [r.feed.prunePages(200, 10), r.feed.prunePages(200, 10)];
    });
    const [real] = await pageRows();
    expect(slices).toEqual([
      { pruned: 10, nextAt: 110 },
      { pruned: 2, nextAt: real?.expires_at },
    ]);
  });

  describe("delivered by the events consumer itself", () => {
    /** Applies the comment's envelope as the events consumer would; the effects it sent on. */
    async function applied(event: DomainEvent, recipients?: number) {
      const { publish, sent } = recordingPublish();
      const now = Date.now();
      await applyEnvelope(
        env,
        { sourceId: repo.id, events: [event] },
        {
          publish,
          now: () => now,
          ...(recipients !== undefined && { inline: { batched: 8, recipients } }),
        },
      );
      return sent.filter((m) => m.sink === feedSink.name).flatMap((m) => m.ids);
    }

    it("only when its recipients fit the invocation's share, and never its pages", async () => {
      expect(INLINE_RECIPIENTS).toBe(50);
      await participants(250);
      const sent = await applied(await commentEvent());
      // 100 carried: past the share, so queued, as every page is.
      expect(sent.map((id) => id.slice(id.indexOf(":feed:") + 6))).toEqual([
        "feed",
        "page:1",
        "page:2",
      ]);
      expect((await effects()).every((e) => e.state === "pending")).toBe(true);
    });

    it("never its pages, whatever the share", async () => {
      await participants(250);
      const sent = await applied(await commentEvent(), 900);
      expect(sent.map((id) => id.slice(id.indexOf(":feed:") + 6))).toEqual(["page:1", "page:2"]);
      expect((await effects()).find((e) => e.target === "feed")?.state).toBe("done");
    });

    it("a small audience at once, sparing it a queue's wait", async () => {
      await participants(INLINE_RECIPIENTS - 1);
      expect(await applied(await commentEvent())).toEqual([]);
      expect((await effects()).map((e) => [e.target, e.state])).toEqual([["feed", "done"]]);
      expect(await items(names[0] as string)).toEqual(["issue/1"]);
    });
  });
});
