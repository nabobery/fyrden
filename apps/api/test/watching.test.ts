// Watching (GitHub's repository subscriptions): the level a principal sets
// for a repository, kept by the repository and copied to the directory; the
// pushed tier's cap; watchers and authors in events' audiences behind the
// deployment's switch; a restored repository taking its watchers back from
// the copy; and the listing.

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { DomainEvent } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { WATCH_POLICY } from "../src/do/repo/watching.js";
import type { OpContext } from "../src/ops/execute.js";
import { REPO_CLEANUPS } from "../src/repos/cleanups.js";
import { copyWatch } from "../src/repos/watching.js";
import { agentFor } from "./helpers/agents.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";

type Subscription = { subscribed: boolean; ignored: boolean; reason: null; url: string };

/** A repository of `owner`'s, which `readers` read (collaborators with `pull`). */
async function repoOf(owner: Who, readers: readonly Who[] = []) {
  const made = await json<{ id: string; name: string }>(
    api("POST", "/user/repos", owner.token, { name: uniqueId("w") }),
  );
  expect(made.status).toBe(201);
  const fullName = `${owner.handle}/${made.body.name}`;
  for (const reader of readers)
    expect(
      (
        await api("PUT", `/repos/${fullName}/collaborators/${reader.handle}`, owner.token, {
          permission: "pull",
        })
      ).status,
    ).toBeLessThan(300);
  return { ...made.body, fullName };
}

const subscription = (who: Who, fullName: string) =>
  json<Subscription>(api("GET", `/repos/${fullName}/subscription`, who.token));

const watch = (who: Who, fullName: string, body: Record<string, boolean>) =>
  json<Subscription>(api("PUT", `/repos/${fullName}/subscription`, who.token, body));

/** The directory's copy of a principal's level for a repository. */
const copied = (principal: string, repoId: string) =>
  env.DIRECTORY.prepare(
    "SELECT level, revision FROM watch_preferences WHERE principal_id = ? AND repo_id = ?",
  )
    .bind(principal, repoId)
    .first<{ level: string; revision: number }>();

/** Turns the repository's watch audiences on or off (the deployment's switch, for this object). */
const audiences = (repoId: string, on: boolean) =>
  runInDurableObject(env.REPO.getByName(repoId), (instance: RepoDO) => {
    instance.watchAudiences = on;
  });

describe("a repository subscription", () => {
  it("is set, read, ignored and deleted as GitHub's, and copied to the directory", async () => {
    const [owner, reader] = [await user(), await user()];
    const repo = await repoOf(owner, [reader]);
    expect((await subscription(reader, repo.fullName)).status).toBe(404);
    const watched = await watch(reader, repo.fullName, { subscribed: true });
    expect(watched).toMatchObject({
      status: 200,
      body: { subscribed: true, ignored: false, reason: null },
    });
    expect(watched.body.url).toMatch(new RegExp(`/api/repos/${repo.fullName}/subscription$`));
    expect(await subscription(reader, repo.fullName)).toMatchObject({
      status: 200,
      body: { subscribed: true },
    });
    expect(await copied(reader.principalId, repo.id)).toEqual({ level: "watching", revision: 1 });
    // Ignoring wins over subscribing.
    expect(await watch(reader, repo.fullName, { subscribed: true, ignored: true })).toMatchObject({
      body: { subscribed: false, ignored: true },
    });
    expect(await copied(reader.principalId, repo.id)).toEqual({ level: "ignoring", revision: 2 });
    // Deleted: back to participating (404), the copy too.
    expect((await api("DELETE", `/repos/${repo.fullName}/subscription`, reader.token)).status).toBe(
      200,
    );
    expect((await subscription(reader, repo.fullName)).status).toBe(404);
    expect(await copied(reader.principalId, repo.id)).toEqual({
      level: "participating",
      revision: 3,
    });
  });

  it("is refused for a repository the caller cannot read, as if it did not exist", async () => {
    const [owner, stranger] = [await user(), await user()];
    const repo = await repoOf(owner);
    expect(await watch(stranger, repo.fullName, { subscribed: true })).toMatchObject({
      status: 404,
      body: { code: "repo_not_found" },
    });
  });

  it("refuses the watcher past the cap, freeing the places of principals deleted", async () => {
    const [owner, late] = [await user(), await user()];
    const repo = await repoOf(owner, [late]);
    // At the cap (rows written as the repository would, for speed), one of them deleted.
    const gone = await user();
    await runInDurableObject(env.REPO.getByName(repo.id), (instance: RepoDO, state) => {
      state.storage.transactionSync(() => {
        for (let i = 0; i < WATCH_POLICY.maxWatchers - 1; i++)
          instance.watching.set(`usr_watcher${i}`, `usr_watcher${i}`, "watching");
        instance.watching.set(gone.principalId, gone.principalId, "watching");
      });
    });
    expect(await watch(late, repo.fullName, { subscribed: true })).toMatchObject({
      status: 409,
      body: { code: "watchers_full" },
    });
    // Ignoring or participating is never refused.
    expect((await watch(late, repo.fullName, { ignored: true })).status).toBe(200);
    await env.DIRECTORY.prepare(
      "UPDATE principals SET lifecycle = 'deleted', disabled_at = ? WHERE id = ?",
    )
      .bind(Date.now(), gone.principalId)
      .run();
    expect((await watch(late, repo.fullName, { subscribed: true })).status).toBe(200);
    expect(
      await runInDurableObject(
        env.REPO.getByName(repo.id),
        (instance: RepoDO) => instance.watching.get(gone.principalId) ?? null,
      ),
    ).toBeNull();
  });
});

