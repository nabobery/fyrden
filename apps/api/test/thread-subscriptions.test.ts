// Thread subscriptions (a Fyrden extension, Gitea's route): a principal's
// preference for one issue or pull request of a repository it reads,
// subscribed or unsubscribed, kept by the repository under the
// conversation's identity and copied to the directory; its caps; subscribers
// in events' audiences behind the deployment's switch; deleted with the
// conversation; a restored repository taking them back from the copy, never
// onto a new conversation with the number.

import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { DomainEvent } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { THREAD_POLICY, type ThreadRow } from "../src/do/repo/thread-preferences.js";
import type { OpContext } from "../src/ops/execute.js";
import { REPO_CLEANUPS } from "../src/repos/cleanups.js";
import { copyThread } from "../src/repos/thread-subscriptions.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";

const fx = inject("pushFixtures");

type Subscription = {
  subscribed: boolean;
  ignored: boolean;
  reason: null;
  url: string;
  issue_url: string;
  repository_url: string;
};

/** A repository of `owner`'s, which `readers` read (collaborators with `pull`). */
async function repoOf(owner: Who, readers: readonly Who[] = []) {
  const made = await json<{ id: string; name: string }>(
    api("POST", "/user/repos", owner.token, { name: uniqueId("t") }),
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

/** Pushes `main` and `feature`, and opens a pull request between them as the owner; its number. */
async function pullOf(owner: Who, repo: { id: string; name: string; fullName: string }) {
  const target: PushTarget = {
    repo: { id: repo.id, name: repo.name, stub: env.REPO.getByName(repo.id) },
    owner: {
      principalId: owner.principalId,
      token: await scopedToken(owner.principalId, [], "git"),
    },
    path: `/${owner.handle}/${repo.name}.git`,
  };
  const pushed = await postPush(
    target,
    pushBody(
      [
        { old: ZERO, new: fx.c1, ref: "refs/heads/main" },
        { old: ZERO, new: fx.c2, ref: "refs/heads/feature" },
      ],
      { pack: fx.packC2 },
    ),
  );
  expect(pushed.report).toContain("ok refs/heads/feature\n");
  const res = await json<{ number: number }>(
    api("POST", `/repos/${repo.fullName}/pulls`, owner.token, {
      title: "Change",
      head: "feature",
      base: "main",
    }),
  );
  expect(res.status).toBe(201);
  return res.body.number;
}

const openIssue = async (who: Who, fullName: string) => {
  const res = await json<{ number: number }>(
    api("POST", `/repos/${fullName}/issues`, who.token, { title: "One" }),
  );
  expect(res.status).toBe(201);
  return res.body.number;
};

const path = (fullName: string, number: number) =>
  `/repos/${fullName}/issues/${number}/subscription`;

const subscription = (who: Who, fullName: string, number: number) =>
  json<Subscription & { code?: string }>(api("GET", path(fullName, number), who.token));

const subscribe = (who: Who, fullName: string, number: number, body: Record<string, boolean>) =>
  json<Subscription & { code?: string }>(api("PUT", path(fullName, number), who.token, body));

/** The directory's copy of a principal's preference for a conversation of a repository. */
const copied = (principal: string, repoId: string) =>
  env.DIRECTORY.prepare(
    `SELECT conversation, number, kind, state, revision FROM thread_preferences
     WHERE principal_id = ? AND repo_id = ? ORDER BY conversation`,
  )
    .bind(principal, repoId)
    .all<{ conversation: string; number: number; kind: string; state: string; revision: number }>()
    .then((r) => r.results);

/** The conversation identity numbered `number` now. */
const conversationOf = (repoId: string, number: number) =>
  runInDurableObject(
    env.REPO.getByName(repoId),
    (instance: RepoDO) => instance.threads.subjectOf(number)?.conversation ?? null,
  );

/** Turns the repository's watch audiences on or off (the deployment's switch, for this object). */
const audiences = (repoId: string, on: boolean) =>
  runInDurableObject(env.REPO.getByName(repoId), (instance: RepoDO) => {
    instance.watchAudiences = on;
  });

/** As restored from a backup: its preferences taken back from the directory's copy. */
const restore = (repoId: string) =>
  runInDurableObject(env.REPO.getByName(repoId), (instance: RepoDO, state) => {
    state.storage.transactionSync(() => {
      instance.watching.restored(instance.events.epochGen());
      instance.threads.restored(instance.events.epochGen());
      instance.git.jobs.ensure("preference_recovery", "preference_recovery");
    });
  });

/** Runs the repository's alarms until no preference is being taken back; how many it took. */
async function recover(repoId: string): Promise<number> {
  const stub = env.REPO.getByName(repoId);
  let alarms = 0;
  while (
    await runInDurableObject(
      stub,
      (instance: RepoDO) => instance.watching.recovering() || instance.threads.recovering(),
    )
  ) {
    await runDurableObjectAlarm(stub);
    alarms++;
  }
  return alarms;
}

describe("a thread subscription", () => {
  it("is set, read, ignored and deleted, and copied to the directory under the conversation's identity", async () => {
    const [owner, reader] = [await user(), await user()];
    const repo = await repoOf(owner, [reader]);
    const number = await openIssue(owner, repo.fullName);
    const conversation = await conversationOf(repo.id, number);
    expect(conversation).toMatch(/^[0-9a-f-]{36}$/);
    expect(await subscription(reader, repo.fullName, number)).toMatchObject({
      status: 404,
      body: { code: "subscription_not_found" },
    });
    const subscribed = await subscribe(reader, repo.fullName, number, { subscribed: true });
    expect(subscribed).toMatchObject({
      status: 200,
      body: { subscribed: true, ignored: false, reason: null },
    });
    expect(subscribed.body.url).toMatch(
      new RegExp(`/api/repos/${repo.fullName}/issues/${number}/subscription$`),
    );
    expect(subscribed.body.issue_url).toMatch(
      new RegExp(`/api/repos/${repo.fullName}/issues/${number}$`),
    );
    expect(await subscription(reader, repo.fullName, number)).toMatchObject({
      status: 200,
      body: { subscribed: true },
    });
    expect(await copied(reader.principalId, repo.id)).toEqual([
      { conversation, number, kind: "issue", state: "subscribed", revision: 1 },
    ]);
    // Ignoring wins over subscribing.
    expect(
      await subscribe(reader, repo.fullName, number, { subscribed: true, ignored: true }),
    ).toMatchObject({ status: 200, body: { subscribed: false, ignored: true } });
    // Deleted: no preference (404); the copy keeps the command's order as `none`.
    expect((await api("DELETE", path(repo.fullName, number), reader.token)).status).toBe(200);
    expect((await subscription(reader, repo.fullName, number)).status).toBe(404);
    expect(await copied(reader.principalId, repo.id)).toEqual([
      { conversation, number, kind: "issue", state: "none", revision: 3 },
    ]);
  });

  it("answers no conversation, and one of a kind the token may not read, with the same 404", async () => {
    const [owner, reader] = [await user(), await user()];
    const repo = await repoOf(owner, [reader]);
    const pull = await pullOf(owner, repo);
    const issuesOnly = {
      ...reader,
      token: await scopedToken(reader.principalId, [
        "watching:write",
        "issues:read",
        "metadata:read",
      ]),
    };
    for (const number of [pull, 999])
      expect(
        await subscribe(issuesOnly, repo.fullName, number, { subscribed: true }),
      ).toMatchObject({ status: 404, body: { code: "issue_not_found" } });
    // With the pull request's permission: subscribed, as a pull request.
    expect((await subscribe(reader, repo.fullName, pull, { subscribed: true })).status).toBe(200);
    expect((await copied(reader.principalId, repo.id)).map((r) => r.kind)).toEqual(["pull"]);
    // A stranger is told of no repository.
    expect(await subscribe(await user(), repo.fullName, pull, { subscribed: true })).toMatchObject({
      status: 404,
      body: { code: "repo_not_found" },
    });
  });

  it("names a conversation from before identities by its number and creation time", async () => {
    const [owner, reader] = [await user(), await user()];
    const repo = await repoOf(owner, [reader]);
    const number = await openIssue(owner, repo.fullName);
    const createdAt = await runInDurableObject(env.REPO.getByName(repo.id), (_: RepoDO, state) => {
      state.storage.sql.exec("UPDATE issues SET conversation_id = NULL WHERE number = ?", number);
      return state.storage.sql
        .exec<{ created_at: number }>("SELECT created_at FROM issues WHERE number = ?", number)
        .one().created_at;
    });
    expect((await subscribe(reader, repo.fullName, number, { subscribed: true })).status).toBe(200);
    expect((await copied(reader.principalId, repo.id))[0]?.conversation).toBe(
      `legacy:${number}:${createdAt}`,
    );
  });
});

describe("thread subscription caps", () => {
  /** Rows written as the repository would, for speed. */
  const seed = (repoId: string, rows: readonly Omit<ThreadRow, "epochGen" | "revision" | "at">[]) =>
    runInDurableObject(env.REPO.getByName(repoId), (_: RepoDO, state) => {
      state.storage.transactionSync(() => {
        for (const r of rows)
          state.storage.sql.exec(
            `INSERT INTO thread_preferences
               (principal, conversation, number, kind, root, state, epoch_gen, revision, at)
             VALUES (?, ?, ?, ?, ?, ?, 1, 1, 0)`,
            r.principal,
            r.conversation,
            r.number,
            r.kind,
            r.root,
            r.state,
          );
      });
    });

  it("refuses the subscriber past a conversation's cap, freeing the places of principals deleted", async () => {
    const [owner, late, gone] = [await user(), await user(), await user()];
    const repo = await repoOf(owner, [late]);
    const number = await openIssue(owner, repo.fullName);
    const conversation = (await conversationOf(repo.id, number)) as string;
    await seed(repo.id, [
      ...Array.from({ length: THREAD_POLICY.maxPerState - 1 }, (_, i) => ({
        principal: `usr_sub${i}`,
        root: `usr_sub${i}`,
        conversation,
        number,
        kind: "issue" as const,
        state: "subscribed" as const,
      })),
      {
        principal: gone.principalId,
        root: gone.principalId,
        conversation,
        number,
        kind: "issue",
        state: "subscribed",
      },
    ]);
    expect(await subscribe(late, repo.fullName, number, { subscribed: true })).toMatchObject({
      status: 409,
      body: { code: "thread_subscribers_full" },
    });
    // Unsubscribing counts apart.
    expect((await subscribe(late, repo.fullName, number, { ignored: true })).status).toBe(200);
    await env.DIRECTORY.prepare(
      "UPDATE principals SET lifecycle = 'deleted', disabled_at = ? WHERE id = ?",
    )
      .bind(Date.now(), gone.principalId)
      .run();
    expect((await subscribe(late, repo.fullName, number, { subscribed: true })).status).toBe(200);
    expect(
      await runInDurableObject(
        env.REPO.getByName(repo.id),
        (instance: RepoDO) => instance.threads.get(gone.principalId, conversation) ?? null,
      ),
    ).toBeNull();
  });

  it("refuses a principal's preference past its cap of a kind, never another kind's or a change of one it has", async () => {
    const [owner, reader] = [await user(), await user()];
    const repo = await repoOf(owner, [reader]);
    const [first, second] = [
      await openIssue(owner, repo.fullName),
      await openIssue(owner, repo.fullName),
    ];
    const pull = await pullOf(owner, repo);
    expect((await subscribe(reader, repo.fullName, first, { subscribed: true })).status).toBe(200);
    // Its other issue preferences (of conversations restored away, say) fill the cap.
    await seed(
      repo.id,
      Array.from({ length: THREAD_POLICY.maxPerKind - 1 }, (_, i) => ({
        principal: reader.principalId,
        root: reader.principalId,
        conversation: `gone-${i}`,
        number: 10_000 + i,
        kind: "issue" as const,
        state: "unsubscribed" as const,
      })),
    );
    expect(await subscribe(reader, repo.fullName, second, { subscribed: true })).toMatchObject({
      status: 409,
      body: { code: "thread_subscriptions_full" },
    });
    expect((await subscribe(reader, repo.fullName, first, { ignored: true })).status).toBe(200);
    expect((await subscribe(reader, repo.fullName, pull, { subscribed: true })).status).toBe(200);
  });
});

describe("thread subscribers in audiences", () => {
  /** The outbox's position now. */
  const seqOf = (repoId: string) =>
    runInDurableObject(
      env.REPO.getByName(repoId),
      (r: RepoDO) =>
        r.git.context.storage.sql
          .exec<{ s: number | null }>("SELECT max(source_seq) AS s FROM outbox")
          .one().s ?? 0,
    );
  /** Who the events since `from` tell, as `type principal kind priority reasons`. */
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
          (e.feed?.audience ?? []).map(
            (a) => `${e.type} ${a.principal} ${a.kind} ${a.priority} ${a.reasons.join(",")}`,
          ),
        ),
    );
  const comment = (who: Who, fullName: string, number: number, body: string) =>
    api("POST", `/repos/${fullName}/issues/${number}/comments`, who.token, { body });

  async function subscribed(on: boolean) {
    const [owner, subscriber, unsubscriber, commenter] = [
      await user(),
      await user(),
      await user(),
      await user(),
    ];
    const repo = await repoOf(owner, [subscriber, unsubscriber, commenter]);
    await audiences(repo.id, on);
    const number = await openIssue(owner, repo.fullName);
    // The unsubscriber takes part, then unsubscribes.
    await comment(unsubscriber, repo.fullName, number, "first");
    for (const [who, body] of [
      [subscriber, { subscribed: true }],
      [unsubscriber, { ignored: true }],
    ] as const)
      expect((await subscribe(who, repo.fullName, number, body)).status).toBe(200);
    return { owner, subscriber, unsubscriber, commenter, repo, number };
  }

  it("tell subscribers of its activity as participants (P1, subscribed), once the switch is on", async () => {
    const { subscriber, unsubscriber, commenter, repo, number } = await subscribed(true);
    const from = await seqOf(repo.id);
    await comment(commenter, repo.fullName, number, "a comment");
    const lines = await told(repo.id, from);
    expect(lines).toContain(
      `issue_comment.created ${subscriber.principalId} activity P1 subscribed`,
    );
    // Unsubscribing is kept, not yet applied (it takes effect with the inbox): a participant still.
    expect(lines).toContain(
      `issue_comment.created ${unsubscriber.principalId} activity P1 commenter`,
    );
  });

  it("tell no subscriber while the switch is off", async () => {
    const { subscriber, commenter, repo, number } = await subscribed(false);
    const from = await seqOf(repo.id);
    await comment(commenter, repo.fullName, number, "a comment");
    expect((await told(repo.id, from)).filter((l) => l.includes(subscriber.principalId))).toEqual(
      [],
    );
  });

  it("keep a subscribing participant's reason", async () => {
    const { subscriber, commenter, repo, number } = await subscribed(true);
    await comment(subscriber, repo.fullName, number, "me too");
    const from = await seqOf(repo.id);
    await comment(commenter, repo.fullName, number, "again");
    expect((await told(repo.id, from)).filter((l) => l.includes(subscriber.principalId))).toEqual([
      `issue_comment.created ${subscriber.principalId} activity P1 commenter`,
    ]);
  });

  it("are read in a fixed order, at most the cap, the rest counted as overflow", async () => {
    const owner = await user();
    const repo = await repoOf(owner);
    const number = await openIssue(owner, repo.fullName);
    const result = await runInDurableObject(
      env.REPO.getByName(repo.id),
      (instance: RepoDO, state) => {
        const conversation = instance.threads.subjectOf(number)?.conversation as string;
        state.storage.transactionSync(() => {
          for (let i = 0; i <= THREAD_POLICY.maxPerState; i++)
            state.storage.sql.exec(
              `INSERT INTO thread_preferences
                 (principal, conversation, number, kind, root, state, epoch_gen, revision, at)
               VALUES (?, ?, ?, 'issue', ?, 'subscribed', 1, ?, 0)`,
              `usr_s${i}`,
              conversation,
              number,
              `usr_s${i}`,
              i + 1,
            );
        });
        const read = instance.threads.subscribers(number);
        return { count: read.subscribers.length, first: read.subscribers[0]?.id, ...read };
      },
    );
    expect(result.count).toBe(THREAD_POLICY.maxPerState);
    expect(result.first).toBe("usr_s0");
    expect(result.overflow).toBe(true);
  });
});

