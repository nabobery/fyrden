import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import type { DomainEvent, Envelope } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import type { RepoExport } from "../src/do/repo/events.js";
import { allocateEpoch } from "../src/events/epochs.js";
import { DEFAULT_ORG_SHARD } from "../src/events/read-model.js";
import { MAX_REBUILD_PAGE, rebuildReadModels, rebuildRepo } from "../src/events/rebuild.js";
import { applyEnvelope } from "../src/queues/events-consumer.js";
import { advanceDeletion, keepTombstone, markDeletions } from "../src/repos/deletion.js";
import { ORIGIN } from "./helpers/git-http.js";
import { principalWithToken } from "./helpers/principals.js";
import { inRepo, oid } from "./helpers/repo-git.js";

/**
 * What each repository's object sent, kept here instead of going to the
 * queue: its alarm sends a second after an event, which a slow run outlasts
 * before `deliver` asks for them.
 */
const sentBy = new Map<string, Envelope[]>();

function keepSends(repo: RepoDO, repoId: string): void {
  if (!sentBy.has(repoId)) sentBy.set(repoId, []);
  repo.sendEvents = async (envelope) => {
    sentBy.get(repoId)?.push(envelope);
  };
}

async function createRepo(token: string): Promise<string> {
  const res = await exports.default.fetch(`${ORIGIN}/api/user/repos`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({ name: uniqueId("rebuilt") }),
  });
  expect(res.status).toBe(201);
  const { id } = await res.json<{ id: string }>();
  await runInDurableObject(env.REPO.getByName(id), (repo: RepoDO) => keepSends(repo, id));
  return id;
}

/** Moves `refs/heads/main` to `oid(n)` (the commit after `n - 1`). */
async function commit(repoId: string, n: number) {
  await inRepo(env.REPO.getByName(repoId), async (repo) => {
    // A restarted object sends to the queue again until told otherwise.
    keepSends(repo, repoId);
    await repo.checkEpoch();
    const { version } = repo.git.refStore.state();
    const result = repo.git.refStore.commitSync({
      addPacks: [],
      removePacks: [],
      refUpdates: [
        { name: "refs/heads/main", oldOid: n === 1 ? null : oid(n - 1), newOid: oid(n) },
      ],
      expectedVersion: version,
      // The owner: it may write without an ACL snapshot.
      actor: { principal: repo.events.account()?.ownerId as string, via: "push" },
    });
    expect(result.ok).toBe(true);
  });
}

/** Drains a repository's outbox and applies what it sent (since last asked), as the consumer would. */
async function deliver(repoId: string) {
  await runInDurableObject(env.REPO.getByName(repoId), async (repo: RepoDO) => {
    keepSends(repo, repoId);
    await repo.outbox.drain(repoId);
  });
  const sent = sentBy.get(repoId)?.splice(0) ?? [];
  for (const envelope of sent) expect(await applyEnvelope(env, envelope)).toBe("applied");
  return sent.flatMap((e) => e.events);
}

/** The projected rows of `ids`, without the bookkeeping columns a rebuild writes differently. */
async function rows(ids: string[]) {
  const { results } = await env.ORG_READ.prepare(
    `SELECT repo_id, owner_id, name, visibility, default_branch, pushed_at, created_at, deleted,
       epoch_gen, version, owner_gen, description
     FROM repos WHERE repo_id IN (SELECT value FROM json_each(?)) ORDER BY repo_id`,
  )
    .bind(JSON.stringify(ids))
    .all();
  return results;
}

/** Ends the object's current instance, as a restore does. */
async function restart(repoId: string) {
  await runInDurableObject(env.REPO.getByName(repoId), (_: RepoDO, state) => {
    state.abort("restart");
  }).catch(() => {});
}

async function forget(ids: string[]) {
  await env.ORG_READ.batch([
    env.ORG_READ.prepare(
      "DELETE FROM repos WHERE repo_id IN (SELECT value FROM json_each(?))",
    ).bind(JSON.stringify(ids)),
    env.ORG_READ.prepare(
      "DELETE FROM consumer_epochs WHERE source_id IN (SELECT value FROM json_each(?))",
    ).bind(JSON.stringify(ids)),
  ]);
}