describe("watch audiences", () => {
  /** The outbox's position now. */
  const seqOf = (repoId: string) =>
    runInDurableObject(
      env.REPO.getByName(repoId),
      (r: RepoDO) =>
        r.git.context.storage.sql
          .exec<{ s: number | null }>("SELECT max(source_seq) AS s FROM outbox")
          .one().s ?? 0,
    );
  /** Who the events since `from` tell, as `type principal kind priority reasons [silent]`. */
  const told = (repoId: string, from: number) =>
    runInDurableObject(env.REPO.getByName(repoId), (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ event: string }>(
          "SELECT event FROM outbox WHERE source_seq > ? ORDER BY source_seq",
          from,
        )
        .toArray()
        .map((row) => JSON.parse(row.event) as DomainEvent)
        .flatMap((e) =>
          [...(e.feed?.audience ?? []), ...(e.feed?.watchers ?? [])].map(
            (a) =>
              `${e.type} ${a.principal} ${a.kind} ${a.priority} ${a.reasons.join(",")}${a.silent ? " silent" : ""}`,
          ),
        ),
    );

  /** A repository whose `watcher` watches it, with a commenter and a closer; audiences `on` or off. */
  async function watched(on: boolean) {
    const [owner, watcher, commenter, closer] = [
      await user(),
      await user(),
      await user(),
      await user(),
    ];
    const repo = await repoOf(owner, [watcher, commenter]);
    expect(
      (
        await api("PUT", `/repos/${repo.fullName}/collaborators/${closer.handle}`, owner.token, {
          permission: "push",
        })
      ).status,
    ).toBeLessThan(300);
    await audiences(repo.id, on);
    expect((await watch(watcher, repo.fullName, { subscribed: true })).status).toBe(200);
    return { owner, watcher, commenter, closer, repo };
  }
  const open = async (who: Who, fullName: string) =>
    (
      await json<{ number: number }>(
        api("POST", `/repos/${fullName}/issues`, who.token, { title: "One" }),
      )
    ).body.number;
  const comment = (who: Who, fullName: string, number: number, body: string) =>
    api("POST", `/repos/${fullName}/issues/${number}/comments`, who.token, { body });

  it("tell watchers of new conversations and activity, P2, apart from the audience, once the switch is on", async () => {
    const { owner, watcher, commenter, repo } = await watched(true);
    const from = await seqOf(repo.id);
    const number = await open(owner, repo.fullName);
    await comment(commenter, repo.fullName, number, "a comment");
    // Watched entries ride apart (their own effect, admitted against the daily allowance): never
    // in the audience or its pages.
    const blocks = await runInDurableObject(env.REPO.getByName(repo.id), (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ event: string }>("SELECT event FROM outbox WHERE source_seq > ?", from)
        .toArray()
        .map((row) => (JSON.parse(row.event) as DomainEvent).feed)
        .filter((feed) => feed !== undefined),
    );
    expect(blocks.flatMap((b) => b.audience).filter((a) => a.priority === "P2")).toEqual([]);
    expect(blocks.map((b) => (b.watchers ?? []).map((w) => w.principal))).toEqual([
      [watcher.principalId],
      [watcher.principalId],
    ]);
    expect(await told(repo.id, from)).toEqual(
      expect.arrayContaining([
        `issue.opened ${watcher.principalId} activity P2 watching`,
        `issue_comment.created ${watcher.principalId} activity P2 watching`,
        `issue_comment.created ${owner.principalId} activity P1 author`,
      ]),
    );
  });

  it("tell no watcher, and no author of its own state change, while the switch is off", async () => {
    const { owner, watcher, closer, repo } = await watched(false);
    const from = await seqOf(repo.id);
    const number = await open(owner, repo.fullName);
    await api("PATCH", `/repos/${repo.fullName}/issues/${number}`, closer.token, {
      state: "closed",
    });
    await api("PATCH", `/repos/${repo.fullName}/issues/${number}`, owner.token, { state: "open" });
    const lines = await told(repo.id, from);
    expect(lines.filter((l) => l.includes(watcher.principalId))).toEqual([]);
    // Its author told of another's change as a participant, as before; of its own, nothing.
    expect(lines.filter((l) => l.includes(owner.principalId))).toEqual([
      `issue.closed ${owner.principalId} activity P1 author`,
    ]);
  });

  it("keep a participating watcher's activity P1, and tell an author of state changes, its own silently", async () => {
    const { owner, watcher, commenter, closer, repo } = await watched(true);
    const number = await open(owner, repo.fullName);
    await comment(watcher, repo.fullName, number, "me too");
    let from = await seqOf(repo.id);
    await comment(commenter, repo.fullName, number, "again");
    // A participant now: told as one (P1), not as a watcher too.
    expect((await told(repo.id, from)).filter((l) => l.includes(watcher.principalId))).toEqual([
      `issue_comment.created ${watcher.principalId} activity P1 commenter`,
    ]);
    // Closed by another: its author told, as `author`.
    from = await seqOf(repo.id);
    await api("PATCH", `/repos/${repo.fullName}/issues/${number}`, closer.token, {
      state: "closed",
    });
    expect(await told(repo.id, from)).toContain(
      `issue.closed ${owner.principalId} activity P1 author`,
    );
    // Reopened by its author: told, silently (its own item's state).
    from = await seqOf(repo.id);
    await api("PATCH", `/repos/${repo.fullName}/issues/${number}`, owner.token, { state: "open" });
    expect(await told(repo.id, from)).toContain(
      `issue.reopened ${owner.principalId} activity P1 author silent`,
    );
  });
});

