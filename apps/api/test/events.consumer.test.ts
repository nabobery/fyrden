import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  runInDurableObject,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
  createIdFactory,
  type DomainEvent,
  type EntitySnapshot,
  type Envelope,
  type RepoRow,
  secureRandomBytes,
} from "@fyrden/domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import {
  applyEnvelope,
  consumeEvents,
  EVENTS_QUEUE,
  UNLISTED_GRACE_MS,
} from "../src/queues/events-consumer.js";
import { ORIGIN } from "./helpers/git-http.js";
import { principalWithToken } from "./helpers/principals.js";

const newId = createIdFactory(Date.now, secureRandomBytes);
const OWNER = "usr_01K742SG00NAWD8WB4RTMJF8H7";

/** A repository listed in the directory (its object is never touched unless a test stores a payload). */
async function listedRepo(
  state: "active" | "deleting" = "active",
  id: string = newId("rep"),
): Promise<string> {
  await env.DIRECTORY.prepare(
    "INSERT INTO principals (id, type, handle, created_at) VALUES (?, 'user', ?, 0) ON CONFLICT DO NOTHING",
  )
    .bind(OWNER, "consumer-owner")
    .run();
  await env.DIRECTORY.prepare(
    `INSERT INTO repos (id, owner_id, name, network_id, org_shard, visibility, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'default', 'private', ?, 0, 0)`,
  )
    .bind(id, OWNER, id.toLowerCase(), newId("net"), state)
    .run();
  return id;
}

const row = (overrides: Partial<RepoRow> = {}): RepoRow => ({
  ownerId: OWNER,
  name: "consumed",
  visibility: "private",
  defaultBranch: "refs/heads/main",
  pushedAt: null,
  createdAt: 1,
  ...overrides,
});

function snapshot(
  repoId: string,
  version: number,
  options: {
    epochGen?: number;
    deleted?: boolean;
    ownerGen?: number;
    at?: number;
    r?: RepoRow;
  } = {},
): DomainEvent & { entity: EntitySnapshot } {
  const deleted = options.deleted ?? false;
  return {
    id: { sourceId: repoId, epochGen: options.epochGen ?? 1, sourceSeq: version },
    type: deleted ? "repo.deleted" : "repo.updated",
    at: options.at ?? Date.now(),
    actor: null,
    actChain: [],
    ownerGen: options.ownerGen ?? 1,
    entity: {
      type: "repo",
      id: repoId,
      version,
      deleted,
      row: deleted ? null : (options.r ?? row({ pushedAt: version })),
    },
    data: null,
    stored: false,
  };
}

const envelope = (repoId: string, events: DomainEvent[]): Envelope => ({
  sourceId: repoId,
  events,
});

/** A snapshot that travels without its row, which the repository keeps by event key. */
function storedSnapshot(repoId: string, version: number, epochGen = 1): DomainEvent {
  const event = snapshot(repoId, version, { epochGen });
  return { ...event, stored: true, entity: { ...event.entity, row: null } };
}

async function storePayload(repoId: string, version: number, payload: string) {
  await runInDurableObject(env.REPO.getByName(repoId), (_: RepoDO, state) => {
    state.storage.sql.exec(
      "INSERT INTO event_payloads (event_key, payload, created_at) VALUES (?, ?, 0)",
      `${repoId}:1:${version}`,
      payload,
    );
  });
}

async function readRow(repoId: string) {
  return env.ORG_READ.prepare(
    "SELECT name, pushed_at, deleted, epoch_gen, version FROM repos WHERE repo_id = ?",
  )
    .bind(repoId)
    .first<{
      name: string | null;
      pushed_at: number | null;
      deleted: number;
      epoch_gen: number;
      version: number;
    }>();
}

/** Delivers `bodies` as one queue batch and reports what the consumer did with each message. */
async function deliver(bodies: unknown[], on: Env = env, now?: number) {
  const batch = createMessageBatch(
    EVENTS_QUEUE,
    bodies.map((body, i) => ({ id: `m${i}`, timestamp: new Date(), attempts: 1, body })),
  );
  const ctx = createExecutionContext();
  await consumeEvents(batch, on, now === undefined ? {} : { now: () => now });
  return getQueueResult(batch, ctx);
}

/** An events queue that records what is sent to it. */
function capturingQueue() {
  const sent: { body: unknown; delaySeconds: number | undefined }[] = [];
  const queue = envWith({
    EVENTS: {
      send: async (body: unknown, options?: QueueSendOptions) => {
        sent.push({ body, delaySeconds: options?.delaySeconds });
      },
    } as unknown as Queue,
  });
  return { queue, sent };
}