describe("read-model rebuild", () => {
  it("rebuilds from the repositories exactly what the events built, for a synthetic org", async () => {
    const owner = await principalWithToken("user", "pat");
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await createRepo(owner.token));
    const [a, b, c] = ids as [string, string, string];
    await commit(a, 1);
    await commit(a, 2);
    await commit(b, 1);
    await inRepo(env.REPO.getByName(c), (repo) => {
      keepSends(repo, c);
      repo.git.context.storage.transactionSync(() => repo.git.refStore.setHead("refs/heads/trunk"));
    });
    for (const id of ids) await deliver(id);
    // One deleted, to the end (its object erased): its row stays a tombstone.
    const gone = ids[4] as string;
    await markDeletions(env, [{ id: gone, ownerHandle: "x", name: "x" }], {
      actorId: owner.principalId,
    });
    expect(await advanceDeletion(env, gone)).toBe("deleted");
    const incremental = await rows(ids);
    expect(incremental).toHaveLength(5);
    expect(incremental.find((r) => r.repo_id === gone)).toMatchObject({ deleted: 1 });

    await forget(ids);
    expect(await rows(ids)).toEqual([]);
    let cursor: string | null = null;
    do {
      const page: { rebuilt: number; next: string | null } = await rebuildReadModels(env, cursor, {
        pageSize: 2,
      });
      cursor = page.next;
    } while (cursor !== null);
    expect(await rows(ids)).toEqual(incremental);
  });

  it("never moves a row back when a rebuild's export is older than events already applied", async () => {
    const owner = await principalWithToken("user", "pat");
    const id = await createRepo(owner.token);
    const stale = await env.REPO.getByName(id).exportSnapshot();
    await commit(id, 1);
    await deliver(id);
    const current = await rows([id]);
    const staleRepo = { getByName: () => ({ exportSnapshot: async () => stale }) };
    // A proxy, so the shared `env` is never changed.
    const staleEnv = new Proxy(env, {
      get: (target, prop) => (prop === "REPO" ? staleRepo : Reflect.get(target, prop)),
    });
    expect(await rebuildRepo(staleEnv, id)).toBe("rebuilt");
    expect(await rows([id])).toEqual(current);
    expect(current[0]).toMatchObject({ version: 2 });
  });

  it("refuses a page size outside 1 to the maximum", async () => {
    for (const pageSize of [0, -1, 1.5, MAX_REBUILD_PAGE + 1])
      await expect(rebuildReadModels(env, null, { pageSize })).rejects.toThrow(RangeError);
  });

  it("skips a repository whose deletion has not yet made its tombstone", async () => {
    const owner = await principalWithToken("user", "pat");
    const id = await createRepo(owner.token);
    await env.DIRECTORY.prepare("UPDATE repos SET state = 'deleting' WHERE id = ?").bind(id).run();
    expect(await rebuildRepo(env, id)).toBe("skipped");
  });

  it("turns a row a deleted repository left live into its tombstone", async () => {
    const owner = await principalWithToken("user", "pat");
    const id = await createRepo(owner.token);
    await commit(id, 1);
    await deliver(id);
    const live = await rows([id]);
    await markDeletions(env, [{ id, ownerHandle: "x", name: "x" }], { actorId: owner.principalId });
    expect(await advanceDeletion(env, id)).toBe("deleted");
    const tombstone = await rows([id]);
    expect(tombstone).toEqual([expect.objectContaining({ deleted: 1 })]);
    // As if the tombstone had been lost (a shard restored from before it).
    await forget([id]);
    await env.ORG_READ.prepare(
      `INSERT INTO repos (repo_id, owner_id, name, visibility, default_branch, pushed_at, created_at,
         deleted, epoch_gen, version, owner_gen, updated_seq, updated_at, description)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, ?10, 0, 0, ?11`,
    )
      .bind(
        ...(
          [
            "repo_id",
            "owner_id",
            "name",
            "visibility",
            "default_branch",
            "pushed_at",
            "created_at",
            "epoch_gen",
            "version",
            "owner_gen",
            "description",
          ] as const
        ).map((k) =>
          // Stale, unlike its tombstone: an older name and description.
          k === "name"
            ? "old-name"
            : k === "description"
              ? "old"
              : ((live[0] as Record<string, unknown>)[k] ?? null),
        ),
      )
      .run();
    expect(await rebuildRepo(env, id)).toBe("rebuilt");
    expect(await rows([id])).toEqual(tombstone);
    // A purge of an older epoch resuming late keeps nothing over the newer tombstone.
    const kept = () =>
      env.DIRECTORY.prepare("SELECT tombstone FROM repo_deletions WHERE repo_id = ?")
        .bind(id)
        .first<{ tombstone: string }>();
    const before = await kept();
    const stored = JSON.parse(before?.tombstone ?? "{}") as RepoExport;
    await keepTombstone(env, DEFAULT_ORG_SHARD, { ...stored, epochGen: stored.epochGen - 1 });
    expect(await kept()).toEqual(before);
  });
});

