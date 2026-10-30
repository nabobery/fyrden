// The events dead-letter queue: each envelope the consumer gave up on is stored
// before its dead letter is acknowledged; a repository's asks for its search
// projections to be reconciled, an account's waits for a replay, one that cannot
// be read is quarantined with why; a deleted repository's keeps only the record;
// an envelope is dropped after its time, the record kept.
import { env } from "cloudflare:workers";
import { createIdFactory, type DomainEvent, secureRandomBytes } from "@fyrden/domain";
import { describe, expect, it, vi } from "vitest";
import {
  consumeFailedEvents,
  EVENTS_DLQ,
  FAILED_POLICY,
  jsonBytes,
  pruneFailedEvents,
} from "../src/queues/events-dlq.js";
import { admitted } from "./helpers/read-model.js";

const newId = createIdFactory(Date.now, secureRandomBytes);
// Written as production writes it: through the read model's executor.
const db = admitted();

const event = (sourceId: string, seq: number, type = "repo.updated"): DomainEvent => ({
  id: { sourceId, epochGen: 2, sourceSeq: seq },
  type,
  at: 0,
  actor: null,
  actChain: [],
  ownerGen: 1,
  entity: null,
  data: null,
  stored: false,
});

interface Letter {
  readonly id: string;
  readonly body: unknown;
  readonly ack: ReturnType<typeof vi.fn>;
  readonly retry: ReturnType<typeof vi.fn>;
}

const letter = (body: unknown): Letter => ({
  id: newId("msg" as never),
  body,
  ack: vi.fn(),
  retry: vi.fn(),
});

async function deliver(letters: Letter[], to: Env = env): Promise<void> {
  await consumeFailedEvents(
    { queue: EVENTS_DLQ, messages: letters } as unknown as MessageBatch<unknown>,
    to,
    { now: () => 1_000 },
  );
}

const stored = (id: string) =>
  db
    .prepare(
      `SELECT source_id, kind, epoch_gen, first_seq, last_seq, types, envelope, reason, at,
         expires_at FROM events_failed WHERE id = ?`,
    )
    .bind(id)
    .first<Record<string, unknown>>();

const repair = (repoId: string) =>
  db.prepare("SELECT dirty, reason FROM search_repairs WHERE repo_id = ?").bind(repoId).first();

