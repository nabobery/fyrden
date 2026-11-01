import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { applyDoMigrations } from "@fyrden/adapters-cloudflare/migrations";
import {
  createIdFactory,
  type DomainEvent,
  type Envelope,
  GITHUB_DEFAULT_LABELS,
  parseEnvelope,
  secureRandomBytes,
} from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import {
  MAX_MESSAGE_BYTES,
  type NewEvent,
  OUTBOX_POLICY,
  Outbox,
  type OutboxPolicy,
} from "../src/do/base/outbox.js";
import type { RepoDO } from "../src/do/RepoDO.js";
import { REFS_PER_EVENT } from "../src/do/repo/events.js";
import { repoSchema } from "../src/do/schema/repo.js";
import { allocateEpoch } from "../src/events/epochs.js";
import { ORIGIN } from "./helpers/git-http.js";
import { principalWithToken } from "./helpers/principals.js";
import { inRepo, newNetworkId, oid } from "./helpers/repo-git.js";

const SOURCE = "rep_01K742SG0021RA8PP539MVRVBJ";
const newId = createIdFactory(Date.now, secureRandomBytes);

const activity = (data: Record<string, unknown> = {}): NewEvent => ({
  type: "refs.updated",
  at: 1,
  actor: null,
  actChain: [],
  ownerGen: 1,
  entity: null,
  data,
});

const id = (sourceSeq: number) => ({ sourceId: SOURCE, epochGen: 1, sourceSeq });

/**
 * Runs `fn` with an outbox on a fresh object's storage (migrated, empty),
 * a clock the test moves, and a send the test controls.
 */
async function withOutbox<R>(
  fn: (o: {
    outbox: Outbox;
    storage: DurableObjectStorage;
    sent: Envelope[];
    setSend: (send: (envelope: Envelope) => Promise<void>) => void;
    advance: (ms: number) => void;
  }) => R | Promise<R>,
  policy: Partial<OutboxPolicy> = {},
): Promise<R> {
  const stub = env.REPO.getByName(uniqueId("outbox"));
  return runInDurableObject(stub, async (_: RepoDO, state) => {
    let now = 1_000_000;
    const sent: Envelope[] = [];
    let send = async (envelope: Envelope) => {
      sent.push(structuredClone(envelope));
    };
    const outbox = new Outbox(state.storage, {
      now: () => now,
      send: (envelope) => send(envelope),
      policy: { ...OUTBOX_POLICY, ...policy },
    });
    return fn({
      outbox,
      storage: state.storage,
      sent,
      setSend: (s) => {
        send = s;
      },
      advance: (ms) => {
        now += ms;
      },
    });
  });
}

const keys = (envelopes: Envelope[]) => envelopes.map((e) => e.events.map((x) => x.id.sourceSeq));