describe("a deleted conversation", () => {
  it("deletes its preferences with it, bumping their principals' versions", async () => {
    const [owner, reader] = [await user(), await user()];
    const repo = await repoOf(owner, [reader]);
    const number = await openIssue(owner, repo.fullName);
    for (const who of [owner, reader])
      expect((await subscribe(who, repo.fullName, number, { subscribed: true })).status).toBe(200);
    const versions = () =>
      runInDurableObject(env.REPO.getByName(repo.id), (_: RepoDO, state) =>
        state.storage.sql
          .exec<{ principal: string; issues_version: number }>(
            "SELECT principal, issues_version FROM preference_versions ORDER BY principal",
          )
          .toArray()
          .map((r) => ({ ...r })),
      );
    const before = await versions();
    expect(
      (await api("DELETE", `/repos/${repo.fullName}/issues/${number}`, owner.token)).status,
    ).toBe(200);
    expect(
      await runInDurableObject(
        env.REPO.getByName(repo.id),
        (_: RepoDO, state) =>
          state.storage.sql
            .exec<{ n: number }>("SELECT count(*) AS n FROM thread_preferences")
            .one().n,
      ),
    ).toBe(0);
    expect(await versions()).toEqual(
      before.map((v) => ({ ...v, issues_version: v.issues_version + 1 })),
    );
  });

  it("deletes at most its caps' preferences with it, past them (after a restore) a page at a time", async () => {
    const owner = await user();
    const repo = await repoOf(owner);
    const number = await openIssue(owner, repo.fullName);
    const stub = env.REPO.getByName(repo.id);
    const total = 2 * THREAD_POLICY.maxPerState + 2 * THREAD_POLICY.forgetPage + 1;
    await runInDurableObject(stub, (instance: RepoDO, state) => {
      const conversation = instance.threads.subjectOf(number)?.conversation as string;
      state.storage.transactionSync(() => {
        for (let i = 0; i < total; i++)
          state.storage.sql.exec(
            `INSERT INTO thread_preferences
               (principal, conversation, number, kind, root, state, epoch_gen, revision, at)
             VALUES (?1, ?2, ?3, 'issue', ?1, ?4, 1, 1, 0)`,
            `usr_x${i}`,
            conversation,
            number,
            i % 2 === 0 ? "subscribed" : "unsubscribed",
          );
      });
    });
    const left = () =>
      runInDurableObject(stub, (_: RepoDO, state) => ({
        rows: state.storage.sql
          .exec<{ n: number }>("SELECT count(*) AS n FROM thread_preferences")
          .one().n,
        forgets: state.storage.sql
          .exec<{ n: number }>("SELECT count(*) AS n FROM thread_forgets")
          .one().n,
      }));
    expect(
      (await api("DELETE", `/repos/${repo.fullName}/issues/${number}`, owner.token)).status,
    ).toBe(200);
    expect(await left()).toEqual({ rows: 1_001, forgets: 1 });
    // A page an alarm.
    await runDurableObjectAlarm(stub);
    expect(await left()).toEqual({ rows: 501, forgets: 1 });
    await runDurableObjectAlarm(stub);
    expect(await left()).toEqual({ rows: 1, forgets: 1 });
    await runDurableObjectAlarm(stub);
    expect(await left()).toEqual({ rows: 0, forgets: 0 });
  });
});

