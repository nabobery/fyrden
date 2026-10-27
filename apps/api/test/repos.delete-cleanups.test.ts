// Deleting a repository removes what it left outside its own storage (its
// journaled effects, webhook deliveries, their attempts and bodies, its search
// projections) before its storage goes, each cleanup recorded once done, so an
// interrupted deletion resumes where it stopped. Once its tombstone is in the read
// model, nothing new of it gets in.
import { env, exports } from "cloudflare:workers";
import type { DomainEvent } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, it } from "vitest";
import type { RepoExport } from "../src/do/repo/events.js";
import { type Effect, type EffectSink, effectStatements } from "../src/effects/journal.js";
import { DEFAULT_ORG_SHARD } from "../src/events/read-model.js";
import { CLEANUP_POLICY, REPO_CLEANUPS, runCleanups } from "../src/repos/cleanups.js";
import { advanceDeletion, keepTombstone, markDeletions } from "../src/repos/deletion.js";
import { bodyKeyOf, deliveryIdOf, webhookSink } from "../src/webhooks/sink.js";
import type { Owner } from "./helpers/network.js";
import { principalWithToken } from "./helpers/principals.js";

const ORIGIN = "https://fyrden.test";

let user: Owner;
let handle: string;

beforeAll(async () => {
  user = await principalWithToken("user", "git");
  handle = user.principalId.toLowerCase().replace("_", "-");
});