describe("Outbox", () => {
  it("is due after the delay once something is appended, and empty again after a drain", async () => {
    const result = await withOutbox(async ({ outbox, sent }) => {
      const before = outbox.dueAt();
      outbox.append(id(1), activity());
      const due = outbox.dueAt();
      const drained = await outbox.drain(SOURCE);
      return { before, due, drained, after: outbox.dueAt(), sent, pending: outbox.pending() };
    });
    expect(result.before).toBeNull();
    expect(result.due).toBe(1_000_000 + OUTBOX_POLICY.delayMs);
    expect(result.drained).toEqual({ ok: true, sent: 1, remaining: false });
    expect(result.after).toBeNull();
    expect(result.pending).toBe(0);
    expect(result.sent.map((e) => parseEnvelope(e).ok)).toEqual([true]);
  });

  it("splits batches by event count and by bytes, in sequence order, keeping every id", async () => {
    const result = await withOutbox(
      async ({ outbox, sent }) => {
        for (let seq = 1; seq <= 7; seq++)
          outbox.append(id(seq), activity({ pad: "x".repeat(seq === 5 ? 600 : 10) }));
        await outbox.drain(SOURCE);
        return keys(sent);
      },
      { maxEvents: 3, maxBytes: 800 },
    );
    // 5 is large: the batch it would overflow ends before it, and it goes alone.
    expect(result).toEqual([[1, 2, 3], [4], [5], [6, 7]]);
  });

  it("keeps rows on a failed send, backs off, and resends the same ids", async () => {
    const result = await withOutbox(async ({ outbox, sent, setSend, advance }) => {
      outbox.append(id(1), activity());
      outbox.append(id(2), activity());
      // The queue took the message but the answer was lost.
      setSend(async (envelope) => {
        sent.push(structuredClone(envelope));
        throw new Error("network");
      });
      const failed = await outbox.drain(SOURCE);
      const backoff = [outbox.dueAt(), outbox.pending()];
      const failedAgain = await outbox.drain(SOURCE);
      const longer = outbox.dueAt();
      setSend(async (envelope) => {
        sent.push(structuredClone(envelope));
      });
      advance(10_000);
      const ok = await outbox.drain(SOURCE);
      return { failed: failed.ok, failedAgain: failedAgain.ok, backoff, longer, ok, sent };
    });
    expect(result.failed).toBe(false);
    expect(result.failedAgain).toBe(false);
    expect(result.backoff).toEqual([1_000_000 + OUTBOX_POLICY.backoffMs, 2]);
    expect(result.longer).toBe(1_000_000 + 2 * OUTBOX_POLICY.backoffMs);
    expect(result.ok).toEqual({ ok: true, sent: 2, remaining: false });
    expect(keys(result.sent)).toEqual([
      [1, 2],
      [1, 2],
      [1, 2],
    ]);
    expect(result.sent[0]).toEqual(result.sent[2]);
  });

  it("never deletes rows appended while a send was in flight", async () => {
    const result = await withOutbox(
      async ({ outbox, sent, setSend }) => {
        outbox.append(id(1), activity());
        setSend(async (envelope) => {
          sent.push(structuredClone(envelope));
          // A write commits during the send.
          outbox.append(id(2), activity());
        });
        const drained = await outbox.drain(SOURCE);
        return { drained, pending: outbox.pending(), due: outbox.dueAt(), sent: keys(sent) };
      },
      { maxBatches: 1 },
    );
    expect(result.sent).toEqual([[1]]);
    expect(result.drained).toEqual({ ok: true, sent: 1, remaining: true });
    expect(result.pending).toBe(1);
    expect(result.due).toBe(1_000_000);
  });

  it("stores an oversized event's row and data by id, and the drain goes on", async () => {
    const result = await withOutbox(
      async ({ outbox, sent, storage }) => {
        outbox.append(id(1), activity({ pad: "x".repeat(2_000) }));
        outbox.append(id(2), activity());
        await outbox.drain(SOURCE);
        const payloads = storage.sql
          .exec<{ event_key: string; payload: string }>(
            "SELECT event_key, payload FROM event_payloads",
          )
          .toArray();
        return { sent, payloads };
      },
      { storeAboveBytes: 1_000 },
    );
    const events = result.sent.flatMap((e) => e.events);
    expect(events.map((e) => [e.id.sourceSeq, e.stored, e.data])).toEqual([
      [1, true, null],
      [2, false, {}],
    ]);
    expect(result.payloads).toHaveLength(1);
    expect(result.payloads[0]?.event_key).toBe(`${SOURCE}:1:1`);
    expect(JSON.parse(result.payloads[0]?.payload ?? "{}").data.pad).toHaveLength(2_000);
    expect(result.sent.every((e) => parseEnvelope(e).ok)).toBe(true);
  });

  it("keeps a sent event's stored payload for the retention after it was sent, then deletes it", async () => {
    const result = await withOutbox(
      async ({ outbox, storage, setSend, advance }) => {
        const count = () =>
          storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM event_payloads").one().n;
        // The queue is down for eight days: the event waits, its payload with it.
        setSend(async () => {
          throw new Error("queue down");
        });
        outbox.append(id(1), activity({ pad: "x".repeat(2_000) }));
        advance(8 * 24 * 60 * 60 * 1_000);
        await outbox.drain(SOURCE);
        const whileUnsent = { count: count(), pruneDue: outbox.dueAt() };
        setSend(async () => {});
        await outbox.drain(SOURCE);
        const sentAt = 1_000_000 + 8 * 24 * 60 * 60 * 1_000;
        // Kept for the whole retention after it was sent.
        const due = outbox.dueAt();
        advance(OUTBOX_POLICY.payloadRetentionMs - 1);
        outbox.prunePayloads();
        const justBefore = count();
        advance(1);
        outbox.prunePayloads();
        return { whileUnsent, due, sentAt, justBefore, after: count(), dueAfter: outbox.dueAt() };
      },
      { storeAboveBytes: 1_000 },
    );
    expect(result.whileUnsent.count).toBe(1);
    expect(result.due).toBe(result.sentAt + OUTBOX_POLICY.payloadRetentionMs);
    expect(result).toMatchObject({ justBefore: 1, after: 0, dueAfter: null });
  });

  it("counts payloads stored before the upgrade as sent unless their event waits, and arms the alarm", async () => {
    const name = uniqueId("upgrade");
    const stub = env.REPO.getByName(name);
    // As a version-12 object left it: two payloads stored in the same
    // millisecond, one whose event was sent and one whose event waits.
    await runInDurableObject(stub, async (_: RepoDO, state) => {
      await state.storage.deleteAll();
      applyDoMigrations(state.storage, repoSchema.slice(0, 12));
      for (const seq of [1, 2])
        state.storage.sql.exec(
          "INSERT INTO event_payloads (event_key, payload, created_at) VALUES (?, '{}', 5)",
          `${SOURCE}:1:${seq}`,
        );
      const waiting = JSON.stringify({ id: id(2) });
      state.storage.sql.exec(
        "INSERT INTO outbox (source_seq, event, bytes, created_at) VALUES (2, ?, ?, 5)",
        waiting,
        waiting.length,
      );
    });
    // Woken again by the upgraded code.
    await runInDurableObject(stub, (_: RepoDO, state) => {
      state.abort("upgrade");
    }).catch(() => {});
    // A new stub (the old one stays broken): its first call starts a new
    // instance, which migrates on wake.
    const after = await runInDurableObject(env.REPO.getByName(name), async (_: RepoDO, state) => ({
      sent: state.storage.sql
        .exec<{ event_key: string; sent_at: number | null }>(
          "SELECT event_key, sent_at FROM event_payloads ORDER BY event_key",
        )
        .toArray(),
      alarm: await state.storage.getAlarm(),
    }));
    expect(after.sent).toEqual([
      { event_key: `${SOURCE}:1:1`, sent_at: 5 },
      { event_key: `${SOURCE}:1:2`, sent_at: null },
    ]);
    expect(after.alarm).not.toBeNull();
  });

  it("never brings a send forward or spins on a payload whose event cannot be sent", async () => {
    const result = await withOutbox(
      async ({ outbox, setSend, advance }) => {
        setSend(async () => {
          throw new Error("queue down");
        });
        outbox.append(id(1), activity({ pad: "x".repeat(2_000) }));
        advance(OUTBOX_POLICY.payloadRetentionMs * 2);
        await outbox.drain(SOURCE);
        // Backing off: the next attempt is in the future, whatever the payload's age.
        return {
          due: outbox.dueAt(),
          sendDue: outbox.sendDueAt(),
          now: 1_000_000 + OUTBOX_POLICY.payloadRetentionMs * 2,
        };
      },
      { storeAboveBytes: 1_000 },
    );
    expect(result.due).toBe(result.sendDue);
    expect(result.due).toBeGreaterThan(result.now);
  });

  it("keeps a sent batch whose rows could not be deleted, and sends it again with the same ids", async () => {
    const result = await withOutbox(async ({ outbox, sent, storage, advance }) => {
      outbox.append(id(1), activity());
      const failing = new Outbox(
        {
          sql: storage.sql,
          transactionSync: () => {
            throw new Error("storage reset");
          },
        },
        {
          now: () => 1_000_000,
          send: async (envelope) => {
            sent.push(structuredClone(envelope));
          },
        },
      );
      const failed = await failing.drain(SOURCE);
      advance(10_000);
      const ok = await outbox.drain(SOURCE);
      return { failed: failed.ok, ok, sent: keys(sent), same: sent[0]?.events[0]?.id };
    });
    expect(result.failed).toBe(false);
    expect(result.ok).toEqual({ ok: true, sent: 1, remaining: false });
    expect(result.sent).toEqual([[1], [1]]);
  });

  it("refuses, writing nothing, an event that cannot fit a message even without its row and data", async () => {
    const result = await withOutbox(async ({ outbox, storage }) => {
      let error = "";
      try {
        storage.transactionSync(() =>
          outbox.append(id(1), { ...activity(), actor: "u".repeat(MAX_MESSAGE_BYTES) }),
        );
      } catch (e) {
        error = (e as Error).message;
      }
      const payloads = storage.sql.exec("SELECT count(*) AS n FROM event_payloads").one().n;
      return { error, pending: outbox.pending(), payloads };
    });
    expect(result.error).toMatch(/too large for a queue message/);
    expect(result).toMatchObject({ pending: 0, payloads: 0 });
  });
});