describe("a restored repository's thread preferences", () => {
  it("are taken back from the copy, never onto a new conversation with a number, refusing commands until then", async () => {
    const [owner, reader] = [await user(), await user()];
    const repo = await repoOf(owner, [reader]);
    const [kept, replaced] = [
      await openIssue(owner, repo.fullName),
      await openIssue(owner, repo.fullName),
    ];
    for (const number of [kept, replaced])
      expect((await subscribe(reader, repo.fullName, number, { subscribed: true })).status).toBe(
        200,
      );
    // As restored from a backup without either preference, the second number now another
    // conversation's.
    await runInDurableObject(env.REPO.getByName(repo.id), (_: RepoDO, state) => {
      state.storage.sql.exec("DELETE FROM thread_preferences");
      state.storage.sql.exec(
        "UPDATE issues SET conversation_id = 'another', created_at = created_at + 1 WHERE number = ?",
        replaced,
      );
    });
    await restore(repo.id);
    expect(await subscription(reader, repo.fullName, kept)).toMatchObject({
      status: 503,
      body: { code: "preferences_recovering" },
    });
    expect((await subscribe(reader, repo.fullName, kept, { ignored: true })).status).toBe(503);
    await recover(repo.id);
    expect(await subscription(reader, repo.fullName, kept)).toMatchObject({
      status: 200,
      body: { subscribed: true },
    });
    expect((await subscription(reader, repo.fullName, replaced)).status).toBe(404);
  });

  it("make the local preferences the copy's, a page at a time, one principal across pages, restarted midway", async () => {
    const [owner, reader, other] = [await user(), await user(), await user()];
    const repo = await repoOf(owner, [reader]);
    const count = 450;
    // Conversations written as the repository would, for speed.
    const conversations = await runInDurableObject(
      env.REPO.getByName(repo.id),
      (_: RepoDO, state) =>
        state.storage.transactionSync(() => {
          const now = Date.now();
          const ids: { number: number; conversation: string }[] = [];
          for (let i = 0; i < count; i++) {
            const number = 1_000 + i;
            const conversation = `c-${String(i).padStart(4, "0")}`;
            state.storage.sql.exec(
              `INSERT INTO issues (number, title, state, author_id, author_root, created_at,
                 updated_at, conversation_id)
               VALUES (?, 'x', 'open', ?, ?, ?, ?, ?)`,
              number,
              owner.principalId,
              owner.principalId,
              now,
              now,
              conversation,
            );
            ids.push({ number, conversation });
          }
          // A local row the copy never acknowledged: cleared.
          state.storage.sql.exec(
            `INSERT INTO thread_preferences
               (principal, conversation, number, kind, root, state, epoch_gen, revision, at)
             VALUES (?, 'c-0000', 1000, 'issue', ?, 'subscribed', 1, 9, 0)`,
            other.principalId,
            other.principalId,
          );
          return ids;
        }),
    );
    // The copy: the reader's 450 (alternating states), one tombstone, one of another
    // repository, and one of a conversation that is gone.
    const now = Date.now();
    const rows = conversations.map(({ number, conversation }, i) =>
      env.DIRECTORY.prepare(
        `INSERT INTO thread_preferences (principal_id, repo_id, conversation, number, kind,
           root_id, state, revision, epoch_gen, at)
         VALUES (?, ?, ?, ?, 'issue', ?, ?, ?, 1, ?)`,
      ).bind(
        reader.principalId,
        repo.id,
        conversation,
        number,
        reader.principalId,
        i % 2 === 0 ? "subscribed" : "unsubscribed",
        i + 1,
        now,
      ),
    );
    const extra = [
      [owner.principalId, repo.id, "c-0001", 1001, "none"],
      [owner.principalId, "rep_elsewhere", "c-0002", 1002, "subscribed"],
      [owner.principalId, repo.id, "gone", 77, "subscribed"],
    ].map(([principal, repoId, conversation, number, state]) =>
      env.DIRECTORY.prepare(
        `INSERT INTO thread_preferences (principal_id, repo_id, conversation, number, kind,
           root_id, state, revision, epoch_gen, at)
         VALUES (?1, ?2, ?3, ?4, 'issue', ?1, ?5, 1, 1, ?6)`,
      ).bind(principal, repoId, conversation, number, state, now),
    );
    await env.DIRECTORY.batch([...rows, ...extra]);
    const stub = env.REPO.getByName(repo.id);
    // Restored as the runbook does: the directory takes the next generation, and the object
    // learns of it when it next starts.
    const restoreGeneration = async () => {
      await env.DIRECTORY.prepare(
        "UPDATE source_epochs SET epoch_gen = epoch_gen + 1 WHERE source_id = ?",
      )
        .bind(repo.id)
        .run();
      await evictDurableObject(stub);
      await runInDurableObject(stub, (instance: RepoDO) => instance.checkEpoch());
    };
    const recovery = () =>
      runInDurableObject(stub, (_: RepoDO, state) =>
        state.storage.sql
          .exec<{ phase: string; cursor: string | null }>(
            "SELECT phase, cursor FROM preference_recovery WHERE grp = 'issues'",
          )
          .toArray()
          .map((r) => ({ ...r })),
      );
    await restoreGeneration();
    // One alarm: the watchers (none), the unacknowledged row cleared, the first page imported.
    await runDurableObjectAlarm(stub);
    expect((await recovery())[0]).toMatchObject({ phase: "import", cursor: expect.any(String) });
    // Between the restores the copy changes one preference already imported and loses another:
    // the second recovery starts over and takes the copy as it is then.
    await env.DIRECTORY.batch([
      env.DIRECTORY.prepare(
        `UPDATE thread_preferences SET state = 'unsubscribed', revision = 1000
         WHERE principal_id = ? AND repo_id = ? AND conversation = 'c-0000'`,
      ).bind(reader.principalId, repo.id),
      env.DIRECTORY.prepare(
        `DELETE FROM thread_preferences
         WHERE principal_id = ? AND repo_id = ? AND conversation = 'c-0002'`,
      ).bind(reader.principalId, repo.id),
    ]);
    await restoreGeneration();
    expect(await recovery()).toEqual([{ phase: "clear", cursor: null }]);
    await recover(repo.id);
    const local = await runInDurableObject(stub, (_: RepoDO, state) =>
      state.storage.sql
        .exec<{ principal: string; conversation: string; state: string; revision: number }>(
          `SELECT principal, conversation, state, revision FROM thread_preferences
           ORDER BY principal, conversation`,
        )
        .toArray()
        .map((r) => ({ ...r })),
    );
    expect(local).toEqual(
      conversations.flatMap(({ conversation }, i) =>
        conversation === "c-0002"
          ? []
          : [
              {
                principal: reader.principalId,
                conversation,
                state: i === 0 || i % 2 === 1 ? "unsubscribed" : "subscribed",
                revision: i === 0 ? 1000 : i + 1,
              },
            ],
      ),
    );
  });

  it("take nothing back from a page read before a restore overtook it", async () => {
    const [owner, reader] = [await user(), await user()];
    const repo = await repoOf(owner, [reader]);
    const number = await openIssue(owner, repo.fullName);
    expect((await subscribe(reader, repo.fullName, number, { subscribed: true })).status).toBe(200);
    const outcome = await runInDurableObject(
      env.REPO.getByName(repo.id),
      async (instance: RepoDO, state) => {
        const row = instance.threads.get(
          reader.principalId,
          instance.threads.subjectOf(number)?.conversation as string,
        ) as ThreadRow;
        state.storage.transactionSync(() => {
          state.storage.sql.exec("DELETE FROM thread_preferences");
          instance.threads.restored(instance.events.epochGen());
        });
        // The copy's page read, a restore landing while it was read.
        const more = await instance.threads.recoverStep(async () => {
          state.storage.transactionSync(() =>
            instance.threads.restored(instance.events.epochGen()),
          );
          return [{ ...row, active: true }];
        });
        return {
          more,
          rows: state.storage.sql
            .exec<{ n: number }>("SELECT count(*) AS n FROM thread_preferences")
            .one().n,
          phase: state.storage.sql
            .exec<{ phase: string }>("SELECT phase FROM preference_recovery WHERE grp = 'issues'")
            .one().phase,
        };
      },
    );
    expect(outcome).toEqual({ more: true, rows: 0, phase: "clear" });
  });
});