describe("restore epochs", () => {
  it("takes a newer epoch from the directory before committing, so a restored repository never reuses event ids", async () => {
    const owner = await principalWithToken("user", "pat");
    const id = await createRepo(owner.token);
    await commit(id, 1);
    await commit(id, 2);
    const before = await deliver(id);
    expect(await rows([id])).toEqual([expect.objectContaining({ epoch_gen: 1, version: 3 })]);

    // A restore to just after the creation: the object's state goes back,
    // and the runbook allocated the next epoch first.
    await runInDurableObject(env.REPO.getByName(id), (_: RepoDO, state) => {
      state.storage.sql.exec("UPDATE repo_meta SET version = 1, source_seq = 1, pushed_at = NULL");
    });
    expect(await allocateEpoch(env.DIRECTORY, id)).toBe(2);
    // A restore ends the object's instance; the next request starts a new one.
    await restart(id);

    // (Only the event state was rewound here; the refs moved on.)
    await commit(id, 3);
    const after = await deliver(id);
    const keys = (events: DomainEvent[]) => events.map((e) => `${e.id.epochGen}:${e.id.sourceSeq}`);
    expect(after.every((e) => e.id.epochGen === 2)).toBe(true);
    expect(keys(after).filter((k) => keys(before).includes(k))).toEqual([]);
    // The adoption snapshot (version 2) and the commit's (version 3), in epoch 2.
    expect(after.filter((e) => e.entity).map((e) => e.entity?.version)).toEqual([2, 3]);
    expect(await rows([id])).toEqual([expect.objectContaining({ epoch_gen: 2, version: 3 })]);
  });

  it("schedules the new epoch's snapshot when nothing else is written, reading the directory once for concurrent writers", async () => {
    const owner = await principalWithToken("user", "pat");
    const id = await createRepo(owner.token);
    await deliver(id);
    await allocateEpoch(env.DIRECTORY, id);
    await restart(id);
    const result = await runInDurableObject(env.REPO.getByName(id), async (repo: RepoDO, state) => {
      await state.storage.deleteAlarm();
      let reads = 0;
      const read = async () => {
        reads++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return 2;
      };
      await Promise.all([repo.events.checkEpoch(read), repo.events.checkEpoch(read)]);
      // The RPC arms the alarm for the snapshot it may have written.
      await repo.checkEpoch();
      return {
        reads,
        pending: repo.outbox.pending(),
        alarm: await state.storage.getAlarm(),
        due: repo.outbox.dueAt(),
      };
    });
    expect(result.reads).toBe(1);
    expect(result.pending).toBe(1);
    expect(result.alarm).toBe(result.due);
  });

  it("refuses a commit before the epoch was checked", async () => {
    const owner = await principalWithToken("user", "pat");
    const id = await createRepo(owner.token);
    await restart(id);
    const error = await inRepo(env.REPO.getByName(id), (repo) => {
      try {
        repo.git.refStore.commitSync({
          addPacks: [],
          removePacks: [],
          refUpdates: [{ name: "refs/heads/main", oldOid: null, newOid: oid(1) }],
          expectedVersion: 0,
        });
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(error).toBe("the repository's epoch must be checked before it commits");
  });
});
