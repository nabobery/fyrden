// GitHub's notifications API over the principal's thread inbox: lists
// (unread by default, all, participating, a repository's, paged), a thread,
// marking read and done, marking all read in bounded calls, and the thread
// subscription by thread id; every one decided freshly, a thread whose
// repository the caller cannot read now, or whose number names another
// conversation, hidden as if not there.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { FeedEntry } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OrgDO } from "../src/do/OrgDO.js";
import type { RepoDO } from "../src/do/RepoDO.js";
import { threadId } from "../src/do/user/inbox.js";
import { notificationHooks } from "../src/notifications/operations.js";
import { agentFor } from "./helpers/agents.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { countingExec, entry, feedIn, inFeed } from "./helpers/feed.js";
import { scopedToken } from "./helpers/principals.js";

type Thread = {
  id: string;
  reason: string;
  unread: boolean;
  repository: { full_name: string; private: boolean };
  subject: { title: string; url: string; type: string; latest_comment_url: null };
  url: string;
  subscription_url: string;
  updated_at: string;
  last_read_at: string | null;
};
type Page = { notifications: Thread[]; next_cursor: string | null; delivery: string };

/** A repository of `owner`'s, with `issues` issues, which `readers` read. */
async function repoOf(owner: Who, issues: number, readers: readonly Who[] = []) {
  const made = await json<{ id: string; name: string }>(
    api("POST", "/user/repos", owner.token, { name: uniqueId("n") }),
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
  for (let n = 1; n <= issues; n++)
    expect(
      (await api("POST", `/repos/${fullName}/issues`, owner.token, { title: `Issue ${n}` })).status,
    ).toBe(201);
  return { id: made.body.id, fullName };
}

/** The conversation issue `number` of `repoId` is now. */
const conversationOf = (repoId: string, number: number) =>
  runInDurableObject(env.REPO.getByName(repoId), (_: RepoDO, state) =>
    String(
      state.storage.sql
        .exec<{ c: string }>("SELECT conversation_id AS c FROM issues WHERE number = ?", number)
        .one().c,
    ),
  );

/** Tells `who` of issue `number` (an entry as its repository would send it). */
async function notify(
  who: Who,
  repoId: string,
  number: number,
  init: Partial<Parameters<typeof entry>[0]> = {},
): Promise<string> {
  const conversation = await conversationOf(repoId, number);
  const told: FeedEntry = entry({
    version: init.version ?? 1,
    thread: number,
    subject: "issue",
    repoId,
    principal: who.principalId,
    conversation,
    occurredAt: Date.now(),
    ...init,
  });
  await env.USER.getByName(who.principalId).applyFeed([told]);
  return threadId(repoId, conversation);
}

const list = (who: Who, query = "", token = who.token) =>
  json<Page>(api("GET", `/notifications${query}`, token));

describe("listing notifications", () => {
  it("answers unread threads as GitHub's, all of them with all=true, and those naming the caller with participating", async () => {
    const [owner, reader] = [await user(), await user()];
    const repo = await repoOf(owner, 3, [reader]);
    const mentioned = await notify(reader, repo.id, 1, { kind: "mention" });
    const commented = await notify(reader, repo.id, 2);
    const watched = await notify(reader, repo.id, 3, { reasons: ["watching"], priority: "P2" });
    const page = await list(reader);
    expect(page.status).toBe(200);
    expect(page.body.delivery).toBe("complete");
    expect(page.body.notifications.map((t) => t.id).sort()).toEqual(
      [mentioned, commented, watched].sort(),
    );
    const one = page.body.notifications.find((t) => t.id === mentioned);
    expect(one).toMatchObject({
      reason: "mention",
      unread: true,
      last_read_at: null,
      repository: { full_name: repo.fullName, private: true },
      subject: { title: "Issue 1", type: "Issue", latest_comment_url: null },
    });
    expect(one?.subject.url).toMatch(new RegExp(`/api/repos/${repo.fullName}/issues/1$`));
    expect(one?.url).toMatch(new RegExp(`/api/notifications/threads/${mentioned}$`));
    expect(one?.subscription_url).toBe(`${one?.url}/subscription`);
    // Participating: not the watched one.
    expect(
      (await list(reader, "?participating=true")).body.notifications.map((t) => t.id).sort(),
    ).toEqual([mentioned, commented].sort());
    // Read: out of the default list, in `all`.
    expect((await api("PATCH", `/notifications/threads/${commented}`, reader.token)).status).toBe(
      205,
    );
    expect((await list(reader)).body.notifications.map((t) => t.id)).not.toContain(commented);
    const all = await list(reader, "?all=true");
    expect(all.body.notifications.find((t) => t.id === commented)).toMatchObject({
      unread: false,
    });
    // Done: out of both, until a later event reopens it.
    expect((await api("DELETE", `/notifications/threads/${mentioned}`, reader.token)).status).toBe(
      204,
    );
    expect((await list(reader, "?all=true")).body.notifications.map((t) => t.id)).not.toContain(
      mentioned,
    );
    await notify(reader, repo.id, 1, { version: 2 });
    expect((await list(reader)).body.notifications.map((t) => t.id)).toContain(mentioned);
  });

  it("pages by cursor, newest first, with GitHub's page 1 only", async () => {
    const [owner, reader] = [await user(), await user()];
    const repo = await repoOf(owner, 3, [reader]);
    const ids = [];
    for (let n = 1; n <= 3; n++) ids.push(await notify(reader, repo.id, n));
    const first = await list(reader, "?per_page=2&page=1");
    expect(first.body.notifications).toHaveLength(2);
    expect(first.body.next_cursor).not.toBeNull();
    const second = await list(reader, `?per_page=2&cursor=${first.body.next_cursor}`);
    expect(second.body.notifications).toHaveLength(1);
    expect(second.body.next_cursor).toBeNull();
    expect(
      [...first.body.notifications, ...second.body.notifications].map((t) => t.id).sort(),
    ).toEqual(ids.sort());
    expect((await list(reader, "?page=2")).status).toBe(422);
  });

  it("stops at a thread the caller may not read, and forgets it once the principal itself cannot", async () => {
    const [owner, reader] = [await user(), await user()];
    const kept = await repoOf(owner, 1, [reader]);
    const lost = await repoOf(owner, 1, [reader]);
    const keptId = await notify(reader, kept.id, 1);
    // The newer thread is of a repository the reader then loses.
    await notify(reader, lost.id, 1);
    expect(
      (await api("DELETE", `/repos/${lost.fullName}/collaborators/${reader.handle}`, owner.token))
        .status,
    ).toBeLessThan(300);
    // The newest thread is one it may not read: nothing shown, no cursor (nothing readable was
    // passed), and the thread forgotten (the principal itself cannot read its repository)...
    expect((await list(reader)).body).toMatchObject({ notifications: [], next_cursor: null });
    // ...so the next answer gets past it.
    const page = await list(reader);
    expect(page.body.notifications.map((t) => t.id)).toEqual([keptId]);
  });

  it("refuses a delegated token, whose pages would depend on what it may not read", async () => {
    const reader = await user();
    const agent = await agentFor(reader, ["notifications:write", "issues:read"]);
    expect(await json(api("GET", "/notifications", agent.delegated))).toMatchObject({
      status: 403,
      body: { code: "delegated_listing" },
    });
    expect(await json(api("PUT", "/notifications", agent.delegated, {}))).toMatchObject({
      status: 403,
      body: { code: "delegated_listing" },
    });
    // A repository's list and marking too.
    const [owner] = [await user()];
    const repo = await repoOf(owner, 0, [reader]);
    for (const [method, path] of [
      ["GET", `/repos/${repo.fullName}/notifications`],
      ["PUT", `/repos/${repo.fullName}/notifications`],
    ] as const)
      expect(
        await json(api(method, path, agent.delegated, method === "PUT" ? {} : undefined)),
      ).toMatchObject({
        status: 403,
        body: { code: "delegated_listing" },
      });
  });

  it("lists only the kinds and repositories a token may read", async () => {
    const [owner, reader] = [await user(), await user()];
    const a = await repoOf(owner, 1, [reader]);
    const b = await repoOf(owner, 1, [reader]);
    const inA = await notify(reader, a.id, 1);
    await notify(reader, b.id, 1);
    const onlyA = await scopedToken(
      reader.principalId,
      ["notifications:read", "issues:read"],
      "pat",
      [a.id],
    );
    expect((await list(reader, "", onlyA)).body.notifications.map((t) => t.id)).toEqual([inA]);
    const noIssues = await scopedToken(reader.principalId, ["notifications:read"]);
    expect((await list(reader, "", noIssues)).body.notifications).toEqual([]);
  });
});

describe("a thread", () => {
  it("is 404 when it is another principal's, or its repository is not readable now", async () => {
    const [owner, reader, other] = [await user(), await user(), await user()];
    const repo = await repoOf(owner, 1, [reader]);
    const id = await notify(reader, repo.id, 1);
    expect(
      (await json<Thread>(api("GET", `/notifications/threads/${id}`, reader.token))).body,
    ).toMatchObject({
      id,
      unread: true,
    });
    expect((await api("GET", `/notifications/threads/${id}`, other.token)).status).toBe(404);
    expect((await api("PATCH", `/notifications/threads/${id}`, other.token)).status).toBe(404);
    await api("DELETE", `/repos/${repo.fullName}/collaborators/${reader.handle}`, owner.token);
    expect((await api("GET", `/notifications/threads/${id}`, reader.token)).status).toBe(404);
    expect((await api("GET", "/notifications/threads/not!an-id", reader.token)).status).toBe(422);
  });

  it("is 404, and forgotten, once its number names another conversation (a restore)", async () => {
    const [owner, reader] = [await user(), await user()];
    const repo = await repoOf(owner, 1, [reader]);
    const id = await notify(reader, repo.id, 1);
    // As a restore would leave it: the number names a new conversation.
    await runInDurableObject(env.REPO.getByName(repo.id), (_: RepoDO, state) => {
      state.storage.sql.exec(
        "UPDATE issues SET conversation_id = ? WHERE number = 1",
        uniqueId("c"),
      );
    });
    expect((await api("GET", `/notifications/threads/${id}`, reader.token)).status).toBe(404);
    expect(
      (await api("PUT", `/notifications/threads/${id}/subscription`, reader.token, {})).status,
    ).toBe(404);
    const left = await runInDurableObject(
      env.USER.getByName(reader.principalId),
      (_, state) => state.storage.sql.exec("SELECT count(*) AS n FROM inbox_threads").one().n,
    );
    expect(left).toBe(0);
  });

  it("has the conversation's subscription, set and cleared through it", async () => {
    const [owner, reader] = [await user(), await user()];
    const repo = await repoOf(owner, 1, [reader]);
    const id = await notify(reader, repo.id, 1);
    const path = `/notifications/threads/${id}/subscription`;
    expect((await json(api("GET", path, reader.token))).body).toMatchObject({
      subscribed: false,
      ignored: false,
      created_at: null,
    });
    expect((await json(api("PUT", path, reader.token, { ignored: true }))).body).toMatchObject({
      subscribed: false,
      ignored: true,
    });
    // The same preference as the conversation's own route.
    expect(
      (await json(api("GET", `/repos/${repo.fullName}/issues/1/subscription`, reader.token))).body,
    ).toMatchObject({ ignored: true });
    expect((await api("DELETE", path, reader.token)).status).toBe(204);
    expect((await json(api("GET", path, reader.token))).body).toMatchObject({ ignored: false });
  });
});

describe("marking notifications read", () => {
  it("marks up to the cutoff, never a later one, a future cutoff counting as now", async () => {
    const [owner, reader] = [await user(), await user()];
    const repo = await repoOf(owner, 2, [reader]);
    await notify(reader, repo.id, 1, { occurredAt: Date.now() - 60_000 });
    const later = await notify(reader, repo.id, 2);
    const marked = await json<{ message: string }>(
      api("PUT", "/notifications", reader.token, {
        last_read_at: new Date(Date.now() - 30_000).toISOString(),
      }),
    );
    expect(marked).toMatchObject({ status: 202 });
    expect(marked.body.message).toMatch(/repeat the request/);
    expect((await list(reader)).body.notifications.map((t) => t.id)).toEqual([later]);
    // Nothing updated after the request arrived is marked: a thread notified between its arrival
    // and its handler (the clock moved on meanwhile) stays unread, for both bulk endpoints.
    for (const [i, path] of ["/notifications", `/repos/${repo.fullName}/notifications`].entries()) {
      notificationHooks.atHandler = async () => {
        vi.setSystemTime(Date.now() + 5_000);
        await notify(reader, repo.id, 1, { version: 10 + i, occurredAt: Date.now() });
      };
      try {
        await api("PUT", path, reader.token, { last_read_at: "2999-01-01T00:00:00Z" });
      } finally {
        delete notificationHooks.atHandler;
      }
      const left = (await list(reader)).body.notifications;
      expect(left, path).toHaveLength(1);
      await api("PATCH", `/notifications/threads/${left[0]?.id}`, reader.token);
    }
    // A future cutoff marks what there is now; a new event after it is unread.
    await api("PUT", "/notifications", reader.token, { last_read_at: "2999-01-01T00:00:00Z" });
    expect((await list(reader)).body.notifications).toEqual([]);
    await notify(reader, repo.id, 2, { version: 20 });
    expect((await list(reader)).body.notifications.map((t) => t.id)).toEqual([later]);
  });

  it("marks a repository's threads alone", async () => {
    const [owner, reader] = [await user(), await user()];
    const a = await repoOf(owner, 1, [reader]);
    const b = await repoOf(owner, 1, [reader]);
    await notify(reader, a.id, 1);
    const inB = await notify(reader, b.id, 1);
    expect((await api("PUT", `/repos/${a.fullName}/notifications`, reader.token, {})).status).toBe(
      202,
    );
    expect((await list(reader)).body.notifications.map((t) => t.id)).toEqual([inB]);
    expect(
      (
        await json<Page>(api("GET", `/repos/${b.fullName}/notifications`, reader.token))
      ).body.notifications.map((t) => t.id),
    ).toEqual([inB]);
  });
});

describe("a repository's notifications, its access lost without the repository told", () => {
  let admin: Who;
  beforeAll(async () => {
    admin = await user(true);
  });

  it("are 404 at once, the inbox empty or not", async () => {
    const [owner, reader] = [await user(), await user()];
    const login = uniqueId("org").slice(0, 39);
    const org = await json<{ id: string }>(
      api("POST", "/admin/organizations", admin.token, { login, admin: owner.handle }),
    );
    const made = await json<{ name: string }>(
      api("POST", `/orgs/${login}/repos`, owner.token, { name: uniqueId("r") }),
    );
    const path = `/repos/${login}/${made.body.name}`;
    await api("PUT", `${path}/collaborators/${reader.handle}`, owner.token, { permission: "pull" });
    // Read once while readable (the repository's snapshot pulled).
    expect((await api("GET", `${path}/notifications`, reader.token)).status).toBe(200);
    // Removed in the account's records, the repository's invalidation lost.
    await runInDurableObject(env.ORG.getByName(org.body.id), (_: OrgDO, state) => {
      state.storage.sql.exec(
        "DELETE FROM collaborators WHERE principal_id = ?",
        reader.principalId,
      );
      state.storage.sql.exec("UPDATE org_meta SET acl_version = acl_version + 1");
    });
    expect((await api("GET", `${path}/notifications`, reader.token)).status).toBe(404);
    expect((await api("PUT", `${path}/notifications`, reader.token, {})).status).toBe(404);
  });
});

describe("the inbox's reads", () => {
  it("merge many repositories' streams within their read budget, done threads not read", async () => {
    await inFeed((storage) => {
      const { feed, apply } = feedIn(storage);
      const repos = Array.from({ length: 100 }, (_, r) => `rep_${r}`);
      for (const repoId of repos)
        apply(
          Array.from({ length: 30 }, (_, n) =>
            entry({ version: 1, thread: n + 1, repoId, conversation: `c${n}`, subject: "issue" }),
          ),
        );
      // Half of every stream done: no list reads them.
      storage.sql.exec(
        "UPDATE inbox_threads SET dn_epoch = 1, dn_version = 1, dn_event = 'x', unread = 0 WHERE number % 2 = 0",
      );
      const query = {
        unreadOnly: false,
        subjects: ["issue", "pull"] as const,
        repoIds: repos,
        since: null,
        before: null,
        after: null,
        limit: 200,
      };
      // Budgets of at least two rows a stream (a list's: 1,000 for at most 200 streams).
      for (const budget of [1_000, 500]) {
        const counting = countingExec(storage.sql);
        const page = feed.inbox.page({ ...query, subjects: [...query.subjects] }, budget);
        const { read } = counting.stop();
        expect(page.read).toBeLessThanOrEqual(budget);
        // Index entries visited beside the rows: about a row more a stream read.
        expect(read).toBeLessThan(budget + repos.length * 2 * 2);
        expect(page.threads.length).toBeGreaterThan(0);
        expect(page.threads.every((t) => t.number % 2 === 1)).toBe(true);
      }
    });
  });

  it("keep a whole answer's storage pages within one physical read budget", async () => {
    await inFeed((storage) => {
      const { feed, apply } = feedIn(storage);
      const repos = Array.from({ length: 100 }, (_, r) => `rep_${r}`);
      for (const repoId of repos)
        apply(
          Array.from({ length: 30 }, (_, n) =>
            entry({ version: 1, thread: n + 1, repoId, conversation: `c${n}`, subject: "issue" }),
          ),
        );
      // Most streams done, the rest half done: as a list would page through them.
      storage.sql.exec(
        "UPDATE inbox_threads SET dn_epoch = 1, dn_version = 1, dn_event = 'x', unread = 0 WHERE number % 3 = 0",
      );
      const budget = 1_000;
      const counting = countingExec(storage.sql);
      let read = 0;
      let calls = 0;
      let after: { updatedAt: number; id: string } | null = null;
      for (;;) {
        calls++;
        const page = feed.inbox.page(
          {
            unreadOnly: false,
            subjects: ["issue", "pull"],
            repoIds: repos,
            since: null,
            before: null,
            after,
            limit: 200,
          },
          budget - read,
        );
        read += page.read;
        const last = page.threads.at(-1);
        if (page.ended || !last || read >= budget) break;
        after = { updatedAt: last.updatedAt, id: last.id };
      }
      // What SQLite read, as the pages charged it (a last read may pass the budget by its chunk).
      expect(counting.stop().read).toBeLessThanOrEqual(read);
      expect(read).toBeLessThan(budget + 200);
      expect(calls).toBeGreaterThan(1);
    });
  });

  it("find a token's repositories' unread streams whatever newer threads others have", async () => {
    await inFeed((storage) => {
      const { feed, apply } = feedIn(storage);
      const t0 = Date.now() - 60_000;
      apply([
        entry({ version: 1, thread: 1, repoId: "rep_a", conversation: "a1", occurredAt: t0 }),
      ]);
      for (let n = 1; n <= 20; n++)
        apply([entry({ version: 1, thread: n, repoId: "rep_b", conversation: `b${n}` })]);
      // Within a scan of 10 of the newest (all of rep_b), rep_a's is still found.
      expect(feed.inbox.unreadStreams(Date.now(), ["pull"], ["rep_a"], 100, 10)).toEqual([
        { repoId: "rep_a", subject: "pull" },
      ]);
    });
  });
});

describe("a thread's preference, its conversation expected", () => {
  it("is not found when the number names another conversation, read or set", async () => {
    const [owner, reader] = [await user(), await user()];
    const repo = await repoOf(owner, 1, [reader]);
    const stub = env.REPO.getByName(repo.id);
    expect(
      await stub.threadPreference(reader.principalId, 1, ["issue"], "another conversation"),
    ).toEqual({ status: "not_found" });
    expect(
      await stub.setThreadPreference(
        reader.principalId,
        null,
        1,
        ["issue"],
        "unsubscribed",
        "another conversation",
      ),
    ).toEqual({ status: "not_found" });
    const right = await conversationOf(repo.id, 1);
    expect(
      await stub.setThreadPreference(reader.principalId, null, 1, ["issue"], "unsubscribed", right),
    ).toMatchObject({ status: "set" });
  });
});

describe("a notification's title", () => {
  it("is its conversation's title now, renamed or not", async () => {
    const [owner, reader] = [await user(), await user()];
    const repo = await repoOf(owner, 1, [reader]);
    const id = await notify(reader, repo.id, 1);
    expect(
      (await api("PATCH", `/repos/${repo.fullName}/issues/1`, owner.token, { title: "Renamed" }))
        .status,
    ).toBe(200);
    expect(
      (await json<Thread>(api("GET", `/notifications/threads/${id}`, reader.token))).body.subject
        .title,
    ).toBe("Renamed");
    expect((await list(reader)).body.notifications[0]?.subject.title).toBe("Renamed");
  });
});