describe("a thread preference's copy", () => {
  it("answers 503 when the repository was restored since the command's generation", async () => {
    const [owner, reader] = [await user(), await user()];
    const repo = await repoOf(owner, [reader]);
    const number = await openIssue(owner, repo.fullName);
    expect((await subscribe(reader, repo.fullName, number, { subscribed: true })).status).toBe(200);
    await env.DIRECTORY.prepare(
      "UPDATE source_epochs SET epoch_gen = epoch_gen + 1 WHERE source_id = ?",
    )
      .bind(repo.id)
      .run();
    expect(await subscribe(reader, repo.fullName, number, { ignored: true })).toMatchObject({
      status: 503,
      body: { code: "preferences_recovering" },
    });
    expect((await copied(reader.principalId, repo.id)).map((r) => r.state)).toEqual(["subscribed"]);
  });

  it("never takes an older command after a deletion's, which it keeps as `none`", async () => {
    const [owner, reader] = [await user(), await user()];
    const repo = await repoOf(owner, [reader]);
    const number = await openIssue(owner, repo.fullName);
    const conversation = (await conversationOf(repo.id, number)) as string;
    const ctx = { env, metrics: { count: () => {} } } as unknown as OpContext;
    const row = (state: ThreadRow["state"], revision: number): ThreadRow => ({
      principal: reader.principalId,
      root: reader.principalId,
      conversation,
      number,
      kind: "issue",
      state,
      epochGen: 1,
      revision,
      at: Date.now(),
    });
    // The deletion (revision 2) copied before the subscription it followed (1), held.
    await copyThread(ctx, repo.id, row("none", 2));
    await copyThread(ctx, repo.id, row("subscribed", 1));
    expect((await copied(reader.principalId, repo.id)).map((r) => [r.state, r.revision])).toEqual([
      ["none", 2],
    ]);
  });

  it("is deleted a page at a time by its repository's deletion cleanups", async () => {
    const [owner, reader] = [await user(), await user()];
    const repo = await repoOf(owner, [reader]);
    const number = await openIssue(owner, repo.fullName);
    await subscribe(reader, repo.fullName, number, { subscribed: true });
    await env.DIRECTORY.prepare("UPDATE repos SET state = 'deleting' WHERE id = ?")
      .bind(repo.id)
      .run();
    const cleanup = REPO_CLEANUPS.find((c) => c.name === "preferences");
    if (!cleanup) throw new Error("no such cleanup");
    while ((await cleanup.page(env, { repoId: repo.id, shard: "", gen: 1 })) !== "done");
    expect(await copied(reader.principalId, repo.id)).toEqual([]);
  });
});