describe("a restored repository", () => {
  it("takes its watchers back from the directory's copy, refusing commands until it has", async () => {
    const [owner, kept, unacknowledged] = [await user(), await user(), await user()];
    const repo = await repoOf(owner, [kept, unacknowledged]);
    expect((await watch(kept, repo.fullName, { subscribed: true })).status).toBe(200);
    const stub = env.REPO.getByName(repo.id);
    // As restored from a backup without the acknowledged watch, holding one never copied.
    await runInDurableObject(stub, (instance: RepoDO, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec("DELETE FROM watchers");
        instance.watching.set(unacknowledged.principalId, unacknowledged.principalId, "watching");
        instance.watching.restored(instance.events.epochGen());
        instance.git.jobs.ensure("preference_recovery", "preference_recovery");
      });
    });
    expect(await subscription(kept, repo.fullName)).toMatchObject({
      status: 503,
      body: { code: "preferences_recovering" },
    });
    expect((await watch(kept, repo.fullName, { ignored: true })).status).toBe(503);
    while (await runInDurableObject(stub, (instance: RepoDO) => instance.watching.recovering()))
      await runDurableObjectAlarm(stub);
    // The copy's state: the acknowledged watch back, the one never copied gone.
    expect(await subscription(kept, repo.fullName)).toMatchObject({
      status: 200,
      body: { subscribed: true },
    });
    expect((await subscription(unacknowledged, repo.fullName)).status).toBe(404);
  });
});