/** The test environment with some bindings replaced. */
const envWith = (overrides: Partial<Env>): Env =>
  // A proxy, so the shared `env` is never changed.
  new Proxy(env, {
    get: (target, prop) =>
      prop in overrides ? overrides[prop as keyof Env] : Reflect.get(target, prop),
  });

describe("events consumer", () => {
  it("projects a repository snapshot and acknowledges the message", async () => {
    const repoId = await listedRepo();
    const result = await deliver([envelope(repoId, [snapshot(repoId, 1)])]);
    expect(result.explicitAcks).toEqual(["m0"]);
    expect(await readRow(repoId)).toEqual({
      name: "consumed",
      pushed_at: 1,
      deleted: 0,
      epoch_gen: 1,
      version: 1,
    });
  });

  it("projects the description, and an older event without one as none", async () => {
    const repoId = await listedRepo();
    const description = async () =>
      (
        await env.ORG_READ.prepare("SELECT description FROM repos WHERE repo_id = ?")
          .bind(repoId)
          .first<{ description: string | null }>()
      )?.description;
    await deliver([
      envelope(repoId, [snapshot(repoId, 1, { r: row({ description: "Widgets" }) })]),
    ]);
    expect(await description()).toBe("Widgets");
    // Built before descriptions existed: the field is absent.
    await deliver([envelope(repoId, [snapshot(repoId, 2)])]);
    expect(await description()).toBeNull();
  });

  it("applies a duplicate delivery once, leaving the row as it was", async () => {
    const repoId = await listedRepo();
    const body = envelope(repoId, [snapshot(repoId, 2)]);
    await deliver([body]);
    const first = await readRow(repoId);
    await deliver([body, body]);
    expect(await readRow(repoId)).toEqual(first);
  });

  it("converges on the newest snapshot whatever the order and duplication of deliveries", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .integer({ min: 1, max: 6 })
          .chain((n) =>
            fc
              .array(fc.integer({ min: 1, max: n }), { minLength: 0, maxLength: 6 })
              .map((extra) => ({ n, extra })),
          ),
        fc.infiniteStream(fc.integer()),
        async ({ n, extra }, seeds) => {
          const repoId = await listedRepo();
          const versions = [...Array.from({ length: n }, (_, i) => i + 1), ...extra];
          // Shuffle with the generated seeds.
          const order = versions
            .map((v) => ({ v, k: seeds.next().value as number }))
            .sort((a, b) => a.k - b.k)
            .map(({ v }) => v);
          for (const v of order) await deliver([envelope(repoId, [snapshot(repoId, v)])]);
          expect(await readRow(repoId)).toMatchObject({ version: n, pushed_at: n });
        },
      ),
      { numRuns: 15 },
    );
  });

  it("keeps a deletion when an older snapshot arrives after it", async () => {
    const repoId = await listedRepo();
    await deliver([envelope(repoId, [snapshot(repoId, 3, { deleted: true })])]);
    await deliver([envelope(repoId, [snapshot(repoId, 2)])]);
    expect(await readRow(repoId)).toMatchObject({ deleted: 1, version: 3, name: null });
  });

  it("drops events of an older epoch, and lets a newer epoch replace higher versions", async () => {
    const repoId = await listedRepo();
    await deliver([envelope(repoId, [snapshot(repoId, 5, { epochGen: 1 })])]);
    await deliver([
      envelope(repoId, [snapshot(repoId, 1, { epochGen: 2, r: row({ name: "restored" }) })]),
    ]);
    expect(await readRow(repoId)).toMatchObject({ epoch_gen: 2, version: 1, name: "restored" });
    await deliver([envelope(repoId, [snapshot(repoId, 9, { epochGen: 1 })])]);
    expect(await readRow(repoId)).toMatchObject({ epoch_gen: 2, version: 1 });
  });

  it("drops events with an older ownership generation", async () => {
    const repoId = await listedRepo();
    await env.ORG_READ.prepare("INSERT INTO source_owner (source_id, owner_gen) VALUES (?, 2)")
      .bind(repoId)
      .run();
    await deliver([envelope(repoId, [snapshot(repoId, 1, { ownerGen: 1 })])]);
    expect(await readRow(repoId)).toBeNull();
    await deliver([envelope(repoId, [snapshot(repoId, 2, { ownerGen: 2 })])]);
    expect(await readRow(repoId)).toMatchObject({ version: 2 });
  });

  it("keeps references' effects of an older ownership generation: they hold across a transfer", async () => {
    const repoId = await listedRepo();
    await env.ORG_READ.prepare("INSERT INTO source_owner (source_id, owner_gen) VALUES (?, 2)")
      .bind(repoId)
      .run();
    const event: DomainEvent = {
      id: { sourceId: repoId, epochGen: 1, sourceSeq: 1 },
      type: "reference.sync",
      at: Date.now(),
      actor: OWNER,
      actChain: [],
      ownerGen: 1,
      entity: null,
      data: {
        source_number: 1,
        source_comment: 0,
        source_kind: "issue",
        repos: [{ repo_id: newId("rep"), numbers: [2] }],
      },
      stored: false,
    };
    await deliver([envelope(repoId, [event])]);
    const journaled = await env.ORG_READ.prepare(
      "SELECT sink FROM effects WHERE effect_id LIKE ? || '%'",
    )
      .bind(repoId)
      .all<{ sink: string }>();
    expect(journaled.results.map((r) => r.sink)).toEqual(["references"]);
  });

  it("applies only the newest snapshot of an entity within one message", async () => {
    const repoId = await listedRepo();
    await deliver([
      envelope(repoId, [snapshot(repoId, 2), snapshot(repoId, 4), snapshot(repoId, 3)]),
    ]);
    expect(await readRow(repoId)).toMatchObject({ version: 4, pushed_at: 4 });
  });

  it("puts back events of a repository not listed yet without spending retries, until listed", async () => {
    const repoId = newId("rep");
    const { queue, sent } = capturingQueue();
    const body = envelope(repoId, [snapshot(repoId, 1)]);
    const waiting = await deliver([body], queue);
    expect(waiting.explicitAcks).toEqual(["m0"]);
    expect(waiting.retryMessages).toEqual([]);
    expect(sent).toEqual([
      { body: { waitingSince: expect.any(Number), envelope: body }, delaySeconds: 30 },
    ]);

    // Put back again: the first sighting is kept, the delay grows with the wait.
    const now = Date.now();
    const since = now - 120_000;
    sent.length = 0;
    await deliver([{ waitingSince: since, envelope: body }], queue, now);
    expect(sent).toEqual([{ body: { waitingSince: since, envelope: body }, delaySeconds: 120 }]);

    // Once the repository is listed, the put-back message is applied.
    await listedRepo("active", repoId);
    sent.length = 0;
    expect((await deliver([{ waitingSince: since, envelope: body }], queue)).explicitAcks).toEqual([
      "m0",
    ]);
    expect(sent).toEqual([]);
    expect(await readRow(repoId)).toMatchObject({ version: 1 });
  });

  it("drops waiting events once the grace has passed since the consumer first saw them, whatever their times", async () => {
    const never = newId("rep");
    const { queue, sent } = capturingQueue();
    // Events dated far in the future do not extend the wait.
    const body = envelope(never, [snapshot(never, 1, { at: Date.now() + 24 * 60 * 60 * 1000 })]);
    const result = await deliver(
      [{ waitingSince: Date.now() - UNLISTED_GRACE_MS - 1, envelope: body }],
      queue,
    );
    expect(result.explicitAcks).toEqual(["m0"]);
    expect(sent).toEqual([]);
  });

  it("retries a waiting message whose put-back fails", async () => {
    const repoId = newId("rep");
    const failing = envWith({
      EVENTS: {
        send: async () => {
          throw new Error("queue unavailable");
        },
      } as unknown as Queue,
    });
    const result = await deliver([envelope(repoId, [snapshot(repoId, 1)])], failing);
    expect(result.retryMessages.map((m) => m.msgId)).toEqual(["m0"]);
  });

  it("records a newer epoch from any event, so older epochs are refused afterwards", async () => {
    const repoId = await listedRepo();
    const activity: DomainEvent = {
      ...snapshot(repoId, 1, { epochGen: 2 }),
      type: "refs.updated",
      entity: null,
      data: { refs: [] },
    };
    expect((await deliver([envelope(repoId, [activity])])).explicitAcks).toEqual(["m0"]);
    await deliver([envelope(repoId, [snapshot(repoId, 7, { epochGen: 1 })])]);
    expect(await readRow(repoId)).toBeNull();
  });

  it("drops ordinary events of a repository being deleted", async () => {
    const repoId = await listedRepo("deleting");
    expect(await applyEnvelope(env, envelope(repoId, [snapshot(repoId, 1)]))).toBe("dropped");
    expect(await readRow(repoId)).toBeNull();
  });

  it("retries a malformed message so it reaches the dead-letter queue", async () => {
    const repoId = await listedRepo();
    const result = await deliver([
      { sourceId: repoId, events: [] },
      envelope(repoId, [
        { ...snapshot(repoId, 1), entity: { ...snapshot(repoId, 1).entity, row: { name: 1 } } },
      ]),
    ]);
    expect(result.retryMessages.map((m) => m.msgId)).toEqual(["m0", "m1"]);
  });

  it("fetches a stored snapshot's row from the repository", async () => {
    const repoId = await listedRepo();
    await storePayload(repoId, 1, JSON.stringify({ row: row({ name: "stored-row" }), data: null }));
    await deliver([envelope(repoId, [storedSnapshot(repoId, 1)])]);
    expect(await readRow(repoId)).toMatchObject({ name: "stored-row", version: 1 });
  });

  it("acknowledges a stored snapshot whose payload is gone, still recording its epoch", async () => {
    const repoId = await listedRepo();
    const result = await deliver([envelope(repoId, [storedSnapshot(repoId, 1, 3)])]);
    expect(result.explicitAcks).toEqual(["m0"]);
    expect(await readRow(repoId)).toBeNull();
    const epoch = await env.ORG_READ.prepare(
      "SELECT epoch_gen FROM consumer_epochs WHERE source_id = ?",
    )
      .bind(repoId)
      .first<{ epoch_gen: number }>();
    expect(epoch?.epoch_gen).toBe(3);
  });

  it.each([
    ["no row", "{}"],
    ["a null row", '{"row":null}'],
    ["a scalar row", '{"row":1}'],
    ["a malformed row", JSON.stringify({ row: { name: "x" } })],
  ])("retries a stored snapshot whose payload has %s", async (_, payload) => {
    const repoId = await listedRepo();
    await storePayload(repoId, 1, payload);
    const result = await deliver([envelope(repoId, [storedSnapshot(repoId, 1)])]);
    expect(result.retryMessages.map((m) => m.msgId)).toEqual(["m0"]);
    expect(await readRow(repoId)).toBeNull();
  });

  it("makes one directory query and one read-model batch per message at the configured batch size", async () => {
    const repos = await Promise.all(Array.from({ length: 5 }, () => listedRepo()));
    const calls = { directory: 0, batches: [] as number[] };
    const counting = envWith({
      DIRECTORY: new Proxy(env.DIRECTORY, {
        get(target, prop) {
          if (prop === "prepare")
            return (query: string) => {
              calls.directory++;
              return target.prepare(query);
            };
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
      ORG_READ: new Proxy(env.ORG_READ, {
        get(target, prop) {
          if (prop === "batch")
            return (statements: D1PreparedStatement[]) => {
              calls.batches.push(statements.length);
              return target.batch(statements);
            };
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    });
    const result = await deliver(
      repos.map((repoId) => envelope(repoId, [snapshot(repoId, 1), snapshot(repoId, 2)])),
      counting,
    );
    // A D1 batch counts as one call against the per-invocation limit, on Free
    // the 1,000 internal-service calls (measured on Workers Free, 2026-10-10).
    expect(calls).toEqual({ directory: 5, batches: [2, 2, 2, 2, 2] });
    expect(result.explicitAcks).toHaveLength(5);
    for (const repoId of repos) expect(await readRow(repoId)).toMatchObject({ version: 2 });
  });

  it("builds the read model from a repository created through the API and its push", async () => {
    const owner = await principalWithToken("user", "pat");
    const name = `consumed-${Date.now()}`;
    const res = await exports.default.fetch(`${ORIGIN}/api/user/repos`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${owner.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ name }),
    });
    const { id } = await res.json<{ id: string }>();
    // What the outbox would send: drain it into a list instead of the queue.
    const sent = await runInDurableObject(env.REPO.getByName(id), async (repo: RepoDO) => {
      const out: Envelope[] = [];
      repo.sendEvents = async (e) => {
        out.push(e);
      };
      await repo.outbox.drain(id);
      return out;
    });
    const result = await deliver(sent);
    expect(result.explicitAcks).toHaveLength(sent.length);
    expect(
      await env.ORG_READ.prepare(
        "SELECT owner_id, name, visibility, version FROM repos WHERE repo_id = ?",
      )
        .bind(id)
        .first(),
    ).toEqual({ owner_id: owner.principalId, name, visibility: "private", version: 1 });
  });
});