describe("the events dead-letter queue", () => {
  it("stores a repository's envelope, asks for its search repair, then acknowledges it", async () => {
    const repoId = newId("rep");
    const envelope = {
      sourceId: repoId,
      events: [event(repoId, 7), event(repoId, 9, "issue.opened"), event(repoId, 8)],
    };
    const dead = letter(envelope);
    await deliver([dead]);
    expect(dead.ack).toHaveBeenCalledOnce();
    expect(await stored(dead.id)).toEqual({
      source_id: repoId,
      kind: "repository",
      epoch_gen: 2,
      first_seq: 7,
      last_seq: 9,
      types: '["repo.updated","issue.opened"]',
      envelope: JSON.stringify(envelope),
      reason: null,
      at: 1_000,
      expires_at: 1_000 + FAILED_POLICY.keepMs,
    });
    expect(await repair(repoId)).toEqual({ dirty: 1, reason: "events_failed" });
  });

  it("unwraps an envelope that was waiting for its repository to be listed", async () => {
    const repoId = newId("rep");
    const dead = letter({
      waitingSince: 5,
      envelope: { sourceId: repoId, events: [event(repoId, 1)] },
    });
    await deliver([dead]);
    expect(await stored(dead.id)).toMatchObject({
      source_id: repoId,
      kind: "repository",
      first_seq: 1,
    });
  });

  it("stores an account's envelope for a replay, asking for no repair", async () => {
    const orgId = newId("org");
    const dead = letter({ sourceId: orgId, events: [event(orgId, 3, "access.revoked")] });
    await deliver([dead]);
    expect(await stored(dead.id)).toMatchObject({ source_id: orgId, kind: "account" });
    expect(await repair(orgId)).toBeNull();
  });

  it("quarantines an envelope it cannot read, with why", async () => {
    const dead = letter({ sourceId: "nope", events: [] });
    await deliver([dead]);
    const row = await stored(dead.id);
    expect(row).toMatchObject({
      source_id: null,
      kind: "malformed",
      envelope: '{"sourceId":"nope","events":[]}',
    });
    expect(String(row?.reason)).not.toBe("");
    expect(dead.ack).toHaveBeenCalledOnce();
  });

  it("keeps only the record of a deleted repository's envelope, and asks for no repair", async () => {
    const repoId = newId("rep");
    await db
      .prepare(
        `INSERT INTO repos (repo_id, deleted, epoch_gen, version, owner_gen, updated_seq, updated_at)
         VALUES (?, 1, 1, 1, 1, 1, 0)`,
      )
      .bind(repoId)
      .run();
    const dead = letter({ sourceId: repoId, events: [event(repoId, 4)] });
    await deliver([dead]);
    expect(await stored(dead.id)).toMatchObject({ kind: "repository", envelope: null });
    expect(await repair(repoId)).toBeNull();
  });

  it("stores a dead letter delivered twice once, and retries one it could not store", async () => {
    const repoId = newId("rep");
    const dead = letter({ sourceId: repoId, events: [event(repoId, 1)] });
    await deliver([dead]);
    await deliver([dead]);
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM events_failed WHERE id = ?")
        .bind(dead.id)
        .first(),
    ).toEqual({ n: 1 });

    const failing = new Proxy(env, {
      get: (target, prop) =>
        prop === "ORG_READ"
          ? new Proxy(db, {
              get: (d, p) =>
                p === "batch"
                  ? () => Promise.reject(new Error("D1 unavailable"))
                  : Reflect.get(d, p),
            })
          : Reflect.get(target, prop),
    });
    const later = letter({ sourceId: repoId, events: [event(repoId, 2)] });
    await deliver([later], failing);
    expect(later.retry).toHaveBeenCalledOnce();
    expect(later.ack).not.toHaveBeenCalled();
    expect(await stored(later.id)).toBeNull();
  });

  it("drops an envelope kept its time, keeping the record of the failure", async () => {
    const repoId = newId("rep");
    const dead = letter({ sourceId: repoId, events: [event(repoId, 1)] });
    await deliver([dead]);
    expect(await pruneFailedEvents(env, { now: 1_000 + FAILED_POLICY.keepMs - 1 })).toBe(0);
    expect(
      await pruneFailedEvents(env, { now: 1_000 + FAILED_POLICY.keepMs }),
    ).toBeGreaterThanOrEqual(1);
    expect(await stored(dead.id)).toMatchObject({
      source_id: repoId,
      envelope: null,
      first_seq: 1,
    });
  });

  it("keeps the source a malformed envelope names, so a deleted repository's is fenced too", async () => {
    const repoId = newId("rep");
    const broken = (seq: number) => ({
      sourceId: repoId,
      events: [{ ...event(repoId, seq), type: "Not A Type" }],
    });
    const before = letter(broken(1));
    await deliver([before]);
    expect(await stored(before.id)).toMatchObject({ source_id: repoId, kind: "malformed" });
    expect(await repair(repoId)).toMatchObject({ dirty: 1 });
    // The repository is deleted; the same breakage arrives late.
    await db
      .prepare(
        `INSERT INTO repos (repo_id, deleted, epoch_gen, version, owner_gen, updated_seq, updated_at)
         VALUES (?, 1, 1, 1, 1, 1, 0)`,
      )
      .bind(repoId)
      .run();
    const late = letter(broken(2));
    await deliver([late]);
    expect(await stored(late.id)).toMatchObject({ source_id: repoId, envelope: null });
  });

  it("says what was wrong by kind only, never with the envelope's text", async () => {
    const repoId = newId("rep");
    const dead = letter({
      sourceId: repoId,
      events: [event(repoId, 1)],
      "Confidential: the acquisition of Initech": true,
    });
    await deliver([dead]);
    const row = await stored(dead.id);
    expect(row?.kind).toBe("malformed");
    expect(String(row?.reason)).not.toMatch(/Initech/);
    expect(String(row?.reason)).toMatch(/^[a-z_, ]+$/);
  });

  it("keeps a record, without the body, of a dead letter JSON cannot hold", async () => {
    const dead = letter({ sourceId: newId("rep"), events: [], size: 10n });
    await deliver([dead]);
    expect(dead.ack).toHaveBeenCalledOnce();
    // Not read further: kept by the source it names, with why its body is not.
    expect(await stored(dead.id)).toMatchObject({
      kind: "repository",
      envelope: null,
      reason: "unserializable",
    });
  });

  it("says why it kept no body for a readable envelope JSON cannot hold, or no row could", async () => {
    const repoId = newId("rep");
    const unserializable = letter({
      sourceId: repoId,
      events: [{ ...event(repoId, 1), data: { size: 10n } }],
    });
    // One string shared many times: small as a queue message, past a row as JSON.
    const shared = "x".repeat(100_000);
    const huge = letter({
      sourceId: repoId,
      events: [
        {
          ...event(repoId, 2),
          data: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, shared])),
        },
      ],
    });
    await deliver([unserializable, huge]);
    expect(await stored(unserializable.id)).toMatchObject({
      kind: "repository",
      envelope: null,
      reason: "unserializable",
    });
    expect(await stored(huge.id)).toMatchObject({
      kind: "repository",
      envelope: null,
      reason: "envelope_too_large",
      first_seq: 2,
    });
    expect(huge.ack).toHaveBeenCalledOnce();
  });

  it("records an envelope it does not read further, quickly, keeping no text it did not check", async () => {
    const repoId = newId("rep");
    // A sparse array: a few bytes as a message, four billion items to validate.
    const sparse = letter({ sourceId: repoId, events: new Array(4_294_967_295) });
    // Past the bound, with a type that is not one: its events' positions read, that text not.
    const shared = "x".repeat(100_000);
    const wide = letter({
      sourceId: repoId,
      events: [
        {
          ...event(repoId, 6),
          type: "Confidential: Initech",
          data: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, shared])),
        },
        event(repoId, 5, "issue.edited"),
      ],
    });
    await deliver([sparse, wide]);
    expect(await stored(sparse.id)).toMatchObject({
      source_id: repoId,
      kind: "repository",
      envelope: null,
      reason: "envelope_too_large",
      first_seq: null,
    });
    expect(sparse.ack).toHaveBeenCalledOnce();
    expect(await stored(wide.id)).toMatchObject({
      kind: "repository",
      envelope: null,
      first_seq: 5,
      last_seq: 6,
      types: '["issue.edited"]',
    });
  });

  it("records an envelope nested deeper than it reads, and asks for its repository's repair", async () => {
    const repoId = newId("rep");
    // 20,000 levels: about 120 KB as a message, a stack overflow for a recursive walk.
    let nested: unknown = 0;
    for (let i = 0; i < 20_000; i++) nested = { n: nested };
    const deep = letter({ sourceId: repoId, events: [], extra: nested });
    await deliver([deep]);
    expect(await stored(deep.id)).toMatchObject({
      source_id: repoId,
      kind: "repository",
      envelope: null,
      reason: "envelope_too_deep",
    });
    expect(await repair(repoId)).toMatchObject({ dirty: 1 });
    expect(deep.ack).toHaveBeenCalledOnce();
  });

  it("keeps a record of a dead letter reading fails on in a way not foreseen, rather than retrying", async () => {
    const hostile = letter(
      new Proxy(
        {},
        {
          get() {
            throw new Error("not readable");
          },
          ownKeys() {
            throw new Error("not readable");
          },
        },
      ),
    );
    await deliver([hostile]);
    expect(await stored(hostile.id)).toMatchObject({
      kind: "malformed",
      source_id: null,
      envelope: null,
      reason: "unreadable",
    });
    expect(hostile.ack).toHaveBeenCalledOnce();
    expect(hostile.retry).not.toHaveBeenCalled();
  });
});