describe("a restored repository's recovery", () => {
  it("keeps a suspended principal's preference, and drops a deleted one's", async () => {
    const [owner, suspended, deleted] = [await user(), await user(), await user()];
    const repo = await repoOf(owner, [suspended, deleted]);
    for (const who of [suspended, deleted]) await watch(who, repo.fullName, { subscribed: true });
    const now = Date.now();
    await env.DIRECTORY.batch([
      env.DIRECTORY.prepare(
        "UPDATE principals SET lifecycle = 'suspended', disabled_at = ? WHERE id = ?",
      ).bind(now, suspended.principalId),
      env.DIRECTORY.prepare(
        "UPDATE principals SET lifecycle = 'deleted', disabled_at = ? WHERE id = ?",
      ).bind(now, deleted.principalId),
    ]);
    const stub = env.REPO.getByName(repo.id);
    await runInDurableObject(stub, (instance: RepoDO, state) => {
      state.storage.transactionSync(() => {
        instance.watching.restored(instance.events.epochGen());
        instance.git.jobs.ensure("preference_recovery", "preference_recovery");
      });
    });
    while (await runInDurableObject(stub, (instance: RepoDO) => instance.watching.recovering()))
      await runDurableObjectAlarm(stub);
    const levels = await runInDurableObject(stub, (instance: RepoDO) => ({
      suspended: instance.watching.get(suspended.principalId)?.level ?? null,
      deleted: instance.watching.get(deleted.principalId)?.level ?? null,
    }));
    expect(levels).toEqual({ suspended: "watching", deleted: null });
  });

  it("pages through more than a step's rows, past the cap (told at most the cap)", async () => {
    const owner = await user();
    const repo = await repoOf(owner);
    const count = 250;
    const now = Date.now();
    // The copy holds 250 watchers (more than the cap, as earlier failed copies can leave it).
    await env.DIRECTORY.batch(
      Array.from({ length: count }, (_, i) => {
        const id = `usr_w${String(i).padStart(4, "0")}${uniqueId("x").slice(-6)}`;
        return env.DIRECTORY.prepare(
          `INSERT INTO principals (id, type, handle, created_at) VALUES (?1, 'user', lower(?1), ?2)`,
        ).bind(id, now);
      }),
    );
    await env.DIRECTORY.prepare(
      `INSERT INTO watch_preferences (principal_id, repo_id, root_id, level, revision, epoch_gen, at)
       SELECT id, ?1, id, 'watching', 1, 1, ?2 FROM principals WHERE id LIKE 'usr_w%' AND created_at = ?2`,
    )
      .bind(repo.id, now)
      .run();
    const stub = env.REPO.getByName(repo.id);
    await runInDurableObject(stub, (instance: RepoDO, state) => {
      state.storage.transactionSync(() => {
        instance.watching.restored(instance.events.epochGen());
        instance.git.jobs.ensure("preference_recovery", "preference_recovery");
      });
    });
    // An alarm ends after a full page of 200: clearing (nothing to clear) with the first import
    // page, then the second.
    let alarms = 0;
    while (await runInDurableObject(stub, (instance: RepoDO) => instance.watching.recovering())) {
      await runDurableObjectAlarm(stub);
      alarms++;
    }
    expect(alarms).toBe(2);
    const after = await runInDurableObject(stub, (instance: RepoDO, state) => ({
      rows: state.storage.sql
        .exec<{ n: number }>("SELECT count(*) AS n FROM watchers WHERE level = 'watching'")
        .one().n,
      candidates: instance.watching.candidates(),
    }));
    expect(after.rows).toBe(count);
    expect(after.candidates.watchers).toHaveLength(WATCH_POLICY.maxWatchers);
    expect(after.candidates.overflow).toBe(true);
  });
});

describe("a preference command's copy", () => {
  it("answers 503 when the repository was restored since the command's generation", async () => {
    const [owner, reader] = [await user(), await user()];
    const repo = await repoOf(owner, [reader]);
    expect((await watch(reader, repo.fullName, { subscribed: true })).status).toBe(200);
    // A restore allocated the next generation; this instance has not taken it yet.
    await env.DIRECTORY.prepare(
      "UPDATE source_epochs SET epoch_gen = epoch_gen + 1 WHERE source_id = ?",
    )
      .bind(repo.id)
      .run();
    expect(await watch(reader, repo.fullName, { ignored: true })).toMatchObject({
      status: 503,
      body: { code: "preferences_recovering" },
    });
    // The copy kept the acknowledged level.
    expect(await copied(reader.principalId, repo.id)).toEqual({ level: "watching", revision: 1 });
  });

  it("is never answered as done when the principal was suspended before it was written", async () => {
    const [owner, reader] = [await user(), await user()];
    const repo = await repoOf(owner, [reader]);
    expect((await watch(reader, repo.fullName, { subscribed: true })).status).toBe(200);
    // The repository took an unwatch (revision 2); the principal is suspended before its copy.
    await env.DIRECTORY.prepare(
      "UPDATE principals SET lifecycle = 'suspended', disabled_at = ? WHERE id = ?",
    )
      .bind(Date.now(), reader.principalId)
      .run();
    const ctx = { env, metrics: { count: () => {} } } as unknown as OpContext;
    const unwatch = {
      principal: reader.principalId,
      root: reader.principalId,
      level: "participating" as const,
      epochGen: 1,
      revision: 2,
      at: Date.now(),
    };
    await expect(copyWatch(ctx, repo.id, unwatch)).rejects.toMatchObject({
      status: 503,
      code: "preferences_unavailable",
    });
    expect(await copied(reader.principalId, repo.id)).toEqual({ level: "watching", revision: 1 });
    // The same command again once copied: done.
    await env.DIRECTORY.prepare(
      "UPDATE principals SET lifecycle = 'active', disabled_at = NULL WHERE id = ?",
    )
      .bind(reader.principalId)
      .run();
    await copyWatch(ctx, repo.id, unwatch);
    await copyWatch(ctx, repo.id, unwatch);
    expect(await copied(reader.principalId, repo.id)).toEqual({
      level: "participating",
      revision: 2,
    });
  });

  it("is deleted a page at a time by its repository's deletion cleanups", async () => {
    const [owner, reader] = [await user(), await user()];
    const repo = await repoOf(owner, [reader]);
    await watch(reader, repo.fullName, { subscribed: true });
    await env.DIRECTORY.prepare("UPDATE repos SET state = 'deleting' WHERE id = ?")
      .bind(repo.id)
      .run();
    const cleanup = REPO_CLEANUPS.find((c) => c.name === "preferences");
    if (!cleanup) throw new Error("no such cleanup");
    while ((await cleanup.page(env, { repoId: repo.id, shard: "", gen: 1 })) !== "done");
    expect(await copied(reader.principalId, repo.id)).toBeNull();
  });
});

