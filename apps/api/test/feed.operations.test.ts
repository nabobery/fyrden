// The activity feed's operations: whose feed a token reads, items of
// repositories the caller cannot read now left out, what members say read
// live, cursors, ETags and acknowledgements.

import {
  createExecutionContext,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { OrgDO } from "../src/do/OrgDO.js";
import type { RepoDO } from "../src/do/RepoDO.js";
import { ACL_POLICY } from "../src/do/repo/acl.js";
import { type FeedMember, memberKey } from "../src/do/repo/feed-view.js";
import type { UserDO } from "../src/do/UserDO.js";
import { FEED_POLICY } from "../src/do/user/feed.js";
import { decodeFeedCursor, encodeFeedCursor, FEED_POLL } from "../src/feed/operations.js";
import { ACCESS_TOKEN_TYPE, TOKEN_EXCHANGE } from "../src/oauth/exchange.js";
import { SESSION_COOKIE } from "../src/oauth/session.js";
import { agentFor } from "./helpers/agents.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { DAY, type EntryInit, entry, FROM_START } from "./helpers/feed.js";
import { ORIGIN } from "./helpers/git-http.js";
import { testSession } from "./helpers/oauth.js";
import { scopedToken } from "./helpers/principals.js";
import { inRepo } from "./helpers/repo-git.js";

/**
 * Texts the members of a test's feed items stand for, by
 * `<repository>:<member>` (null: gone), laid over what the repository's
 * object reads (its members here are not real comments). And the
 * `feedView` calls the reads took, by repository.
 */
const said = new Map<string, string | null>();
/** Each `feedView` call's members, as `memberKey` gives them, by repository. */
const viewCalls = new Map<string, string[][]>();
/** Repositories that exist only in the directory (no object behind them): readable as their owner's. */
const directoryOnly = new Set<string>();
/** Their owners, whose account the double answers it judged under. */
const directoryOwner = new Map<string, string>();
/** Of those, the ones whose check says the caller may not read them. */
const unreadable = new Set<string>();
/** Repositories whose checks of issue threads alone (no members) cannot say. */
const unsureThreads = new Set<string>();
/**
 * Repositories whose object answers as the earlier version did (while a deploy rolls out): no
 * generation in its answer, every thread asked gone.
 */
const earlierObject = new Set<string>();
/**
 * Repositories transferred while an answer reads them: every `feedView`
 * call after the given number answers as judged under another account,
 * with text only that account's readers may see.
 */
const movedAfter = new Map<string, number>();
/** As `movedAfter`, but transferred away and back: the same account, a later ownership generation. */
const regeneratedAfter = new Map<string, number>();

/**
 * `env` whose repository objects count their `feedView` calls and lay
 * `said` over the excerpts they read; access is the real object's.
 */
function withFeedView(base: Env): Env {
  const view =
    (repoId: string, stub: DurableObjectStub<RepoDO>) =>
    async (
      principal: string,
      grantId: string | null,
      members: readonly FeedMember[],
      threads: readonly string[] = [],
    ) => {
      viewCalls.set(repoId, [...(viewCalls.get(repoId) ?? []), members.map(memberKey)]);
      if (earlierObject.has(repoId))
        return {
          readable: true,
          role: "admin" as const,
          excerpts: {},
          gone: [...threads],
          denial: null,
        };
      if (unsureThreads.has(repoId) && members.length === 0 && threads.length > 0)
        return {
          readable: false,
          role: null,
          excerpts: {},
          gone: [],
          epoch: 0,
          denial: { kind: "unknown" as const },
        };
      if (directoryOnly.has(repoId))
        return unreadable.has(repoId)
          ? {
              readable: false,
              role: null,
              excerpts: {},
              gone: [],
              epoch: 0,
              // As a fresh snapshot of an account's ACL would say it.
              denial: {
                kind: "lost" as const,
                loss: { accountId: "acct_double", epochGen: 1, aclVersion: 1, until: Date.now() },
              },
            }
          : {
              readable: true,
              role: "admin" as const,
              excerpts: {},
              gone: [],
              epoch: 0,
              denial: null,
              account: { accountId: directoryOwner.get(repoId) ?? "", ownerGen: 1 },
            };
      const real = await stub.feedView(principal, grantId, members, threads);
      if (!real.readable) return real;
      const excerpts = { ...real.excerpts };
      for (const m of members) {
        const known = said.get(`${repoId}:${memberKey(m)}`);
        if (known !== undefined) excerpts[memberKey(m)] = known;
      }
      const calls = viewCalls.get(repoId)?.length ?? 0;
      const moved = movedAfter.get(repoId);
      const regenerated = regeneratedAfter.get(repoId);
      if (
        (moved !== undefined && calls > moved) ||
        (regenerated !== undefined && calls > regenerated)
      )
        return {
          ...real,
          excerpts: Object.fromEntries(members.map((m) => [memberKey(m), "after the move"])),
          account:
            moved !== undefined
              ? { accountId: "org_elsewhere", ownerGen: 99 }
              : {
                  accountId: real.account?.accountId ?? "",
                  ownerGen: (real.account?.ownerGen ?? 0) + 1,
                },
        };
      return { ...real, excerpts };
    };
  const repos = new Proxy(base.REPO, {
    get(target, prop) {
      if (prop === "getByName")
        return (repoId: string) => {
          const stub = target.getByName(repoId);
          return new Proxy(stub, {
            get(inner, name) {
              if (name === "feedView") return view(repoId, stub);
              const value = Reflect.get(inner, name);
              return typeof value === "function" ? value.bind(inner) : value;
            },
          });
        };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...base, REPO: repos } as Env;
}

/** A request to the API, its repositories' objects with the `feedView` double. */
/** Items the feed operations read a page at a time. */
const SCAN_PAGE = 200;

/** `on` whose feed objects run `before(n)` ahead of their `n`th `method` call (from 0). */
function beforeCalls(
  on: Env,
  method: "listStreams" | "syncStreams",
  before: (n: number) => Promise<void>,
): Env {
  const users = new Proxy(on.USER, {
    get(target, prop) {
      if (prop === "getByName")
        return (name: string) => {
          const stub = target.getByName(name);
          let calls = 0;
          return new Proxy(stub, {
            get(inner, name) {
              if (name === method)
                return async (...args: unknown[]) => {
                  await before(calls++);
                  return Reflect.apply(Reflect.get(inner, name), inner, args);
                };
              // Called through the stub: an RPC method's `bind` would be a call of its own.
              const value = Reflect.get(inner, name);
              return typeof value === "function"
                ? (...args: unknown[]) => Reflect.apply(value, inner, args)
                : value;
            },
          });
        };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...on, USER: users } as Env;
}

function feedFetch(
  path: string,
  headers: Record<string, string>,
  init: RequestInit = {},
  on: Env = withFeedView(env),
) {
  return createApp().fetch(
    new Request(`${ORIGIN}/api${path}`, { ...init, headers }),
    on,
    createExecutionContext(),
  );
}

/** `env` whose feeds run `meanwhile` right before they forget what a read found lost. */
function forgettingAfter(base: Env, meanwhile: () => Promise<void>): Env {
  const users = new Proxy(base.USER, {
    get(target, prop) {
      if (prop === "getByName")
        return (name: string) => {
          const stub = target.getByName(name);
          return new Proxy(stub, {
            get(inner, key) {
              if (key === "forgetRepos")
                return async (losses: Parameters<typeof stub.forgetRepos>[0]) => {
                  await meanwhile();
                  return stub.forgetRepos(losses);
                };
              const value = Reflect.get(inner, key);
              return typeof value === "function"
                ? (...args: unknown[]) => Reflect.apply(value, inner, args)
                : value;
            },
          });
        };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...base, USER: users } as Env;
}

/** `api`, through `feedFetch`. */
function feedApi(method: string, path: string, token: string, body?: unknown) {
  return feedFetch(
    path,
    {
      Authorization: `Bearer ${token}`,
      ...(method !== "GET" && {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      }),
    },
    { method, ...(body !== undefined && { body: JSON.stringify(body) }) },
  );
}

/** An entry for `repoId`, put straight into `principal`'s feed. */
async function deliverTo(principal: string, init: EntryInit & { repoId: string }) {
  await env.USER.getByName(principal).applyFeed([entry({ ...init, principal })]);
}

async function repoOf(owner: Who): Promise<{ id: string; name: string; fullName: string }> {
  const made = await json<{ id: string; name: string }>(
    api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
  );
  expect(made.status).toBe(201);
  return { ...made.body, fullName: `${owner.handle}/${made.body.name}` };
}

/** `n` repositories of `owner` in the directory only (see `directoryOnly`), in order; private unless said. */
async function directoryRepos(
  owner: Who,
  n: number,
  visibility: "private" | "public" = "private",
): Promise<string[]> {
  const repoIds = Array.from({ length: n }, () => uniqueId("rep_"));
  for (const id of repoIds) {
    directoryOnly.add(id);
    directoryOwner.set(id, owner.principalId);
  }
  await env.DIRECTORY.batch(
    repoIds.map((id) =>
      env.DIRECTORY.prepare(
        `INSERT INTO repos (id, owner_id, name, network_id, org_shard, visibility, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'default', ?, 0, 0)`,
      ).bind(id, owner.principalId, id.toLowerCase(), uniqueId("net"), visibility),
    ),
  );
  return repoIds;
}

/** What the principal's feed holds, by item key, whoever may read it. */
async function stored(principal: string): Promise<string[]> {
  const page = await env.USER.getByName(principal).listStreams(FROM_START, 5_000, {});
  if (page.expired) throw new Error("expired");
  return page.items.map((i) => `${i.repoId}:${i.threadKey}:${i.kind}`);
}

/** What a feed cursor names: its snapshot's positions and base, and its count of quiet answers. */
async function snapshotOf(
  principal: string,
  cursor: string,
): Promise<{ positions: [string, string, number][]; base: number | null; quiet: number }> {
  const ref = decodeFeedCursor(cursor);
  if (!ref || !("id" in ref)) throw new Error("not a snapshot's cursor");
  const state = await runInDurableObject(
    env.USER.getByName(principal),
    (_: UserDO, s) =>
      s.storage.sql
        .exec<{ state: string }>("SELECT state FROM feed_cursors WHERE id = ?", ref.id)
        .toArray()[0]?.state,
  );
  if (state === undefined) throw new Error("no such snapshot");
  return {
    ...(JSON.parse(state) as { positions: [string, string, number][]; base: null }),
    quiet: ref.quiet,
  };
}

/** A cursor of before streams: `{v:1,e,s,q}`. */
const legacyCursor = (epoch: string, seq: number) =>
  btoa(JSON.stringify({ v: 1, e: epoch, s: seq }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

type FeedOut = {
  items: {
    item_key: string;
    repo: { full_name: string };
    version: number;
    acked_version: number;
  }[];
  next_cursor: string;
  head_cursor: string;
  poll_after_ms: number;
  code?: string;
  resync?: string;
};

const feedNames = (body: FeedOut) => body.items.map((i) => i.repo.full_name);

describe("the feed operations", () => {
  let owner: Who;
  let repo: Awaited<ReturnType<typeof repoOf>>;
  let other: Awaited<ReturnType<typeof repoOf>>;

  // Each test its own user, repositories and feed: some add to the feed, and tests run in any order.
  beforeEach(async () => {
    owner = await user();
    repo = await repoOf(owner);
    other = await repoOf(owner);
    await deliverTo(owner.principalId, { repoId: repo.id, version: 1 });
    await deliverTo(owner.principalId, { repoId: other.id, version: 1 });
  });

  it("read the user's own feed with its token or its signed-in session", async () => {
    const res = await json<FeedOut>(feedApi("GET", "/feed", owner.token));
    expect(res.status).toBe(200);
    expect(feedNames(res.body)).toEqual([repo.fullName, other.fullName]);
    expect(res.body.next_cursor).toBe(res.body.head_cursor);
    expect(res.body.poll_after_ms).toBeGreaterThan(0);
    const { cookie } = await testSession(owner.principalId);
    const session = await feedFetch("/feed", {
      Cookie: `${SESSION_COOKIE}=${cookie}`,
      "X-Fyrden-Session": "1",
    });
    expect(feedNames(await session.json<FeedOut>())).toEqual([repo.fullName, other.fullName]);
  });

  it("read the represented user's feed with a delegated token, limited to the grant's repositories", async () => {
    const agent = await agentFor(owner, ["pull_requests:read"], [repo.fullName]);
    const res = await json<FeedOut>(feedApi("GET", "/feed", agent.delegated));
    expect(feedNames(res.body)).toEqual([repo.fullName]);
    // Its cursors name only what it was shown.
    const mine = await json<FeedOut>(feedApi("GET", "/feed", owner.token));
    expect(res.body.head_cursor).not.toBe(mine.body.head_cursor);

    // A sub-agent under a narrower grant reads the same user's feed.
    const second = await json<{ id: string; handle: string }>(
      api("POST", "/agents", owner.token, { handle: uniqueId("bot").slice(0, 39) }),
    );
    const secondOwn = await json<{ token: string }>(
      api("POST", `/agents/${second.body.handle}/tokens`, owner.token, {}),
    );
    const sub = await json<{ id: string }>(
      api("POST", "/grants", agent.own, {
        agent: second.body.handle,
        scopes: ["pull_requests:read"],
        parent: agent.grantId,
      }),
    );
    expect(sub.status).toBe(201);
    const exchanged = await exports.default.fetch(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: TOKEN_EXCHANGE,
        subject_token: secondOwn.body.token,
        subject_token_type: ACCESS_TOKEN_TYPE,
        grant_id: sub.body.id,
      }).toString(),
    });
    const { access_token } = await exchanged.json<{ access_token: string }>();
    expect(feedNames((await json<FeedOut>(feedApi("GET", "/feed", access_token))).body)).toEqual([
      repo.fullName,
    ]);
    // A grant without pull request reads shows nothing.
    const narrow = await agentFor(owner, ["metadata:read"]);
    expect((await json<FeedOut>(feedApi("GET", "/feed", narrow.delegated))).body.items).toEqual([]);
  });

  it("read the agent's own feed with the agent's own token", async () => {
    const agent = await agentFor(owner, ["pull_requests:read"]);
    // The agent reads the repository: a role for it in the account's access list.
    const bystander = await user();
    await api("PUT", `/repos/${repo.fullName}/collaborators/${bystander.handle}`, owner.token, {
      permission: "pull",
    });
    await runInDurableObject(env.ORG.getByName(owner.principalId), (_: OrgDO, state) => {
      state.storage.sql.exec(
        "INSERT INTO collaborators (repo_id, principal_id, handle, role, added_at) VALUES (?, ?, ?, 'read', 0)",
        repo.id,
        agent.id,
        uniqueId("bot"),
      );
      state.storage.sql.exec("UPDATE org_meta SET acl_version = acl_version + 1");
    });
    await deliverTo(agent.id, { repoId: repo.id, thread: 7, version: 1 });
    const own = await json<FeedOut>(feedApi("GET", "/feed", agent.own));
    expect(own.body.items.map((i) => i.item_key)).toEqual([`${repo.id}:pull/7:activity`]);
    // The delegated token reads the user's feed instead.
    const delegated = await json<FeedOut>(feedApi("GET", "/feed", agent.delegated));
    expect(delegated.body.items.map((i) => i.item_key)).toEqual([
      `${repo.id}:pull/1:activity`,
      `${other.id}:pull/1:activity`,
    ]);
  });

  it("leave out, in lists, syncs and acknowledgements, items of a repository the caller lost access to", async () => {
    const reader = await user();
    const path = `/repos/${repo.fullName}/collaborators/${reader.handle}`;
    await api("PUT", path, owner.token, { permission: "pull" });
    await deliverTo(reader.principalId, {
      repoId: repo.id,
      kind: "review_requested",
      version: 2,
      priority: "P0",
    });
    const key = `${repo.id}:pull/1:review_requested`;
    expect(feedNames((await json<FeedOut>(feedApi("GET", "/feed", reader.token))).body)).toEqual([
      repo.fullName,
    ]);
    expect(
      (await feedApi("POST", "/feed/ack", reader.token, { item_key: key, epoch: 1, version: 1 }))
        .status,
    ).toBe(200);
    expect((await api("DELETE", path, owner.token)).status).toBe(200);
    const list = await json<FeedOut>(feedApi("GET", "/feed", reader.token));
    expect(list.body.items).toEqual([]);
    expect((await json<FeedOut>(feedApi("GET", "/feed/sync", reader.token))).body.items).toEqual(
      [],
    );
    expect(
      await json(
        feedApi("POST", "/feed/ack", reader.token, { item_key: key, epoch: 1, version: 2 }),
      ),
    ).toMatchObject({ status: 404, body: { code: "feed_item_not_found" } });
  });

  it("acknowledge an item at a version it has", async () => {
    const key = `${repo.id}:pull/1:activity`;
    const ack = (version: number, item_key = key) =>
      json<{ acked_version: number; code?: string }>(
        feedApi("POST", "/feed/ack", owner.token, { item_key, epoch: 1, version }),
      );
    expect(await ack(2)).toMatchObject({ status: 409, body: { code: "version_ahead" } });
    expect(await ack(1)).toMatchObject({
      status: 200,
      body: { item_key: key, version: 1, acked_version: 1 },
    });
    expect((await ack(1, `${repo.id}:pull/1:nonsense`)).status).toBe(404);
    expect((await ack(1, "no-key")).status).toBe(404);
    // Every reader of the feed sees it: the item comes again with the acknowledgement.
    const res = await json<FeedOut>(feedApi("GET", "/feed", owner.token));
    expect(res.body.items.at(-1)).toMatchObject({ item_key: key, acked_version: 1 });
  });

  it("answer an unchanged page 304 by its ETag, and a changed one in full", async () => {
    const first = await feedApi("GET", "/feed", owner.token);
    const etag = first.headers.get("ETag") as string;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(first.headers.get("Cache-Control")).toBe("private, no-cache");
    const again = (tag: string) =>
      feedFetch("/feed", { Authorization: `Bearer ${owner.token}`, "If-None-Match": tag });
    const unchanged = await again(etag);
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get("ETag")).toBe(etag);
    await deliverTo(owner.principalId, { repoId: repo.id, thread: 2, version: 1 });
    const changed = await again(etag);
    expect(changed.status).toBe(200);
    expect(changed.headers.get("ETag")).not.toBe(etag);
  });

  it("ask a caller to poll less often while nothing changes, up to a ceiling, and soon once something does", async () => {
    const follow = (cursor: string) =>
      json<FeedOut>(feedApi("GET", `/feed?since=${cursor}`, owner.token));
    let cursor = (await json<FeedOut>(feedApi("GET", "/feed", owner.token))).body.next_cursor;
    const waits: number[] = [];
    for (let quiet = 0; quiet < 8; quiet++) {
      const res = await follow(cursor);
      expect(res.body.items).toEqual([]);
      waits.push(res.body.poll_after_ms);
      cursor = res.body.next_cursor;
    }
    // Doubling from 30 seconds, then 30 minutes.
    expect(waits).toEqual([
      60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000, 1_800_000,
    ]);
    expect(FEED_POLL.maxMs).toBe(1_800_000);
    // At the ceiling the answer stays the same: unchanged, it is 304 by its ETag.
    const again = (tag: string) =>
      feedFetch(`/feed?since=${cursor}`, {
        Authorization: `Bearer ${owner.token}`,
        "If-None-Match": tag,
      });
    const ceiling = await feedApi("GET", `/feed?since=${cursor}`, owner.token);
    expect((await ceiling.json<FeedOut>()).next_cursor).toBe(cursor);
    expect((await again(ceiling.headers.get("ETag") ?? "")).status).toBe(304);
    // Something new: shown, and the wait starts over.
    await deliverTo(owner.principalId, { repoId: repo.id, thread: 2, version: 1 });
    const news = await follow(cursor);
    expect(news.body).toMatchObject({ items: [{ version: 1 }], poll_after_ms: FEED_POLL.baseMs });
    expect((await follow(news.body.next_cursor)).body.poll_after_ms).toBe(2 * FEED_POLL.baseMs);
    // A sync starts the wait over too.
    expect(
      (await json<FeedOut>(feedApi("GET", "/feed/sync", owner.token))).body.poll_after_ms,
    ).toBe(FEED_POLL.baseMs);
  });

  it("refuse a cursor of another epoch or credential, or whose snapshot is gone, with 410 and where to resync", async () => {
    const head = await json<FeedOut>(feedApi("GET", "/feed", owner.token));
    const named = decodeFeedCursor(head.body.head_cursor);
    if (!named || !("id" in named)) throw new Error("not a snapshot's cursor");
    // Another credential of the same principal: the snapshot is the token's own.
    const other = await scopedToken(owner.principalId, ["pull_requests:read", "issues:read"]);
    for (const [since, token] of [
      [encodeFeedCursor("another", named.id), owner.token],
      [encodeFeedCursor(named.epoch, "0".repeat(32)), owner.token],
      [head.body.next_cursor, other],
      // Of before streams: past the feed's head then.
      [legacyCursor(named.epoch, 1_000_000), owner.token],
    ] as const) {
      const res = await json<FeedOut>(feedApi("GET", `/feed?since=${since}`, token));
      expect(res).toMatchObject({
        status: 410,
        body: { code: "cursor_expired", resync: "/api/feed/sync" },
      });
    }
    // Not a cursor, or one counting more quiet answers than any the feed hands out.
    for (const since of ["not-a-cursor", encodeFeedCursor(named.epoch, named.id, 7)])
      expect(
        await json<FeedOut>(feedApi("GET", `/feed?since=${since}`, owner.token)),
      ).toMatchObject({
        status: 422,
        body: { code: "invalid_cursor" },
      });
    // Following the cursor: nothing new.
    const next = await json<FeedOut>(
      feedApi("GET", `/feed?since=${head.body.next_cursor}`, owner.token),
    );
    expect(next.body.items).toEqual([]);
    // Sync gives the cursor to follow from: the same snapshot.
    const synced = await json<FeedOut>(feedApi("GET", "/feed/sync", owner.token));
    expect(synced.body.head_cursor).toBe(head.body.head_cursor);
    // A cursor of before streams at the start reads on, answered with a snapshot's.
    const legacy = await json<FeedOut>(
      feedApi("GET", `/feed?since=${legacyCursor(named.epoch, 0)}`, owner.token),
    );
    expect(legacy.status).toBe(200);
    expect(legacy.body.items.length).toBeGreaterThan(0);
    expect(await snapshotOf(owner.principalId, legacy.body.next_cursor)).toMatchObject({
      base: 0,
    });
  });

  it("expire a cursor behind what a stream it may read lost, never one behind a stream it may not", async () => {
    const someone = await user();
    const [shown, hidden] = [await repoOf(someone), await repoOf(someone)];
    for (const repoId of [shown.id, hidden.id])
      await deliverTo(someone.principalId, { repoId, version: 1 });
    // A token limited to one of them: the other is hidden from it, never forgotten.
    const limited = await scopedToken(someone.principalId, [], "pat", [shown.id]);
    const first = await json<FeedOut>(feedApi("GET", "/feed", limited));
    expect(feedNames(first.body)).toEqual([shown.fullName]);
    const named = decodeFeedCursor(first.body.next_cursor);
    if (!named || !("id" in named)) throw new Error("not a snapshot's cursor");
    const feed = env.USER.getByName(someone.principalId);
    // Both streams lost their first items (as retention or a cap would), and the snapshot is
    // behind in one of them.
    const behindIn = (repoId: string) =>
      runInDurableObject(feed, (_: UserDO, state) => {
        state.storage.sql.exec("UPDATE feed_streams SET low_watermark = 5");
        state.storage.sql.exec(
          "UPDATE feed_cursors SET state = ?, hash = 0 WHERE id = ?",
          JSON.stringify({ positions: [[repoId, "pull", 1]], base: null }),
          named.id,
        );
      });
    await behindIn(hidden.id);
    const read = () =>
      json<FeedOut>(feedApi("GET", `/feed?since=${first.body.next_cursor}`, limited));
    expect((await read()).status).toBe(200);
    await behindIn(shown.id);
    expect(await read()).toMatchObject({ status: 410, body: { code: "cursor_expired" } });
    // A cursor of before streams at the start is behind both: expired for the one it reads.
    const legacy = legacyCursor(named.epoch, 0);
    expect((await json<FeedOut>(feedApi("GET", `/feed?since=${legacy}`, limited))).status).toBe(
      410,
    );
    await runInDurableObject(feed, (_: UserDO, state) => {
      state.storage.sql.exec(
        "UPDATE feed_streams SET low_watermark = 0 WHERE repo_id = ?",
        shown.id,
      );
    });
    expect((await json<FeedOut>(feedApi("GET", `/feed?since=${legacy}`, limited))).status).toBe(
      200,
    );
  });

  it("expire a cursor when what it had not read of a stream is deleted between an answer's pages", async () => {
    const someone = await user();
    const [early, late] = await directoryRepos(someone, 2);
    // A page and more of a repository the caller may not read first, then the other's: the
    // answer reads on to a second page, which holds the later repository's.
    unreadable.add(early as string);
    const feed = env.USER.getByName(someone.principalId);
    await feed.applyFeed(
      Array.from({ length: SCAN_PAGE + 5 }, (_, i) =>
        entry({
          repoId: early as string,
          thread: i + 1,
          version: 1,
          principal: someone.principalId,
        }),
      ),
    );
    await feed.applyFeed(
      [1, 2, 3].map((thread) =>
        entry({ repoId: late as string, thread, version: 1, principal: someone.principalId }),
      ),
    );
    const { epoch } = await feed.syncStreams(null, 1, {});
    // A cursor of before streams at the start: every stream at 0.
    const since = legacyCursor(epoch, 0);
    // Between the pages, the later repository's first item is deleted, as a cap would (its
    // stream's low watermark raised past it).
    const deleted = beforeCalls(withFeedView(env), "listStreams", async (n) => {
      if (n !== 1) return;
      await runInDurableObject(feed, (_: UserDO, state) => {
        const { feed_seq: seq } = state.storage.sql
          .exec<{ feed_seq: number }>(
            "DELETE FROM feed_items WHERE repo_id = ? AND thread_key = 'pull/1' RETURNING feed_seq",
            late as string,
          )
          .one();
        state.storage.sql.exec(
          "UPDATE feed_streams SET low_watermark = ?, items = items - 1 WHERE repo_id = ?",
          seq,
          late as string,
        );
      });
    });
    const res = await listOn(deleted, someone.token, `/feed?limit=100&since=${since}`);
    expect(res).toMatchObject({ status: 410, body: { code: "cursor_expired" } });
  });

  it("follow 1,000 streams at most, and expire nothing for a stream left out", async () => {
    const someone = await user();
    const [joined, left] = await directoryRepos(someone, 2);
    const feed = env.USER.getByName(someone.principalId);
    await feed.applyFeed([
      entry({ repoId: joined as string, version: 1, principal: someone.principalId }),
    ]);
    // More than a page of the other's: the answer reads on to a second page.
    await feed.applyFeed(
      Array.from({ length: SCAN_PAGE + 50 }, (_, i) =>
        entry({
          repoId: left as string,
          thread: i + 1,
          version: 1,
          principal: someone.principalId,
        }),
      ),
    );
    // A cursor with positions in 999 other streams: room for one more.
    const start = await json<FeedOut>(feedApi("GET", "/feed?limit=1", someone.token));
    const named = decodeFeedCursor(start.body.next_cursor);
    if (!named || !("id" in named)) throw new Error("not a snapshot's cursor");
    const positions = Array.from(
      { length: FEED_POLICY.coverage - 1 },
      (_, i) => [`rep_elsewhere${String(i).padStart(4, "0")}`, "pull", 0] as const,
    );
    await runInDurableObject(feed, (_: UserDO, state) => {
      state.storage.sql.exec(
        "UPDATE feed_cursors SET state = ? WHERE id = ?",
        JSON.stringify({ positions, base: null }),
        named.id,
      );
    });
    // Between the pages, the left-out stream loses items it had not given (as its cap would).
    const evicted = beforeCalls(withFeedView(env), "listStreams", async (n) => {
      if (n !== 1) return;
      await runInDurableObject(feed, (_: UserDO, state) => {
        state.storage.sql.exec(
          "UPDATE feed_streams SET low_watermark = (SELECT head_seq FROM feed_meta) WHERE repo_id = ?",
          left as string,
        );
      });
    });
    const res = await listOn(evicted, someone.token, `/feed?since=${start.body.next_cursor}`);
    expect(res.status).toBe(200);
    // The first stream took the last place; the other's items are left out, and said so.
    expect(res.body.items.map((i) => i.item_key)).toEqual([`${joined}:pull/1:activity`]);
    expect(res.body).toMatchObject({ coverage: "partial" });
  });

  it("sync in one read of the feed, incomplete when more is left than it holds", async () => {
    const someone = await user();
    const [shown] = await directoryRepos(someone, 1);
    const hidden = await directoryRepos(someone, 2);
    for (const id of hidden) unreadable.add(id);
    const feed = env.USER.getByName(someone.principalId);
    await feed.applyFeed([
      entry({ repoId: shown as string, version: 1, principal: someone.principalId }),
    ]);
    // Newer than it: more of what the caller may not read than a sync reads at once.
    vi.setSystemTime(Date.now() + 1_000);
    await feed.applyFeed(
      Array.from({ length: FEED_POLICY.syncItems + 2 }, (_, i) =>
        entry({
          repoId: hidden[i % 2] as string,
          thread: i + 1,
          version: 1,
          principal: someone.principalId,
        }),
      ),
    );
    let calls = 0;
    const counting = beforeCalls(withFeedView(env), "syncStreams", async () => {
      calls++;
    });
    const res = await listOn(counting, someone.token, "/feed/sync");
    expect(calls).toBe(1);
    expect(res.body).toMatchObject({ items: [], complete: false });
  });

  it("show a token limited to some repositories nothing of the others: no item, cursor or ETag changes", async () => {
    const someone = await user();
    const shown = await repoOf(someone);
    const hidden = await repoOf(someone);
    await deliverTo(someone.principalId, {
      repoId: shown.id,
      kind: "review_requested",
      version: 1,
      priority: "P0",
    });
    await deliverTo(someone.principalId, {
      repoId: hidden.id,
      kind: "review_requested",
      version: 1,
      priority: "P0",
    });
    const limited = await scopedToken(someone.principalId, [], "pat", [shown.id]);
    const read = async (path: string) => {
      const res = await feedApi("GET", path, limited);
      return {
        etag: res.headers.get("ETag"),
        body: await res.json<FeedOut & { complete?: boolean }>(),
      };
    };
    const before = { list: await read("/feed"), sync: await read("/feed/sync") };
    expect(feedNames(before.list.body)).toEqual([shown.fullName]);
    expect(feedNames(before.sync.body)).toEqual([shown.fullName]);
    expect(before.sync.body.complete).toBe(true);
    // Activity in the other repository only: the limited token's answers stay the same.
    await deliverTo(someone.principalId, { repoId: hidden.id, version: 1 });
    await deliverTo(someone.principalId, { repoId: hidden.id, thread: 2, version: 1 });
    const after = { list: await read("/feed"), sync: await read("/feed/sync") };
    expect(after.list).toEqual(before.list);
    expect(after.sync.body).toEqual(before.sync.body);
    const since = await read(`/feed?since=${before.list.body.next_cursor}`);
    expect(since.body.items).toEqual([]);
    // The same place, one quiet answer on: as for anyone whose feed did not change.
    expect(decodeFeedCursor(since.body.head_cursor)).toEqual({
      ...decodeFeedCursor(before.list.body.next_cursor),
      quiet: 1,
    });
    expect(since.body.poll_after_ms).toBe(2 * FEED_POLL.baseMs);
    // Its own repository's items are acknowledged; the other's are not found.
    const ack = (repoId: string) =>
      feedApi("POST", "/feed/ack", limited, {
        item_key: `${repoId}:pull/1:review_requested`,
        epoch: 1,
        version: 1,
      });
    expect((await ack(shown.id)).status).toBe(200);
    expect((await ack(hidden.id)).status).toBe(404);
    // The owner's own token sees both.
    expect(
      feedNames((await json<FeedOut>(feedApi("GET", "/feed", someone.token))).body),
    ).toHaveLength(4);
  });

  it("continue past their budget of repository checks with a cursor", async () => {
    const someone = await user();
    const repoIds = await directoryRepos(someone, 105);
    await env.USER.getByName(someone.principalId).applyFeed(
      repoIds.map((repoId) => entry({ repoId, version: 1, principal: someone.principalId })),
    );
    const first = await json<FeedOut>(feedApi("GET", "/feed?limit=100", someone.token));
    // 100 repositories checked: the rest is the next page's.
    expect(first.body.items).toHaveLength(100);
    expect(first.body.poll_after_ms).toBe(0);
    const second = await json<FeedOut>(
      feedApi("GET", `/feed?limit=100&since=${first.body.next_cursor}`, someone.token),
    );
    expect(second.body.items.map((i) => i.repo.full_name.split("/")[1])).toEqual(
      repoIds.slice(100).map((id) => id.toLowerCase()),
    );
    expect(second.body.poll_after_ms).toBe(FEED_POLL.baseMs);
  });

  it("get past items of repositories the owner may not read, however many come first, forgetting them", async () => {
    const someone = await user();
    const hidden = await directoryRepos(someone, 150);
    for (const id of hidden) unreadable.add(id);
    const shown = await directoryRepos(someone, 3);
    const keys = shown.map((id) => `${id}:pull/1:activity`);
    const feed = env.USER.getByName(someone.principalId);
    await feed.applyFeed(
      hidden.map((repoId) => entry({ repoId, version: 1, principal: someone.principalId })),
    );
    // Changed later: after the hidden ones in the feed's order.
    vi.setSystemTime(Date.now() + 1_000);
    await feed.applyFeed(
      shown.map((repoId) => entry({ repoId, version: 1, principal: someone.principalId })),
    );
    const read = (cursor?: string) =>
      json<FeedOut>(
        feedApi("GET", cursor === undefined ? "/feed" : `/feed?since=${cursor}`, someone.token),
      );
    // A check budget of repositories it may not read: as quiet as an answer with nothing new,
    // and those repositories' items are gone from the feed (the owner lost them).
    const first = await read();
    expect(first.body).toMatchObject({ items: [], poll_after_ms: 2 * FEED_POLL.baseMs });
    expect(await stored(someone.principalId)).toHaveLength(53);
    // The next answer gets past the rest of them.
    const second = await read(first.body.next_cursor);
    expect(second.body.items.map((i) => i.item_key)).toEqual(keys);
    expect(await stored(someone.principalId)).toEqual(keys);
    // The same request again: the same items, none skipped.
    expect((await read(first.body.next_cursor)).body).toEqual(second.body);
  });

  it("get past hidden items that take the whole budget of items read", async () => {
    const someone = await user();
    const shown = await directoryRepos(someone, 1);
    const feed = env.USER.getByName(someone.principalId);
    // Repositories gone from the directory: their items are left out without a check (two of
    // them, each within its stream's cap).
    const gone = [uniqueId("rep_"), uniqueId("rep_")];
    await feed.applyFeed(
      Array.from({ length: 1_000 }, (_, i) =>
        entry({
          repoId: gone[i % 2] as string,
          thread: i + 1,
          version: 1,
          principal: someone.principalId,
        }),
      ),
    );
    vi.setSystemTime(Date.now() + 1_000);
    await feed.applyFeed(
      shown.map((repoId) => entry({ repoId, version: 1, principal: someone.principalId })),
    );
    const first = await json<FeedOut>(feedApi("GET", "/feed", someone.token));
    expect(first.body).toMatchObject({ items: [], poll_after_ms: 2 * FEED_POLL.baseMs });
    const second = await json<FeedOut>(
      feedApi("GET", `/feed?since=${first.body.next_cursor}`, someone.token),
    );
    expect(second.body.items.map((i) => i.item_key)).toEqual(
      shown.map((id) => `${id}:pull/1:activity`),
    );
  });

  it("answer alike however much activity the caller may not see comes, past its budgets too", async () => {
    // Two feeds with the same item the caller sees (of a public repository: both read it); one
    // also gets activity it may not see.
    const [quiet, busy] = [await user(), await user()];
    const [seen] = await directoryRepos(quiet, 1, "public");
    const at = Date.now();
    for (const who of [quiet, busy])
      await env.USER.getByName(who.principalId).applyFeed([
        entry({ repoId: seen ?? "", version: 1, principal: who.principalId, occurredAt: at }),
      ]);
    const bursts = [
      async () => {
        const hidden = await directoryRepos(busy, 120);
        for (const id of hidden) unreadable.add(id);
        await env.USER.getByName(busy.principalId).applyFeed(
          hidden.map((repoId) => entry({ repoId, version: 1, principal: busy.principalId })),
        );
      },
      async () => {
        const gone = [uniqueId("rep_"), uniqueId("rep_"), uniqueId("rep_")];
        await env.USER.getByName(busy.principalId).applyFeed(
          Array.from({ length: 1_100 }, (_, i) =>
            entry({
              repoId: gone[i % 3] as string,
              thread: i + 1,
              version: 1,
              principal: busy.principalId,
            }),
          ),
        );
      },
      async () => {},
      async () => {},
    ];
    // Each feed's answers along its cursors, as what they name (a snapshot's id is random).
    const answers = async (who: Who, between?: (step: number) => Promise<void>) => {
      const out: unknown[] = [];
      let cursor: string | undefined;
      for (let step = 0; step < 5; step++) {
        if (step > 0) await between?.(step - 1);
        const res = await json<FeedOut>(
          feedApi("GET", cursor === undefined ? "/feed" : `/feed?since=${cursor}`, who.token),
        );
        const { head_cursor, next_cursor, ...body } = res.body;
        const id = (c: string | undefined) => {
          const named = decodeFeedCursor(c);
          return named && "id" in named ? named.id : null;
        };
        out.push({
          ...body,
          next_cursor: await snapshotOf(who.principalId, next_cursor),
          same: head_cursor === next_cursor,
          // The same snapshot as the request's: nothing written.
          kept: id(next_cursor) === id(cursor),
        });
        cursor = res.body.next_cursor;
      }
      return out;
    };
    const expected = await answers(quiet);
    expect(await answers(busy, (step) => bursts[step]?.() ?? Promise.resolve())).toEqual(expected);
    // The same request before and after more of it: the same answer, ETag included.
    const cursor = (await json<FeedOut>(feedApi("GET", "/feed", busy.token))).body.next_cursor;
    const before = await feedApi("GET", `/feed?since=${cursor}`, busy.token);
    await bursts[0]?.();
    const after = await feedApi("GET", `/feed?since=${cursor}`, busy.token);
    expect(after.headers.get("ETag")).toBe(before.headers.get("ETag"));
    expect(await after.json()).toEqual(await before.json());
  });

  it("forget nothing when a repository cannot tell its access now, and show it again once it can", async () => {
    const reader = await user();
    await api("PUT", `/repos/${repo.fullName}/collaborators/${reader.handle}`, owner.token, {
      permission: "pull",
    });
    await deliverTo(reader.principalId, { repoId: repo.id, version: 2 });
    const key = `${repo.id}:pull/1:activity`;
    const keys = async () =>
      (await json<FeedOut>(feedApi("GET", "/feed", reader.token))).body.items.map(
        (i) => i.item_key,
      );
    expect(await keys()).toEqual([key]);
    // The account's object fails every pull, and the repository's snapshot is too old to decide by.
    const org = env.ORG.getByName(owner.principalId);
    await runInDurableObject(org, (instance: OrgDO) => {
      instance.snapshotFor = async () => {
        throw new Error("unavailable");
      };
    });
    vi.setSystemTime(Date.now() + ACL_POLICY.writeWindowMs + 1_000);
    expect(await keys()).toEqual([]);
    expect(await stored(reader.principalId)).toEqual([key]);
    await runInDurableObject(org, (instance: OrgDO) => {
      Reflect.deleteProperty(instance, "snapshotFor");
    });
    expect(await keys()).toEqual([key]);
  });

  it("forget only what was lost when access was checked, not activity of access given back since", async () => {
    const reader = await user();
    const path = `/repos/${repo.fullName}/collaborators/${reader.handle}`;
    await api("PUT", path, owner.token, { permission: "pull" });
    await deliverTo(reader.principalId, { repoId: repo.id, version: 2 });
    expect((await api("DELETE", path, owner.token)).status).toBe(200);
    // Between the check that found access lost and the forgetting: access given back, and news.
    const on = forgettingAfter(withFeedView(env), async () => {
      await api("PUT", path, owner.token, { permission: "pull" });
      await deliverTo(reader.principalId, { repoId: repo.id, thread: 2, version: 3 });
    });
    const res = await feedFetch("/feed", { Authorization: `Bearer ${reader.token}` }, {}, on);
    expect((await res.json<FeedOut>()).items).toEqual([]);
    expect(await stored(reader.principalId)).toEqual([`${repo.id}:pull/2:activity`]);
    expect(
      (await json<FeedOut>(feedApi("GET", "/feed", reader.token))).body.items.map(
        (i) => i.item_key,
      ),
    ).toEqual([`${repo.id}:pull/2:activity`]);
  });

  it("forget nothing for a token whose own limits hide a repository", async () => {
    const someone = await user();
    const [kept, other] = await directoryRepos(someone, 2);
    const feed = env.USER.getByName(someone.principalId);
    await feed.applyFeed(
      [kept, other].map((repoId) =>
        entry({ repoId: repoId ?? "", version: 1, principal: someone.principalId }),
      ),
    );
    // Without pull request reads, it is shown nothing, and the owner's feed keeps both.
    const narrow = await scopedToken(someone.principalId, ["metadata:read"]);
    expect((await json<FeedOut>(feedApi("GET", "/feed", narrow))).body.items).toEqual([]);
    expect(await stored(someone.principalId)).toHaveLength(2);
  });

  it("expire cursors made before the feed's object was restored", async () => {
    const someone = await user();
    const made = await repoOf(someone);
    await deliverTo(someone.principalId, { repoId: made.id, version: 1 });
    const before = await json<FeedOut>(feedApi("GET", "/feed", someone.token));
    // A restore: the directory allocates the feed's next generation, and the object starts again.
    await env.DIRECTORY.prepare("INSERT INTO source_epochs (source_id, epoch_gen) VALUES (?, 1)")
      .bind(`feed:${someone.principalId}`)
      .run();
    await evictDurableObject(env.USER.getByName(someone.principalId));
    const stale = await json<FeedOut>(
      feedApi("GET", `/feed?since=${before.body.next_cursor}`, someone.token),
    );
    expect(stale).toMatchObject({ status: 410, body: { code: "cursor_expired" } });
    const fresh = await json<FeedOut>(feedApi("GET", "/feed", someone.token));
    expect(fresh.body.items).toHaveLength(1);
    expect(fresh.body.head_cursor).not.toBe(before.body.head_cursor);
  });

  it("show what each item's member says now, read with its repository's check in one call", async () => {
    const someone = await user();
    const made = await repoOf(someone);
    const to = { repoId: made.id, principal: someone.principalId };
    await env.USER.getByName(someone.principalId).applyFeed([
      entry({ ...to, version: 1, member: "comment/1" }),
      entry({ ...to, version: 2, member: "comment/2" }),
      entry({ ...to, kind: "mention", version: 3, member: "review_comment/7", priority: "P0" }),
      entry({ ...to, kind: "review_requested", version: 3, member: null, priority: "P0" }),
    ]);
    said.set(`${made.id}:1 pull/1 comment/2`, "second");
    said.set(`${made.id}:1 pull/1 review_comment/7`, null);
    const excerpts = async (path: string) =>
      (
        await json<{ items: { kind: string; excerpt: string | null }[] }>(
          feedApi("GET", path, someone.token),
        )
      ).body.items.map((i) => [i.kind, i.excerpt]);
    viewCalls.delete(made.id);
    // The greatest comment's text; a gone member's none; nothing for an item without one.
    expect(await excerpts("/feed")).toEqual([
      ["activity", "second"],
      ["mention", null],
      ["review_requested", null],
    ]);
    expect(viewCalls.get(made.id)).toEqual([["1 pull/1 comment/2", "1 pull/1 review_comment/7"]]);
    // An edit shows at once.
    said.set(`${made.id}:1 pull/1 comment/2`, "second, edited");
    expect(await excerpts("/feed/sync")).toContainEqual(["activity", "second, edited"]);
  });

  it("read a member for each thread and generation that names it, past the first batch too", async () => {
    const someone = await user();
    const made = await repoOf(someone);
    const to = { repoId: made.id, principal: someone.principalId };
    // 105 threads each naming its own comment (past one call's 100 members), then one id named
    // by two threads and, on one thread, by items of two restore generations (as after a
    // restore set the repository's ids back).
    const filler = Array.from({ length: 105 }, (_, i) =>
      entry({ ...to, thread: 10 + i, version: 1, member: `comment/${1000 + i}` }),
    );
    await env.USER.getByName(someone.principalId).applyFeed([
      entry({ ...to, thread: 1, version: 2, member: "comment/7" }),
      entry({
        ...to,
        thread: 1,
        kind: "mention",
        priority: "P0",
        epochGen: 2,
        version: 1,
        member: "comment/7",
      }),
      entry({ ...to, thread: 2, subject: "issue", version: 2, member: "comment/7" }),
    ]);
    // The filler after: newer, so the pairs above fall past the first 100 members asked.
    await env.USER.getByName(someone.principalId).applyFeed(filler);
    for (let i = 0; i < 105; i++)
      said.set(`${made.id}:1 pull/${10 + i} comment/${1000 + i}`, `c${i}`);
    // What the repository says of each pair (its binding of members is its own tests'): each
    // pair's answer must reach its own item.
    said.set(`${made.id}:1 pull/1 comment/7`, "told before the restore");
    said.set(`${made.id}:2 pull/1 comment/7`, "told after the restore");
    said.set(`${made.id}:1 issue/2 comment/7`, "on issue 2");
    viewCalls.delete(made.id);
    const items = async (path: string) => {
      const shown = new Map<string, string | null>();
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const at: string =
          cursor === null ? path : `${path}${path.includes("?") ? "&" : "?"}since=${cursor}`;
        const body = (
          await json<{
            items: { thread_key: string; kind: string; excerpt: string | null }[];
            next_cursor: string | null;
          }>(feedApi("GET", at, someone.token))
        ).body;
        for (const i of body.items) shown.set(`${i.thread_key} ${i.kind}`, i.excerpt);
        if (body.items.length === 0 || body.next_cursor === null) break;
        cursor = body.next_cursor;
      }
      return shown;
    };
    for (const path of ["/feed?limit=100", "/feed/sync"]) {
      const shown = await items(path);
      expect(shown.get("pull/1 activity"), path).toBe("told before the restore");
      expect(shown.get("pull/1 mention"), path).toBe("told after the restore");
      expect(shown.get("issue/2 activity"), path).toBe("on issue 2");
      for (let i = 0; i < 105; i++)
        expect(shown.get(`pull/${10 + i} activity`), path).toBe(`c${i}`);
    }
    // Every call within 100 members; each pair asked once an answer.
    const calls = viewCalls.get(made.id) ?? [];
    for (const call of calls) {
      expect(call.length).toBeLessThanOrEqual(100);
      expect(new Set(call).size).toBe(call.length);
    }
    expect(new Set(calls.flat())).toEqual(
      new Set([
        ...filler.map((_, i) => `1 pull/${10 + i} comment/${1000 + i}`),
        "1 pull/1 comment/7",
        "2 pull/1 comment/7",
        "1 issue/2 comment/7",
      ]),
    );
  });

  it("stop before a gone thread's item told in a later generation, never hiding or skipping it", async () => {
    const someone = await user();
    const made = await repoOf(someone);
    const path = `/repos/${made.fullName}`;
    // Issue n deleted: its thread is gone in the repository's generation now.
    const issue = await json<{ number: number }>(
      api("POST", `${path}/issues`, someone.token, { title: "Gone soon" }),
    );
    expect((await api("DELETE", `${path}/issues/${issue.body.number}`, someone.token)).ok).toBe(
      true,
    );
    const epoch = await inRepo(env.REPO.getByName(made.id), (r: RepoDO) => r.events.epochGen());
    const to = { repoId: made.id, principal: someone.principalId };
    const feed = env.USER.getByName(someone.principalId);
    // Told before: the deleted issue's item. Told in a later generation (a restore gave the number
    // to a new conversation): its item. Then unrelated activity.
    await feed.applyFeed([
      entry({ ...to, thread: issue.body.number, subject: "issue", epochGen: epoch, version: 1 }),
    ]);
    await feed.applyFeed([
      entry({
        ...to,
        thread: issue.body.number,
        subject: "issue",
        kind: "mention",
        priority: "P0",
        epochGen: epoch + 1,
        version: 1,
      }),
    ]);
    await feed.applyFeed([entry({ ...to, thread: 1, epochGen: epoch, version: 1 })]);
    for (const read of ["/feed", "/feed/sync"]) {
      const answer = await json<{ items: { thread_key: string; kind: string }[] }>(
        feedApi("GET", read, someone.token),
      );
      expect(answer.status, read).toBe(200);
      // The later generation's item is neither shown nor passed: the answer ends before it.
      const shown = answer.body.items.map((i) => `${i.thread_key} ${i.kind}`);
      expect(shown, read).not.toContain(`issue/${issue.body.number} mention`);
      expect(shown, read).not.toContain("pull/1 activity");
    }
    // Only the gone generation's item was forgotten.
    const left = await feed.listStreams(FROM_START, 100, {});
    if (left.expired) throw new Error("expired");
    expect(left.items.map((i) => `${i.threadKey} ${i.kind} ${i.epoch}`).sort()).toEqual(
      [`issue/${issue.body.number} mention ${epoch + 1}`, `pull/1 activity ${epoch}`].sort(),
    );
  });

  it("take the earlier call shapes during a deploy, showing and forgetting nothing", async () => {
    const someone = await user();
    const made = await repoOf(someone);
    const comment = await json<{ id: number }>(
      api("POST", `/repos/${made.fullName}/issues`, someone.token, { title: "Here" }),
    );
    expect(comment.status).toBe(201);
    // An earlier Worker: members alone.
    const view = await env.REPO.getByName(made.id).feedView(someone.principalId, null, [
      "issue/1",
      "comment/1",
    ] as never);
    expect(view.readable).toBe(true);
    expect(view.excerpts).toEqual({});
    // An earlier Worker: gone threads without their generation.
    const to = { repoId: made.id, principal: someone.principalId };
    const feed = env.USER.getByName(someone.principalId);
    await feed.applyFeed([entry({ ...to, thread: 1, subject: "issue", version: 1 })]);
    expect(await feed.forgetThreads([{ repoId: made.id, threadKey: "issue/1" }] as never)).toEqual({
      deleted: 0,
    });
  });

  it("take an earlier object's answer without its generation as no check, ending the answer there", async () => {
    const someone = await user();
    const made = await repoOf(someone);
    earlierObject.add(made.id);
    const to = { repoId: made.id, principal: someone.principalId };
    const feed = env.USER.getByName(someone.principalId);
    // An assignment (no member) on an issue the earlier object says is gone, then later activity.
    await feed.applyFeed([
      entry({
        ...to,
        thread: 7,
        subject: "issue",
        kind: "assigned",
        priority: "P0",
        member: null,
        version: 1,
      }),
    ]);
    await feed.applyFeed([entry({ ...to, thread: 1, version: 1 })]);
    for (const read of ["/feed", "/feed/sync"]) {
      const answer = await json<{ items: { thread_key: string }[] }>(
        feedApi("GET", read, someone.token),
      );
      expect(answer.status, read).toBe(200);
      expect(
        answer.body.items.map((i) => i.thread_key),
        read,
      ).toEqual([]);
    }
    // Nothing forgotten on its word.
    const left = await feed.listStreams(FROM_START, 100, {});
    if (left.expired) throw new Error("expired");
    expect(left.items).toHaveLength(2);
    earlierObject.delete(made.id);
  });

  it("forget a gone thread's items only of the generation it was found gone in, or earlier", async () => {
    const someone = await user();
    const made = await repoOf(someone);
    const to = { repoId: made.id, principal: someone.principalId };
    const feed = env.USER.getByName(someone.principalId);
    // Issue 7 deleted in generation 1; after a restore a new issue 7 is told in generation 2.
    await feed.applyFeed([
      entry({ ...to, thread: 7, subject: "issue", version: 1 }),
      entry({
        ...to,
        thread: 7,
        subject: "issue",
        kind: "mention",
        priority: "P0",
        epochGen: 2,
        version: 1,
      }),
    ]);
    const gone = { repoId: made.id, threadKey: "issue/7" };
    expect(await feed.forgetGoneThreads([{ ...gone, epoch: 1 }])).toEqual({ deleted: 1 });
    expect(await feed.forgetGoneThreads([{ ...gone, epoch: 1 }])).toEqual({ deleted: 0 });
    expect(await feed.forgetGoneThreads([{ ...gone, epoch: 2 }])).toEqual({ deleted: 1 });
  });

  it("give a token shown nothing cursors it can follow after retention deleted what it did not see", async () => {
    const someone = await user();
    const shown = await repoOf(someone);
    const hidden = await repoOf(someone);
    const t0 = Date.now();
    await deliverTo(someone.principalId, { repoId: hidden.id, version: 1 });
    vi.setSystemTime(t0 + 3 * DAY);
    await deliverTo(someone.principalId, { repoId: hidden.id, thread: 2, version: 1 });
    vi.setSystemTime(t0 + FEED_POLICY.retentionMs + 1_000);
    // Retention deletes the other repository's first item: the low watermark moves past it.
    expect(await runDurableObjectAlarm(env.USER.getByName(someone.principalId))).toBe(true);
    const limited = await scopedToken(someone.principalId, [], "pat", [shown.id]);
    const synced = await json<FeedOut>(feedApi("GET", "/feed/sync", limited));
    expect(synced.body.items).toEqual([]);
    const after = await json<FeedOut>(
      feedApi("GET", `/feed?since=${synced.body.head_cursor}`, limited),
    );
    expect(after).toMatchObject({ status: 200, body: { items: [] } });
    // A list from the start hands out a cursor it can follow too.
    const start = await json<FeedOut>(feedApi("GET", "/feed", limited));
    const next = await feedApi("GET", `/feed?since=${start.body.next_cursor}`, limited);
    expect(next.status).toBe(200);
  });
});

/**
 * `base` whose accounts' objects count their `confirmReaders` calls in
 * `counted`, and fail them while `failing` says so.
 */
function withAccounts(base: Env, counted: { calls: number; failing?: boolean }): Env {
  const orgs = new Proxy(base.ORG, {
    get(target, prop) {
      if (prop === "getByName")
        // The feed's reads ask accounts' objects this alone.
        return (name: string) => ({
          confirmReaders: async (repoIds: readonly string[], principals: readonly string[]) => {
            counted.calls++;
            if (counted.failing) throw new Error("the account's object is unavailable");
            return target.getByName(name).confirmReaders(repoIds, principals);
          },
        });
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...base, ORG: orgs } as Env;
}

const listOn = (on: Env, token: string, path = "/feed") =>
  json<FeedOut>(feedFetch(path, { Authorization: `Bearer ${token}` }, {}, on));

describe("the feed operations' authoritative check", () => {
  it("hides a public repository its account let go, though the repository still says it reads", async () => {
    const [owner, someone] = [await user(), await user()];
    const [repoId] = await directoryRepos(owner, 1, "public");
    await deliverTo(someone.principalId, { repoId: repoId as string, version: 1 });
    expect((await json<FeedOut>(feedApi("GET", "/feed", someone.token))).body.items).toHaveLength(
      1,
    );
    await runInDurableObject(env.ORG.getByName(owner.principalId), (_: OrgDO, state) => {
      state.storage.sql.exec(
        "INSERT INTO released_repos (repo_id, transfer_id, released_at) VALUES (?, 'tr_x', 0)",
        repoId as string,
      );
    });
    expect((await json<FeedOut>(feedApi("GET", "/feed", someone.token))).body.items).toEqual([]);
  });

  it("stops before a repository whose account cannot answer, forgetting nothing, and goes on once it can", async () => {
    const someone = await user();
    const [repoId] = await directoryRepos(someone, 1);
    await deliverTo(someone.principalId, { repoId: repoId as string, version: 1 });
    const counted = { calls: 0, failing: true };
    const stopped = await listOn(withAccounts(withFeedView(env), counted), someone.token);
    expect(counted.calls).toBe(1);
    expect(stopped.body.items).toEqual([]);
    expect(await snapshotOf(someone.principalId, stopped.body.next_cursor)).toMatchObject({
      positions: [],
    });
    expect(await stored(someone.principalId)).toHaveLength(1);
    expect((await json<FeedOut>(feedApi("GET", "/feed", someone.token))).body.items).toHaveLength(
      1,
    );
  });

  it("asks each account on a page once, and nothing of a quiet poll", async () => {
    const [a, b, someone] = [await user(), await user(), await user()];
    const repos = [
      ...(await directoryRepos(a, 2, "public")),
      ...(await directoryRepos(b, 1, "public")),
    ];
    for (const [i, repoId] of repos.entries())
      await deliverTo(someone.principalId, { repoId, version: i + 1 });
    const counted = { calls: 0 };
    const on = withAccounts(withFeedView(env), counted);
    const page = await listOn(on, someone.token);
    expect(page.body.items).toHaveLength(3);
    expect(counted.calls).toBe(2);
    counted.calls = 0;
    const quiet = await listOn(on, someone.token, `/feed?since=${page.body.next_cursor}`);
    expect(quiet.body.items).toEqual([]);
    expect(counted.calls).toBe(0);
  });
});

describe("the feed operations, a repository transferred while an answer reads it", () => {
  it("use nothing read under the new account, and stop before its items", async () => {
    const someone = await user();
    const made = await repoOf(someone);
    // More members than its check reads: the rest are read after it, by another call.
    await env.USER.getByName(someone.principalId).applyFeed(
      Array.from({ length: 105 }, (_, i) =>
        entry({
          repoId: made.id,
          thread: 10 + i,
          version: i + 1,
          member: `comment/${1000 + i}`,
          principal: someone.principalId,
        }),
      ),
    );
    viewCalls.delete(made.id);
    movedAfter.set(made.id, 1);
    // A sync reads them all (a list's page is within the first call's members).
    const res = await json<{
      items: { excerpt: string | null }[];
      complete: boolean;
      head_cursor: string;
    }>(feedApi("GET", "/feed/sync", someone.token));
    movedAfter.delete(made.id);
    expect(res.status).toBe(200);
    expect(viewCalls.get(made.id)?.length).toBeGreaterThan(1);
    expect(res.body.items.some((i) => i.excerpt === "after the move")).toBe(false);
    // Not known any more: the answer stops before its first item.
    expect(res.body.items).toEqual([]);
    expect(res.body.complete).toBe(false);
    // An incomplete sync follows from the feed's start.
    expect(await snapshotOf(someone.principalId, res.body.head_cursor)).toMatchObject({
      positions: [],
    });
    // Away and back meanwhile: the same account, another ownership.
    regeneratedAfter.set(made.id, 1);
    viewCalls.delete(made.id);
    const again = await json<{ items: { excerpt: string | null }[]; complete: boolean }>(
      feedApi("GET", "/feed/sync", someone.token),
    );
    regeneratedAfter.delete(made.id);
    expect(again.body.items).toEqual([]);
    expect(again.body.complete).toBe(false);
    // Moved before its first check: judged under another account than the one confirmed. The
    // cursors stay where the caller started, and it polls as after a quiet answer.
    movedAfter.set(made.id, 0);
    viewCalls.delete(made.id);
    const listed = await json<FeedOut>(feedApi("GET", "/feed", someone.token));
    movedAfter.delete(made.id);
    expect(listed.body.items).toEqual([]);
    expect(await snapshotOf(someone.principalId, listed.body.next_cursor)).toMatchObject({
      positions: [],
    });
    expect(listed.body.poll_after_ms).toBeGreaterThan(0);
    // Once it answers under one ownership again, everything shows.
    viewCalls.delete(made.id);
    expect(
      (await json<FeedOut>(feedApi("GET", "/feed?limit=100", someone.token))).body.items,
    ).toHaveLength(100);
  });
});

describe("the feed operations' checks of issue threads", () => {
  const issueItems = (repoId: string, principal: string, from: number, n: number) =>
    Array.from({ length: n }, (_, i) =>
      entry({ repoId, subject: "issue", thread: from + i, version: 1, principal }),
    );
  const sync = (token: string) =>
    json<{ items: { thread_key: string }[]; complete: boolean }>(
      feedApi("GET", "/feed/sync", token),
    );

  it("leave threads unchecked when a later check cannot say, and stop there", async () => {
    const someone = await user();
    const [repoId] = await directoryRepos(someone, 1);
    unsureThreads.add(repoId as string);
    await env.USER.getByName(someone.principalId).applyFeed(
      issueItems(repoId as string, someone.principalId, 1, 150),
    );
    const synced = await sync(someone.token);
    // The first hundred threads were checked with the repository; the rest could not be.
    expect(synced.body.items).toHaveLength(100);
    expect(synced.body.complete).toBe(false);
  });

  it("check threads beyond the budget of repository checks", async () => {
    const someone = await user();
    const others = await directoryRepos(someone, 99);
    const [crowded] = await directoryRepos(someone, 1);
    const feed = env.USER.getByName(someone.principalId);
    await feed.applyFeed(
      others.map((repoId) => entry({ repoId, version: 1, principal: someone.principalId })),
    );
    // Newest, so first in a sync: more issue threads of one repository than its check asks about.
    await feed.applyFeed(issueItems(crowded as string, someone.principalId, 1, 101));
    const synced = await sync(someone.token);
    expect(synced.body.items).toHaveLength(200);
    expect(synced.body.complete).toBe(true);
  });
});