describe("allocateEpoch", () => {
  it("starts at 1 and always increases", async () => {
    const source = uniqueId("rep");
    const epochs = [];
    for (let i = 0; i < 4; i++) epochs.push(await allocateEpoch(env.DIRECTORY, source));
    expect(epochs).toEqual([1, 2, 3, 4]);
  });
});

/** Every event the repository's outbox holds, oldest first. */
function outboxEvents(repo: RepoDO): DomainEvent[] {
  return repo.git.context.storage.sql
    .exec<{ event: string }>("SELECT event FROM outbox ORDER BY source_seq")
    .toArray()
    .map((r) => JSON.parse(r.event) as DomainEvent);
}

async function newRepoWithEvents() {
  const owner = await principalWithToken("user", "pat");
  const repoId = newId("rep");
  const stub = env.REPO.getByName(repoId);
  expect(
    await stub.initGitStorage(newNetworkId(), "refs/heads/main", {
      ownerId: owner.principalId,
      name: "events",
      visibility: "private",
      epochGen: 3,
      actor: owner.principalId,
    }),
  ).toEqual({ ok: true });
  return { stub, owner, repoId };
}

const commit = (repo: RepoDO, n: number, extra: { onCommitted?: () => void } = {}) =>
  repo.git.refStore.commitSync({
    addPacks: [],
    removePacks: [],
    refUpdates: [{ name: "refs/heads/main", oldOid: n === 1 ? null : oid(n - 1), newOid: oid(n) }],
    expectedVersion: n - 1,
    // The owner: it may write without an ACL snapshot.
    actor: { principal: repo.events.account()?.ownerId as string, tokenId: "tok_1", via: "push" },
    ...extra,
  });