describe("the listing of watched repositories", () => {
  it("lists only what its repository says is watched, and answers 503 while one recovers", async () => {
    const [owner, reader] = [await user(), await user()];
    const [a, b] = [await repoOf(owner, [reader]), await repoOf(owner, [reader])];
    for (const repo of [a, b]) await watch(reader, repo.fullName, { subscribed: true });
    // A's unwatch reached the repository, its copy write lost.
    await runInDurableObject(env.REPO.getByName(a.id), (instance: RepoDO, state) => {
      state.storage.transactionSync(() =>
        instance.watching.set(reader.principalId, reader.principalId, "participating"),
      );
    });
    const listed = await json<{ repos: { id: string }[] }>(
      api("GET", "/user/subscriptions", reader.token),
    );
    expect(listed.body.repos.map((r) => r.id)).toEqual([b.id]);
    // B restored, taking its watchers back: the listing waits for it.
    await runInDurableObject(env.REPO.getByName(b.id), (instance: RepoDO, state) => {
      state.storage.transactionSync(() => instance.watching.restored(instance.events.epochGen()));
    });
    expect(await json(api("GET", "/user/subscriptions", reader.token))).toMatchObject({
      status: 503,
      body: { code: "preferences_recovering" },
    });
  });

  it("refuses a delegated token, whose pages would depend on what it may not read", async () => {
    const reader = await user();
    const agent = await agentFor(reader, ["watching:read", "metadata:read"]);
    expect(await json(api("GET", "/user/subscriptions", agent.delegated))).toMatchObject({
      status: 403,
      body: { code: "delegated_listing" },
    });
  });

  it("lists what the caller watches and reads, page by page, its continuation bound to it", async () => {
    const [owner, reader] = [await user(), await user()];
    const [a, b] = [await repoOf(owner, [reader]), await repoOf(owner, [reader])];
    for (const repo of [a, b]) await watch(reader, repo.fullName, { subscribed: true });
    const first = await json<{ repos: { id: string }[]; next_cursor: string | null }>(
      api("GET", "/user/subscriptions?per_page=1", reader.token),
    );
    expect(first.body.repos).toHaveLength(1);
    expect(first.body.next_cursor).not.toBeNull();
    const second = await json<{ repos: { id: string }[]; next_cursor: string | null }>(
      api("GET", `/user/subscriptions?per_page=1&cursor=${first.body.next_cursor}`, reader.token),
    );
    expect([...first.body.repos, ...second.body.repos].map((r) => r.id).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    // Another credential's continuation, or another page size: refused.
    const other = await scopedToken(reader.principalId, ["watching:read", "metadata:read"]);
    for (const [path, token] of [
      [`/user/subscriptions?per_page=1&cursor=${first.body.next_cursor}`, other],
      [`/user/subscriptions?per_page=2&cursor=${first.body.next_cursor}`, reader.token],
    ] as const)
      expect(await json(api("GET", path, token))).toMatchObject({
        status: 422,
        body: { code: "invalid_cursor" },
      });
  });
});