describe("an envelope's JSON size, measured before it is written", () => {
  const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

  it("is what JSON.stringify writes, in UTF-8 bytes", () => {
    for (const value of [
      null,
      0,
      -1.5e300,
      "",
      'quote " and \\ and \n and \u0001 and é and 🙂',
      [],
      [1, undefined, () => 1, "x"],
      { a: 1, skipped: undefined, f: () => 1, nested: { b: [true, false, null] }, "é key": "v" },
      { sourceId: "rep_x", events: [{ id: { sourceId: "rep_x", epochGen: 1, sourceSeq: 2 } }] },
      // What JSON.stringify converts: a Date (its toJSON), boxed primitives.
      new Date(0),
      {
        at: new Date(1_793_000_000_000),
        list: [new Date(5), Object(7), Object("s"), Object(false)],
      },
      [Object("é"), Object(1.5)],
    ])
      expect(jsonBytes(value, 1_000_000), JSON.stringify(value)).toBe(bytes(value));
  });

  it("stops at its bound however much shared parts would expand, and refuses what JSON cannot hold", () => {
    // 1 KiB doubled 24 times by shared references: 16 GiB as JSON, 16 million strings. Each
    // level counts the items read from it (the clock does not move while code runs).
    let visited = 0;
    let shared: unknown = "x".repeat(1_024);
    for (let i = 0; i < 24; i++)
      shared = new Proxy([shared, shared], {
        get(target, key, receiver) {
          if (key === "0" || key === "1") visited++;
          return Reflect.get(target, key, receiver);
        },
      });
    expect(jsonBytes({ data: { shared } }, FAILED_POLICY.maxEnvelopeBytes)).toBe("too_large");
    // About the bound's worth of strings (1,900,000 bytes, 1 KiB each), not all of them.
    expect(visited).toBeLessThan(10_000);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(jsonBytes(cyclic, 1_000)).toBe("unserializable");
    expect(jsonBytes({ n: 10n }, 1_000)).toBe("unserializable");
    expect(jsonBytes({ n: Object(10n) }, 1_000)).toBe("unserializable");
  });

  it("bounds what it reads by its bound too, though what it reads writes nothing", () => {
    // 4,000 properties JSON leaves out, doubled 18 times by shared references: 1 billion reads
    // for no bytes at all.
    let reads = 0;
    const hollow = new Proxy(
      Object.fromEntries(Array.from({ length: 4_000 }, (_, i) => [`k${i}`, undefined])),
      {
        get(target, key, receiver) {
          reads++;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    let shared: unknown = hollow;
    for (let i = 0; i < 18; i++) shared = [shared, shared];
    expect(jsonBytes({ data: { shared } }, 10_000)).toBe("too_large");
    // The bound's worth of reads, and what reading one object's properties takes at most.
    expect(reads).toBeLessThanOrEqual(10_000 + 4_000);
  });

  it("records an envelope that would expand past the bound, without its body", async () => {
    const repoId = newId("rep");
    let shared: unknown = "x".repeat(1_024);
    for (let i = 0; i < 18; i++) shared = [shared, shared];
    const dead = letter({ sourceId: repoId, events: [{ ...event(repoId, 3), data: { shared } }] });
    await deliver([dead]);
    expect(await stored(dead.id)).toMatchObject({
      kind: "repository",
      envelope: null,
      reason: "envelope_too_large",
    });
  });

  it("records an envelope of more events than one carries, without validating them", async () => {
    // 40,000 events missing every field: 120 KB as JSON, hundreds of MB of validation issues.
    const repoId = newId("rep");
    const crowded = letter({
      sourceId: repoId,
      events: Array.from({ length: 40_000 }, () => ({})),
    });
    await deliver([crowded]);
    expect(await stored(crowded.id)).toMatchObject({
      source_id: repoId,
      kind: "malformed",
      reason: "too_big",
    });
    expect(await repair(repoId)).toMatchObject({ dirty: 1 });
    expect(crowded.ack).toHaveBeenCalledOnce();
  });

  it("records an envelope of many invalid events by its first one's issues", async () => {
    // 380 events each with an audience of 100 empty recipients (each within its limits):
    // 120 KB as JSON, hundreds of thousands of issues validated at once.
    const repoId = newId("rep");
    const crowded = letter({
      sourceId: repoId,
      events: Array.from({ length: 380 }, () => ({
        feed: { audience: Array.from({ length: 100 }, () => ({})) },
      })),
    });
    await deliver([crowded]);
    expect(await stored(crowded.id)).toMatchObject({ source_id: repoId, kind: "malformed" });
    expect(await repair(repoId)).toMatchObject({ dirty: 1 });
    expect(crowded.ack).toHaveBeenCalledOnce();
  });

  it("records an envelope whose shared parts take too long to read, though they write nothing", async () => {
    const repoId = newId("rep");
    let shared: unknown = Object.fromEntries(
      Array.from({ length: 4_000 }, (_, i) => [`k${i}`, undefined]),
    );
    for (let i = 0; i < 18; i++) shared = [shared, shared];
    const hollow = letter({
      sourceId: repoId,
      events: [{ ...event(repoId, 4), data: { shared } }],
    });
    await deliver([hollow]);
    expect(await stored(hollow.id)).toMatchObject({
      kind: "repository",
      envelope: null,
      reason: "envelope_too_large",
      first_seq: 4,
    });
    expect(await repair(repoId)).toMatchObject({ dirty: 1 });
    expect(hollow.ack).toHaveBeenCalledOnce();
  });

  it("records, without the body, what converts to too much or to nothing JSON can hold", async () => {
    const repoId = newId("rep");
    // A Date doubled 17 times: a few hundred bytes as a message, megabytes of JSON.
    let dates: unknown = new Date(0);
    for (let i = 0; i < 17; i++) dates = [dates, dates];
    const many = letter({ sourceId: repoId, events: [{ ...event(repoId, 1), data: { dates } }] });
    const boxed = letter({
      sourceId: repoId,
      events: [{ ...event(repoId, 2), data: { n: Object(10n) } }],
    });
    await deliver([many, boxed]);
    expect(await stored(many.id)).toMatchObject({ envelope: null, reason: "envelope_too_large" });
    expect(await stored(boxed.id)).toMatchObject({ envelope: null, reason: "unserializable" });
    expect(many.ack).toHaveBeenCalledOnce();
    expect(boxed.ack).toHaveBeenCalledOnce();
  });
});