describe("repository events", () => {
  it("emits the creation with the repository's identity and the allocated epoch", async () => {
    const { stub, owner, repoId } = await newRepoWithEvents();
    const events = await inRepo(stub, outboxEvents);
    expect(events).toEqual([
      expect.objectContaining({
        id: { sourceId: repoId, epochGen: 3, sourceSeq: 1 },
        type: "repo.created",
        actor: owner.principalId,
        entity: {
          type: "repo",
          id: repoId,
          version: 1,
          deleted: false,
          row: {
            ownerId: owner.principalId,
            name: "events",
            visibility: "private",
            description: null,
            defaultBranch: "refs/heads/main",
            pushedAt: null,
            createdAt: expect.any(Number),
          },
        },
      }),
    ]);
    // A retried creation changes nothing.
    await stub.initGitStorage(newNetworkId(), "refs/heads/main", {
      ownerId: owner.principalId,
      name: "events",
      visibility: "private",
      epochGen: 3,
      actor: owner.principalId,
    });
    expect(await inRepo(stub, (repo) => outboxEvents(repo).length)).toBe(1);
  });

  it("emits a snapshot, the ref updates and an audit row with every commit", async () => {
    const { stub, repoId, owner } = await newRepoWithEvents();
    const result = await inRepo(stub, (repo) => {
      commit(repo, 1);
      const audit = repo.git.context.storage.sql
        .exec(
          "SELECT epoch_gen, actor_id, token_id, action, target_id, result, details FROM audit_log",
        )
        .toArray();
      return { events: outboxEvents(repo), audit };
    });
    expect(result.events.map((e) => [e.id.sourceSeq, e.type, e.entity?.version ?? null])).toEqual([
      [1, "repo.created", 1],
      [2, "repo.updated", 2],
      [3, "refs.updated", null],
    ]);
    expect(result.events[1]?.entity?.row).toMatchObject({ pushedAt: expect.any(Number) });
    expect(result.events[2]?.data).toEqual({
      via: "push",
      part: 1,
      parts: 1,
      refs: [{ ref: "refs/heads/main", old: null, new: "01".repeat(20) }],
    });
    expect(result.audit).toEqual([
      {
        epoch_gen: 3,
        actor_id: owner.principalId,
        token_id: "tok_1",
        action: "refs.update",
        target_id: repoId,
        result: "ok",
        details: JSON.stringify({ via: "push", refs: 1 }),
      },
    ]);
  });

  it("rolls the whole commit back when writing its events fails part way", async () => {
    const { stub } = await newRepoWithEvents();
    const result = await inRepo(stub, (repo) => {
      const { sql } = repo.git.context.storage;
      const state = () => ({
        refs: repo.git.refStore.readRefsSync().version,
        reflog: sql.exec("SELECT count(*) AS n FROM reflog").one().n,
        meta: sql.exec("SELECT source_seq, version, pushed_at FROM repo_meta").one(),
        outbox: sql.exec("SELECT count(*) AS n FROM outbox").one().n,
        audit: sql.exec("SELECT count(*) AS n FROM audit_log").one().n,
      });
      const before = state();
      // The snapshot is written; the ref-update event after it fails.
      const append = repo.outbox.append.bind(repo.outbox);
      let calls = 0;
      repo.outbox.append = (id, event) => {
        if (++calls === 2) throw new Error("disk full");
        return append(id, event);
      };
      let error = "";
      try {
        commit(repo, 1);
      } catch (e) {
        error = (e as Error).message;
      } finally {
        repo.outbox.append = append;
      }
      return { error, calls, before, after: state() };
    });
    expect(result.error).toBe("disk full");
    expect(result.calls).toBe(2);
    expect(result.after).toEqual(result.before);
  });

  it("splits the ref updates of a large commit into events of at most REFS_PER_EVENT refs", async () => {
    const { stub } = await newRepoWithEvents();
    const events = await inRepo(stub, (repo) => {
      const refUpdates = Array.from({ length: REFS_PER_EVENT * 2 + 1 }, (_, i) => ({
        name: `refs/heads/b${i}`,
        oldOid: null,
        newOid: oid(1),
      }));
      repo.git.refStore.commitSync({
        addPacks: [],
        removePacks: [],
        refUpdates,
        expectedVersion: 0,
      });
      return outboxEvents(repo).filter((e) => e.type === "refs.updated");
    });
    expect(events).toHaveLength(3);
    const payloads = await inRepo(stub, (repo) =>
      repo.git.context.storage.sql
        .exec<{ payload: string }>("SELECT payload FROM event_payloads")
        .toArray()
        .map((r) => JSON.parse(r.payload).data as { part: number; parts: number; refs: unknown[] }),
    );
    const parts = [...events.filter((e) => !e.stored).map((e) => e.data), ...payloads] as {
      part: number;
      parts: number;
      refs: unknown[];
    }[];
    expect(parts.map((p) => [p.part, p.parts, p.refs.length]).sort()).toEqual([
      [1, 3, REFS_PER_EVENT],
      [2, 3, REFS_PER_EVENT],
      [3, 3, 1],
    ]);
  });

  it("emits a snapshot when HEAD moves to another branch outside a commit", async () => {
    const { stub } = await newRepoWithEvents();
    const events = await inRepo(stub, (repo) => {
      const { storage } = repo.git.context;
      storage.transactionSync(() => repo.git.refStore.setHead("refs/heads/master"));
      // The same target again changes nothing.
      storage.transactionSync(() => repo.git.refStore.setHead("refs/heads/master"));
      return outboxEvents(repo);
    });
    expect(events.map((e) => [e.type, e.entity?.version, e.entity?.row?.defaultBranch])).toEqual([
      ["repo.created", 1, "refs/heads/main"],
      ["repo.updated", 2, "refs/heads/master"],
    ]);
  });

  it("changes nothing when asked to create a repository with another identity", async () => {
    const { stub, owner } = await newRepoWithEvents();
    const networkBefore = await inRepo(stub, (repo) => repo.git.networkId());
    const retried = await stub.initGitStorage(newNetworkId(), "refs/heads/main", {
      ownerId: owner.principalId,
      name: "other-name",
      visibility: "private",
      epochGen: 3,
      actor: owner.principalId,
    });
    expect(retried).toEqual({
      ok: false,
      error: "the repository was created with another identity",
    });
    expect(await inRepo(stub, (repo) => [repo.git.networkId(), outboxEvents(repo).length])).toEqual(
      [networkBefore, 1],
    );
  });

  it("emits nothing for an object created without an identity", async () => {
    const stub = env.REPO.getByName(uniqueId("repo-bare"));
    await stub.initGitStorage(newNetworkId());
    const events = await inRepo(stub, (repo) => {
      commit(repo, 1);
      return outboxEvents(repo).length;
    });
    expect(events).toBe(0);
  });

  it("drains through the alarm, which it shares with the job queue", async () => {
    const { stub } = await newRepoWithEvents();
    const before = await runInDurableObject(stub, async (repo: RepoDO, state) => {
      const due = repo.outbox.dueAt();
      // A job due later must not push the drain back.
      repo.git.jobs.enqueue("reflog_prune", null, Date.now() + 60 * 60 * 1000);
      return { due, alarm: await state.storage.getAlarm() };
    });
    expect(before.alarm).toBe(before.due);

    const sent: Envelope[] = [];
    await runInDurableObject(stub, (repo: RepoDO, state) => {
      repo.sendEvents = async (envelope) => {
        sent.push(envelope);
      };
      // Due now.
      state.storage.sql.exec("UPDATE outbox_state SET next_drain_at = 1");
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(sent.flatMap((e) => e.events.map((x) => x.type))).toEqual(["repo.created"]);

    const after = await runInDurableObject(stub, async (repo: RepoDO, state) => ({
      pending: repo.outbox.pending(),
      alarm: await state.storage.getAlarm(),
      job: repo.git.jobs.nextAt(),
    }));
    expect(after.pending).toBe(0);
    expect(after.alarm).toBe(after.job);
  });

  it("creates a repository through the API with its epoch and creation event", async () => {
    const owner = await principalWithToken("user", "pat");
    const name = uniqueId("api-events");
    const res = await exports.default.fetch(`${ORIGIN}/api/user/repos`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${owner.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ name }),
    });
    expect(res.status).toBe(201);
    const { id } = await res.json<{ id: string }>();
    const epoch = await env.DIRECTORY.prepare(
      "SELECT epoch_gen FROM source_epochs WHERE source_id = ?",
    )
      .bind(id)
      .first<{ epoch_gen: number }>();
    expect(epoch?.epoch_gen).toBe(1);
    const events = await inRepo(env.REPO.getByName(id), outboxEvents);
    // Its default labels are created with it.
    expect(events.map((e) => [e.type, e.id.epochGen, e.entity?.row?.name])).toEqual([
      ["repo.created", 1, name],
      ...GITHUB_DEFAULT_LABELS.map((l) => ["label.created", 1, l.name]),
    ]);
  });
});
