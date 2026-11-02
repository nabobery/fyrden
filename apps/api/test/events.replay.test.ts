// Replaying an account's failed envelope: an instance administrator puts the
// envelope the dead-letter queue kept back on the events queue, once; the
// events consumer then applies it as any envelope, its effects reaching the
// account's members' feeds. A repository's (which asks for its own repair), a
// malformed one, one whose envelope or stored payloads are gone, and a second
// replay are refused; nothing is decided while the read model is not running.
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
  createIdFactory,
  type DomainEvent,
  type FeedEntry,
  secureRandomBytes,
} from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OUTBOX_POLICY } from "../src/do/base/outbox.js";
import type { OrgDO } from "../src/do/OrgDO.js";
import type { UserDO } from "../src/do/UserDO.js";
import { DEFAULT_ORG_SHARD } from "../src/events/read-model.js";
import { consumeEvents, EVENTS_QUEUE } from "../src/queues/events-consumer.js";
import {
  consumeFailedEvents,
  EVENTS_DLQ,
  FAILED_POLICY,
  pruneFailedEvents,
} from "../src/queues/events-dlq.js";
import { REPLAY_PAYLOAD_MARGIN_MS } from "../src/queues/events-replay.js";
import { pauseReadModel, resumeReadModel } from "../src/read-model/maintenance.js";
import { clock } from "../src/services.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { FROM_START } from "./helpers/feed.js";
import { ORIGIN } from "./helpers/git-http.js";
import { admitted } from "./helpers/read-model.js";

const newId = createIdFactory(Date.now, secureRandomBytes);
// Read as production reads it, written through the read model's executor.
const db = admitted();

type Replayed = { id: string; source_id: string; requeued_at: number };