function api(method: string, path: string, body?: unknown) {
  return exports.default.fetch(`${ORIGIN}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${user.token}`,
      ...(method !== "GET" && { "Idempotency-Key": crypto.randomUUID() }),
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

async function createRepo(): Promise<{ id: string; name: string }> {
  const name = uniqueId("doomed");
  const res = await api("POST", "/user/repos", { name });
  expect(res.status).toBe(201);
  const { id } = await res.json<{ id: string }>();
  return { id, name };
}

/** Marks the repository for deletion, without advancing it. */
async function mark(repo: { id: string; name: string }): Promise<void> {
  const marked = await markDeletions(env, [{ id: repo.id, ownerHandle: handle, name: repo.name }], {
    actorId: user.principalId,
  });
  expect(marked.has(repo.id)).toBe(true);
}

/** Marks the repository for deletion, then advances the job until it is done. */
async function deleteFully(repo: { id: string; name: string }): Promise<void> {
  await mark(repo);
  for (let i = 0; i < 10; i++) if ((await advanceDeletion(env, repo.id)) === "deleted") return;
  throw new Error("the deletion did not finish");
}

/**
 * What a repository left in the org database and R2: `effects` journaled
 * effects (one done), `deliveries` webhook deliveries with an attempt each,
 * and a body for each delivery, owned by a payload row.
 */
async function leaveTraces(repoId: string, effects: number, deliveries: number): Promise<void> {
  await env.ORG_READ.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
     INSERT INTO effects (effect_id, sink, target, payload, state, next_attempt_at, created_at,
       source_id)
     SELECT ?1 || ':1:' || i || ':webhooks:hooks', 'webhooks', 'hooks', '{}',
       CASE WHEN i = 1 THEN 'done' ELSE 'pending' END, 0, 0, ?1 FROM n`,
  )
    .bind(repoId, effects)
    .run();
  await env.ORG_READ.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
     INSERT INTO webhook_deliveries (delivery_id, repo_id, hook_id, event, action, private,
       payload_key, state, attempts, next_attempt_at, created_at, updated_at, expires_at)
     SELECT ?1 || '-' || i, ?1, 1, 'push', NULL, 0, 'webhooks/' || ?1 || '/' || i || '.json',
       CASE WHEN i % 2 = 0 THEN 'pending' ELSE 'done' END, 1, 0, 0, 0, 9e15 FROM n`,
  )
    .bind(repoId, deliveries)
    .run();
  await env.ORG_READ.prepare(
    `INSERT INTO webhook_attempts (delivery_id, n, at, status)
     SELECT delivery_id, 1, 0, 200 FROM webhook_deliveries WHERE repo_id = ?`,
  )
    .bind(repoId)
    .run();
  await env.ORG_READ.prepare(
    `INSERT INTO webhook_payloads (event_key, repo_id, payload_key, state, bytes, expires_at)
     SELECT delivery_id, repo_id, payload_key, 'established', 2, 9e15
     FROM webhook_deliveries WHERE repo_id = ?`,
  )
    .bind(repoId)
    .run();
  for (let i = 1; i <= deliveries; i++) await env.ASSETS.put(`webhooks/${repoId}/${i}.json`, "{}");
  // A search projection of each kind, and its search state.
  await env.ORG_READ.batch([
    env.ORG_READ.prepare(
      `INSERT INTO search_docs (repo_id, number, kind, deleted, epoch_gen, owner_gen, version,
         updated_seq) VALUES (?, 1, 1, 1, 1, 1, 1, 1)`,
    ).bind(repoId),
    env.ORG_READ.prepare(
      `INSERT INTO search_labels (repo_id, label_id, deleted, epoch_gen, owner_gen, version,
         updated_seq) VALUES (?, 1, 1, 1, 1, 1, 1)`,
    ).bind(repoId),
    env.ORG_READ.prepare(
      `INSERT INTO search_milestones (repo_id, number, deleted, epoch_gen, owner_gen, version,
         updated_seq) VALUES (?, 1, 1, 1, 1, 1, 1)`,
    ).bind(repoId),
    env.ORG_READ.prepare(
      "INSERT INTO search_sources (repo_id, cutoff_epoch, cutoff_seq) VALUES (?, 1, 1)",
    ).bind(repoId),
  ]);
}

const count = async (sql: string, ...values: unknown[]) =>
  (
    await env.ORG_READ.prepare(sql)
      .bind(...values)
      .first<{ n: number }>()
  )?.n ?? 0;

/** What is left of the repository's traces. */
async function traces(repoId: string) {
  const bodies = await env.ASSETS.list({ prefix: `webhooks/${repoId}/` });
  return {
    effects: await count(
      "SELECT count(*) AS n FROM effects WHERE substr(effect_id, 1, length(?1) + 1) = ?1 || ':'",
      repoId,
    ),
    deliveries: await count(
      "SELECT count(*) AS n FROM webhook_deliveries WHERE repo_id = ?",
      repoId,
    ),
    attempts: await count(
      `SELECT count(*) AS n FROM webhook_attempts WHERE delivery_id IN
         (SELECT delivery_id FROM webhook_deliveries WHERE repo_id = ?1)
         OR substr(delivery_id, 1, length(?1) + 1) = ?1 || '-'`,
      repoId,
    ),
    payloads: await count("SELECT count(*) AS n FROM webhook_payloads WHERE repo_id = ?", repoId),
    bodies: bodies.objects.length,
    search: await count(
      `SELECT (SELECT count(*) FROM search_docs WHERE repo_id = ?1)
         + (SELECT count(*) FROM search_labels WHERE repo_id = ?1)
         + (SELECT count(*) FROM search_milestones WHERE repo_id = ?1)
         + (SELECT count(*) FROM search_sources WHERE repo_id = ?1) AS n`,
      repoId,
    ),
  };
}

const NONE = { effects: 0, deliveries: 0, attempts: 0, payloads: 0, bodies: 0, search: 0 };

function deletion(repoId: string) {
  return env.DIRECTORY.prepare(
    "SELECT step, attempts, last_error, tombstone FROM repo_deletions WHERE repo_id = ?",
  )
    .bind(repoId)
    .first<{ step: string; attempts: number; last_error: string | null; tombstone: string }>();
}

async function cleanupsDone(repoId: string): Promise<string[]> {
  const { results } = await env.DIRECTORY.prepare(
    "SELECT cleanup FROM repo_deletion_cleanups WHERE repo_id = ? AND done_at IS NOT NULL",
  )
    .bind(repoId)
    .all<{ cleanup: string }>();
  return results.map((r) => r.cleanup).sort();
}

/** `env` whose R2 listing of `prefix` fails once. */
function listFailingOnce(prefix: string): Env {
  let failed = false;
  const assets = new Proxy(env.ASSETS, {
    get(target, prop) {
      if (prop !== "list") return Reflect.get(target, prop).bind(target);
      return (options?: R2ListOptions) => {
        if (!failed && options?.prefix === prefix) {
          failed = true;
          return Promise.reject(new Error("R2 list failed"));
        }
        return target.list(options);
      };
    },
  });
  return new Proxy(env, {
    get: (target, prop) => (prop === "ASSETS" ? assets : Reflect.get(target, prop)),
  });
}

/** An event of the repository after the tombstone's, which every fence but deletion admits. */
function laterEvent(tombstone: RepoExport): DomainEvent {
  return {
    id: {
      sourceId: tombstone.sourceId,
      epochGen: tombstone.epochGen,
      sourceSeq: tombstone.watermark + 1,
    },
    type: "repo.updated",
    at: 0,
    actor: null,
    actChain: [],
    ownerGen: tombstone.ownerGen,
  } as unknown as DomainEvent;
}

describe("repository deletion cleanups", () => {
  it("removes the repository's effects, webhook deliveries, attempts, bodies and search projections, and no other repository's", async () => {
    const doomed = await createRepo();
    const kept = await createRepo();
    await leaveTraces(doomed.id, 3, 4);
    await leaveTraces(kept.id, 3, 4);

    await deleteFully(doomed);

    expect(await traces(doomed.id)).toEqual(NONE);
    expect(await traces(kept.id)).toEqual({
      effects: 3,
      deliveries: 4,
      attempts: 4,
      payloads: 4,
      bodies: 4,
      search: 4,
    });
    expect(await cleanupsDone(doomed.id)).toEqual(REPO_CLEANUPS.map((c) => c.name).sort());
  });

  it("goes a page at a time within a call's budget, and later calls finish", async () => {
    const repo = await createRepo();
    // More than a page of each kind.
    await leaveTraces(repo.id, CLEANUP_POLICY.effectsPage + 1, CLEANUP_POLICY.deliveriesPage + 1);
    await mark(repo);
    const target = { repoId: repo.id, shard: DEFAULT_ORG_SHARD, gen: 0 };

    // The repository's webhook effects are settled (ended, a page at a time; none was
    // claimed), then one page of effects and nothing else yet.
    for (let i = 0; i < 3; i++) expect(await runCleanups(env, target, { pages: 1 })).toBe(false);
    expect(await traces(repo.id)).toMatchObject({
      effects: 1,
      deliveries: CLEANUP_POLICY.deliveriesPage + 1,
    });
    expect(await cleanupsDone(repo.id)).toEqual(["webhook_effects"]);

    let calls = 3;
    for (;;) {
      calls++;
      if (await runCleanups(env, target, { pages: 1 })) break;
    }
    expect(await traces(repo.id)).toEqual(NONE);
    // Settling: two pages; effects: two; deliveries: two; payloads: two; search: one; watch
    // preferences: one; bodies: one listing of up to 1,000 keys.
    expect(calls).toBe(11);
    expect(await cleanupsDone(repo.id)).toEqual(REPO_CLEANUPS.map((c) => c.name).sort());
  });

  it("waits for an effect being delivered before removing deliveries and bodies", async () => {
    const repo = await createRepo();
    await leaveTraces(repo.id, 2, 2);
    // A delivery holds the second effect: it may still be making deliveries and storing bodies.
    await env.ORG_READ.prepare(
      "UPDATE effects SET lease_token = 'held', lease_until = 9e15 WHERE effect_id = ?",
    )
      .bind(`${repo.id}:1:2:webhooks:hooks`)
      .run();
    await mark(repo);
    const target = { repoId: repo.id, shard: DEFAULT_ORG_SHARD, gen: 0 };

    expect(await runCleanups(env, target)).toBe(false);
    expect(await traces(repo.id)).toEqual({
      effects: 2,
      deliveries: 2,
      attempts: 2,
      payloads: 2,
      bodies: 2,
      search: 4,
    });
    expect(await cleanupsDone(repo.id)).toEqual([]);

    // The delivery ended (its lease released or lapsed).
    await env.ORG_READ.prepare(
      "UPDATE effects SET lease_token = NULL, lease_until = NULL WHERE effect_id = ?",
    )
      .bind(`${repo.id}:1:2:webhooks:hooks`)
      .run();
    expect(await runCleanups(env, target)).toBe(true);
    expect(await traces(repo.id)).toEqual(NONE);
  });

  it("waits until a webhook effect's deliveries could no longer be being made", async () => {
    const repo = await createRepo();
    await leaveTraces(repo.id, 3, 2);
    const id = (i: number) => `${repo.id}:1:${i}:webhooks:hooks`;
    // The first was made just now; the second was claimed, and its claim lapsed: whoever
    // claimed it may still be making its deliveries. The third was never claimed.
    const now = Date.now();
    await env.ORG_READ.prepare(
      `UPDATE effects SET attempts = 1, done_at = CASE WHEN effect_id = ?1 THEN ?3 END
       WHERE effect_id IN (?1, ?2)`,
    )
      .bind(id(1), id(2), now)
      .run();
    await mark(repo);
    const target = { repoId: repo.id, shard: DEFAULT_ORG_SHARD, gen: 0 };

    expect(await runCleanups(env, target)).toBe(false);
    expect(await traces(repo.id)).toEqual({
      effects: 3,
      deliveries: 2,
      attempts: 2,
      payloads: 2,
      bodies: 2,
      search: 4,
    });
    // The claimed one is ended, as its next claim would end it.
    const ended = await env.ORG_READ.prepare(
      "SELECT state, last_error, next_attempt_at FROM effects WHERE effect_id = ?",
    )
      .bind(id(2))
      .first<{ state: string; last_error: string; next_attempt_at: number }>();
    expect(ended).toMatchObject({
      state: "failed",
      last_error: "invalidated: its source was deleted",
    });
    expect(ended?.next_attempt_at).toBeGreaterThanOrEqual(now);

    // Once the queue's longest invocation has passed since each ended, the cleanups go on.
    await env.ORG_READ.prepare(
      `UPDATE effects SET done_at = done_at - ?2, next_attempt_at = next_attempt_at - ?2
       WHERE effect_id IN (SELECT value FROM json_each(?1))`,
    )
      .bind(JSON.stringify([id(1), id(2)]), CLEANUP_POLICY.settleMs)
      .run();
    expect(await runCleanups(env, target)).toBe(true);
    expect(await traces(repo.id)).toEqual(NONE);
  });

  it("ends the repository's pending webhook effects, and settles those journaled before claims were counted", async () => {
    const repo = await createRepo();
    await leaveTraces(repo.id, 3, 0);
    const id = (i: number) => `${repo.id}:1:${i}:webhooks:hooks`;
    // The second was journaled before claims counted as attempts or effects named their
    // source: it may have been claimed, and no claim of it checks the deletion.
    await env.ORG_READ.prepare(
      "UPDATE effects SET source_id = CASE WHEN effect_id = ?2 THEN NULL ELSE ?1 END WHERE effect_id IN (?2, ?3)",
    )
      .bind(repo.id, id(2), id(3))
      .run();
    await mark(repo);
    const target = { repoId: repo.id, shard: DEFAULT_ORG_SHARD, gen: 0 };

    expect(await runCleanups(env, target)).toBe(false);
    const { results } = await env.ORG_READ.prepare(
      "SELECT effect_id, state, last_error FROM effects WHERE effect_id IN (?, ?) ORDER BY effect_id",
    )
      .bind(id(2), id(3))
      .all();
    expect(results).toEqual([
      { effect_id: id(2), state: "failed", last_error: "invalidated: its source was deleted" },
      { effect_id: id(3), state: "failed", last_error: "invalidated: its source was deleted" },
    ]);
    // Only the one that may have been claimed is waited for.
    await env.ORG_READ.prepare(
      "UPDATE effects SET next_attempt_at = next_attempt_at - ? WHERE effect_id = ?",
    )
      .bind(CLEANUP_POLICY.settleMs, id(2))
      .run();
    expect(await runCleanups(env, target)).toBe(true);
    expect(await traces(repo.id)).toEqual(NONE);
  });

  it("ends a repository's pending webhook effects a page at a time", async () => {
    const repo = await createRepo();
    await leaveTraces(repo.id, CLEANUP_POLICY.effectsPage + 2, 0);
    await mark(repo);
    const target = { repoId: repo.id, shard: DEFAULT_ORG_SHARD, gen: 0 };
    expect(await runCleanups(env, target, { pages: 1 })).toBe(false);
    expect(
      await count(
        `SELECT count(*) AS n FROM effects
         WHERE substr(effect_id, 1, length(?1) + 1) = ?1 || ':' AND state = 'pending'`,
        repo.id,
      ),
    ).toBe(1);
    expect(await cleanupsDone(repo.id)).toEqual([]);
    expect(await runCleanups(env, target, { pages: 10 })).toBe(true);
  });

  it("retries a failed cleanup and keeps the ones already done", async () => {
    const repo = await createRepo();
    await leaveTraces(repo.id, 2, 2);
    await mark(repo);

    const failing = listFailingOnce(`webhooks/${repo.id}/`);
    expect(await advanceDeletion(failing, repo.id)).toBe("deleting");
    expect(await deletion(repo.id)).toMatchObject({
      step: "cleanup",
      attempts: 1,
      last_error: "R2 list failed",
    });
    expect((await cleanupsDone(repo.id)).length).toBe(REPO_CLEANUPS.length - 1);

    expect(await advanceDeletion(failing, repo.id)).toBe("deleted");
    expect(await traces(repo.id)).toEqual(NONE);
  });

  it("keeps a tombstone of the repository entity alone", async () => {
    const repo = await createRepo();
    await deleteFully(repo);
    const tombstone = JSON.parse((await deletion(repo.id))?.tombstone ?? "null") as RepoExport;
    expect(tombstone.entities).toHaveLength(1);
    expect(tombstone.entities[0]).toMatchObject({
      type: "repo",
      id: repo.id,
      deleted: true,
    });
    // Nor does it keep one holding another entity: those go by the cleanups.
    const other = { ...tombstone.entities[0], type: "issue", id: uniqueId("iss") };
    await expect(
      keepTombstone(env, DEFAULT_ORG_SHARD, {
        ...tombstone,
        entities: [...tombstone.entities, other],
      } as RepoExport),
    ).rejects.toThrow("a tombstone is the deleted repository entity alone");
  });

  it("journals no effect of a repository whose tombstone is in the read model", async () => {
    const repo = await createRepo();
    await deleteFully(repo);
    const tombstone = JSON.parse((await deletion(repo.id))?.tombstone ?? "null") as RepoExport;
    const sink: EffectSink = {
      name: "probe",
      plan: () => [{ target: "t", payload: {} }],
      deliver: async () => {},
    };
    const db = env.ORG_READ;
    const results = await db.batch(
      effectStatements(db, [sink], repo.id, [laterEvent(tombstone)], Date.now()),
    );
    expect(results.flatMap((r) => r.results)).toEqual([]);
    expect((await traces(repo.id)).effects).toBe(0);
  });

  it("makes no webhook delivery, and leaves no body, for a repository whose tombstone is in the read model", async () => {
    const repo = await createRepo();
    await deleteFully(repo);
    const eventKey = `${repo.id}:1:99`;
    const planned = {
      repoId: repo.id,
      eventKey,
      event: "push",
      action: null,
      private: false,
      body: { event: "push" },
      hooks: [{ id: 1, v: 1 }],
    };
    const effect = { id: uniqueId("effect"), payload: planned } as unknown as Effect;

    await webhookSink.deliver(effect, env, env.ORG_READ);
    expect(await traces(repo.id)).toEqual(NONE);

    // A delivery made before the tombstone, whose body is stored after the cleanup listed
    // the repository's bodies: the body does not outlive it.
    await env.ORG_READ.prepare(
      `INSERT INTO webhook_deliveries (delivery_id, repo_id, hook_id, event, action, private,
         payload_key, state, attempts, next_attempt_at, created_at, updated_at, expires_at)
       VALUES (?1, ?2, 1, 'push', NULL, 0, ?3, 'pending', 0, 0, 0, 0, 9e15)`,
    )
      .bind(await deliveryIdOf(eventKey, 1), repo.id, await bodyKeyOf(repo.id, eventKey))
      .run();
    await webhookSink.deliver(effect, env, env.ORG_READ);
    expect((await traces(repo.id)).bodies).toBe(0);
  });
});