// What a replay puts back on the events queue is kept here, not sent: the real queue's consumer
// would apply it whenever it ran. A test applies it itself, as that consumer does.
let requeued: unknown[];
beforeEach(() => {
  requeued = [];
  vi.spyOn(env.EVENTS, "send").mockImplementation(async (body: unknown) => {
    requeued.push(body);
    return {} as QueueSendResponse;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** The events consumer applying what the replays sent, each acknowledged. */
async function consumeRequeued(): Promise<void> {
  const messages = requeued.map((body) => ({
    id: uniqueId("msg"),
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  }));
  requeued = [];
  await consumeEvents({ queue: EVENTS_QUEUE, messages } as unknown as MessageBatch<unknown>, env);
  for (const message of messages) expect(message.ack).toHaveBeenCalledOnce();
}

/** Stores `body` as the dead-letter queue does, as of `now`; answers the record's id. */
async function deadLetter(body: unknown, now = clock()): Promise<string> {
  const id = uniqueId("msg");
  await consumeFailedEvents(
    {
      queue: EVENTS_DLQ,
      messages: [{ id, body, attempts: 10, ack: vi.fn(), retry: vi.fn() }],
    } as unknown as MessageBatch<unknown>,
    env,
    { now: () => now },
  );
  return id;
}

const replay = (id: string, who: Who, key: string = crypto.randomUUID()) =>
  json<Replayed & { code?: string }>(
    exports.default.fetch(`${ORIGIN}/api/admin/events/failed/${id}/replay`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${who.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: "{}",
    }),
  );

const record = (id: string) =>
  db
    .prepare(
      "SELECT kind, envelope IS NOT NULL AS kept, requeued_at FROM events_failed WHERE id = ?",
    )
    .bind(id)
    .first<{ kind: string; kept: number; requeued_at: number | null }>();

/** An activity entry for `repoId`'s pull 1. */
function entry(repoId: string, occurredAt: number): FeedEntry {
  return {
    eventKey: `${repoId}:1:1`,
    repoId,
    occurredAt,
    actor: "usr_actor",
    epochGen: 1,
    feed: {
      threadKey: "pull/1",
      subject: { kind: "pull", number: 1, title: "A pull request", version: 1 },
      action: "comment",
      actorRoot: "usr_actor",
      actorTrust: "write",
      member: "comment/1",
      excerpt: null,
    },
    recipient: {
      principal: "usr_reader",
      kind: "activity",
      reasons: ["commenter"],
      priority: "P1",
      state: "open",
      silent: false,
    },
  };
}

async function shown(stub: DurableObjectStub<UserDO>) {
  const page = await stub.listStreams(FROM_START, 100, {});
  if (page.expired) throw new Error("expired");
  return page.items.map((item) => item.repoId);
}

/**
 * A collaborator removed from a user's repository, the account's event (an
 * `access.revoked`, still in its outbox: alarms are held) failed for good and
 * kept by the dead-letter queue; the collaborator's feed still shows the
 * repository's activity.
 */
async function failedRevocation() {
  const owner = await user();
  const reader = await user();
  const made = await json<{ id: string; full_name: string }>(
    api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
  );
  const repo = made.body;
  const path = `/repos/${repo.full_name}/collaborators/${reader.handle}`;
  expect((await api("PUT", path, owner.token, { permission: "pull" })).status).toBeLessThan(300);
  const feed = env.USER.getByName(reader.principalId);
  const now = Date.now();
  await feed.applyFeed([entry(repo.id, now), entry("rep_elsewhere", now)]);
  expect((await api("DELETE", path, owner.token)).status).toBe(200);
  const events = await runInDurableObject(env.ORG.getByName(owner.principalId), (_: OrgDO, state) =>
    state.storage.sql
      .exec<{ event: string }>("SELECT event FROM outbox ORDER BY source_seq")
      .toArray()
      .map((row) => JSON.parse(row.event) as DomainEvent),
  );
  expect(events.map((e) => e.type)).toContain("access.revoked");
  const id = await deadLetter({ sourceId: owner.principalId, events });
  expect(await record(id)).toMatchObject({ kind: "account", kept: 1, requeued_at: null });
  expect((await shown(feed)).sort()).toEqual([repo.id, "rep_elsewhere"].sort());
  return {
    id,
    accountId: owner.principalId,
    envelope: { sourceId: owner.principalId, events },
    feed,
  };
}

const effectsOf = async (sourceId: string) =>
  (
    await db
      .prepare("SELECT count(*) AS n FROM effects WHERE source_id = ? AND sink = 'feed'")
      .bind(sourceId)
      .first<{ n: number }>()
  )?.n;

/** An account's `access.revoked`, at `at`, stored in its outbox's payloads or not. */
const revoked = (accountId: string, seq: number, at = 0, stored = false): DomainEvent => ({
  id: { sourceId: accountId, epochGen: 1, sourceSeq: seq },
  type: "access.revoked",
  at,
  actor: null,
  actChain: [],
  ownerGen: 1,
  entity: null,
  data: stored ? null : { principals: ["usr_x"], repos: ["rep_x"], acl_version: 1 },
  stored,
});

describe("replaying a failed account envelope", () => {
  it("puts it back on the events queue, whose consumer purges its members' feeds", async () => {
    const admin = await user(true);
    const { id, accountId, envelope, feed } = await failedRevocation();
    const before = clock();
    const replayed = await replay(id, admin);
    expect(replayed).toMatchObject({ status: 200, body: { id, source_id: accountId } });
    expect(replayed.body.requeued_at).toBeGreaterThanOrEqual(before);
    expect(await record(id)).toEqual({
      kind: "account",
      kept: 1,
      requeued_at: replayed.body.requeued_at,
    });
    // Sent as it was kept; nothing applied by the request itself.
    expect(requeued).toEqual([envelope]);
    expect(await effectsOf(accountId)).toBe(0);
    expect(await shown(feed)).toHaveLength(2);
    await consumeRequeued();
    expect(await shown(feed)).toEqual(["rep_elsewhere"]);
    expect(await effectsOf(accountId)).toBe(1);
  });

  it("answers a retry with the same key as before, sending once, and refuses a second replay", async () => {
    const admin = await user(true);
    const { id } = await failedRevocation();
    const key = crypto.randomUUID();
    const first = await replay(id, admin, key);
    expect(first.status).toBe(200);
    expect(await replay(id, admin, key)).toEqual(first);
    expect(await replay(id, admin)).toMatchObject({
      status: 409,
      body: { code: "already_replayed" },
    });
    expect(requeued).toHaveLength(1);
    expect((await record(id))?.requeued_at).toBe(first.body.requeued_at);
  });

  it("sends once when two replays of the same record race", async () => {
    const admin = await user(true);
    const { id, accountId, feed } = await failedRevocation();
    const both = await Promise.all([replay(id, admin), replay(id, admin)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(both.find((r) => r.status === 409)?.body.code).toBe("already_replayed");
    expect(requeued).toHaveLength(1);
    await consumeRequeued();
    expect(await effectsOf(accountId)).toBe(1);
    expect(await shown(feed)).toEqual(["rep_elsewhere"]);
  });

  it("gives the record back when the send fails, so it can be replayed again", async () => {
    const admin = await user(true);
    const { id } = await failedRevocation();
    vi.mocked(env.EVENTS.send).mockRejectedValueOnce(new Error("queue down"));
    const key = crypto.randomUUID();
    expect(await replay(id, admin, key)).toMatchObject({
      status: 503,
      body: { code: "requeue_failed" },
    });
    expect(await record(id)).toMatchObject({ requeued_at: null });
    // Nothing kept for the key: the same request runs again.
    expect((await replay(id, admin, key)).status).toBe(200);
    expect(requeued).toHaveLength(1);
  });

  it("refuses anyone but an instance administrator, changing nothing", async () => {
    const member = await user();
    const { id } = await failedRevocation();
    expect((await replay(id, member)).status).toBe(403);
    expect(await record(id)).toMatchObject({ requeued_at: null });
    expect(requeued).toEqual([]);
  });

  it("refuses a repository's or a malformed envelope, and an unknown record", async () => {
    const admin = await user(true);
    const repoId = newId("rep");
    const repository = await deadLetter({
      sourceId: repoId,
      events: [{ ...revoked(repoId, 1), type: "repo.updated", data: null }],
    });
    const malformed = await deadLetter({ sourceId: "nope", events: [] });
    expect(await record(repository)).toMatchObject({ kind: "repository", kept: 1 });
    expect(await record(malformed)).toMatchObject({ kind: "malformed", kept: 1 });
    for (const id of [repository, malformed]) {
      expect(await replay(id, admin)).toMatchObject({
        status: 409,
        body: { code: "not_replayable" },
      });
      expect((await record(id))?.requeued_at).toBeNull();
    }
    expect(await replay(uniqueId("msg"), admin)).toMatchObject({
      status: 404,
      body: { code: "failure_not_found" },
    });
    expect(requeued).toEqual([]);
  });

  it("refuses an envelope kept past its time, dropped, or never kept", async () => {
    const admin = await user(true);
    const accountId = newId("usr");
    const envelope = (seq: number) => ({ sourceId: accountId, events: [revoked(accountId, seq)] });
    const now = clock();
    // Stored long enough ago that its time has passed, not yet dropped.
    const expired = await deadLetter(envelope(100), now - FAILED_POLICY.keepMs - 1);
    // Stored earlier, and dropped by a maintenance run before the other's time passed.
    const dropped = await deadLetter(envelope(101), now - FAILED_POLICY.keepMs - 10_000);
    expect(await pruneFailedEvents(env, { now: now - 5_000 })).toBeGreaterThanOrEqual(1);
    expect(await record(expired)).toMatchObject({ kind: "account", kept: 1 });
    expect(await record(dropped)).toMatchObject({ kind: "account", kept: 0 });
    // JSON cannot hold it: its record kept without the envelope.
    const unkept = await deadLetter({ ...envelope(102), size: 10n });
    expect(await record(unkept)).toMatchObject({ kind: "account", kept: 0 });
    for (const id of [expired, dropped])
      expect(await replay(id, admin)).toMatchObject({
        status: 410,
        body: { code: "envelope_expired" },
      });
    expect(await replay(unkept, admin)).toMatchObject({
      status: 410,
      body: { code: "envelope_not_kept" },
    });
    expect(requeued).toEqual([]);
  });

  it("refuses an envelope whose stored payloads the account may have dropped", async () => {
    const admin = await user(true);
    const accountId = newId("org");
    const now = clock();
    // The outbox keeps a stored payload its retention after the event is sent (never sooner than
    // after the event itself): one this old may be gone, and its purge with it.
    const bound = now - OUTBOX_POLICY.payloadRetentionMs + REPLAY_PAYLOAD_MARGIN_MS;
    const old = await deadLetter({
      sourceId: accountId,
      events: [revoked(accountId, 1, now), revoked(accountId, 2, bound - 1_000, true)],
    });
    expect(await replay(old, admin)).toMatchObject({
      status: 410,
      body: { code: "payload_expired" },
    });
    expect(await record(old)).toMatchObject({ kept: 1, requeued_at: null });
    expect(requeued).toEqual([]);
    // A stored payload well within its retention, and one not stored at all however old: replayed.
    const recent = await deadLetter({
      sourceId: accountId,
      events: [revoked(accountId, 3, bound + 60_000, true), revoked(accountId, 4, 0)],
    });
    expect((await replay(recent, admin)).status).toBe(200);
    expect(requeued).toHaveLength(1);
  });

  it("decides nothing while the read model is not running: an answer later, not a cached absence", async () => {
    const admin = await user(true);
    const { id, feed } = await failedRevocation();
    const missing = uniqueId("msg");
    const key = crypto.randomUUID();
    await pauseReadModel(env, DEFAULT_ORG_SHARD);
    try {
      for (const [failure, k] of [
        [id, crypto.randomUUID()],
        [missing, key],
      ] as const)
        expect(await replay(failure, admin, k)).toMatchObject({
          status: 503,
          body: { code: "read_model_maintenance" },
        });
    } finally {
      await resumeReadModel(env, DEFAULT_ORG_SHARD);
    }
    expect(await record(id)).toMatchObject({ requeued_at: null });
    expect(requeued).toEqual([]);
    // The same key, once running: the record's absence, decided now.
    expect(await replay(missing, admin, key)).toMatchObject({
      status: 404,
      body: { code: "failure_not_found" },
    });
    expect((await replay(id, admin)).status).toBe(200);
    await consumeRequeued();
    expect(await shown(feed)).toEqual(["rep_elsewhere"]);
  });
});
