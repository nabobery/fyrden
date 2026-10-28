// Live notification hints: tickets, sockets admitted by the directory and
// confirmed by the feed's object, frames naming only streams the credential
// may read now, the send window, renewal and revocation (written by the
// directory's own triggers, swept to the feeds holding sockets resting on
// what was revoked).

import {
  createExecutionContext,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { D1TokenStore } from "@fyrden/adapters-cloudflare/auth";
import type { FeedEntry } from "@fyrden/domain";
import { hashToken, secureRandomBytes } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { RepoDO } from "../src/do/RepoDO.js";
import type { UserDO } from "../src/do/UserDO.js";
import { threadId } from "../src/do/user/inbox.js";
import { LIVE_ADMISSION, sweep } from "../src/live/directory.js";
import { SESSION_COOKIE } from "../src/oauth/session.js";
import { newId } from "../src/services.js";
import { agentFor } from "./helpers/agents.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { entry } from "./helpers/feed.js";
import { testSession } from "./helpers/oauth.js";
import { scopedToken } from "./helpers/principals.js";

afterEach(() => {
  vi.useRealTimers();
});

const ORIGIN = "https://fyrden.test";
const LIVE = { FYRDEN_LIVE: "on" };

/** One request through the Worker, with live hints on (or the given vars). */
async function call(request: Request, vars: Record<string, string> = LIVE): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await createApp().fetch(request, { ...env, ...vars } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const ticketFor = async (token: string, vars: Record<string, string> = LIVE) =>
  call(
    new Request(`${ORIGIN}/api/notifications/live`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": crypto.randomUUID() },
    }),
    vars,
  );

/** A socket opened with `token`'s ticket; its frames, and its close. */
async function open(token: string, vars: Record<string, string> = LIVE) {
  const issued = (await (await ticketFor(token, vars)).json()) as { ticket: string };
  const response = await call(
    new Request(`${ORIGIN}/api/notifications/live?ticket=${encodeURIComponent(issued.ticket)}`, {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` },
    }),
    vars,
  );
  const ws = response.webSocket;
  if (!ws)
    return {
      response,
      ws: null,
      frames: [],
      closed: Promise.resolve(null),
      next: async () => null,
    };
  ws.accept();
  const frames: unknown[] = [];
  const waiters: ((frame: unknown) => void)[] = [];
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as unknown;
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  });
  const closed = new Promise<{ code: number } | null>((resolve) =>
    ws.addEventListener("close", (event) => resolve({ code: event.code })),
  );
  /** The next frame (waiting on the event itself, never a timer). */
  const next = () =>
    frames.length > 0
      ? Promise.resolve(frames.shift())
      : new Promise<unknown>((resolve) => waiters.push(resolve));
  return { response, ws, frames, closed, next };
}

const feedOf = (who: Who) => env.USER.getByName(who.principalId);

/** A repository of `owner`'s with one issue; its id and the issue's conversation. */
async function repoWithIssue(owner: Who): Promise<{ id: string; conversation: string }> {
  const made = await json<{ id: string; name: string }>(
    api("POST", "/user/repos", owner.token, { name: uniqueId("live") }),
  );
  expect(
    (
      await api("POST", `/repos/${owner.handle}/${made.body.name}/issues`, owner.token, {
        title: "x",
      })
    ).status,
  ).toBe(201);
  const conversation = await runInDurableObject(
    env.REPO.getByName(made.body.id),
    (_: RepoDO, state) =>
      String(
        state.storage.sql
          .exec<{ c: string }>("SELECT conversation_id AS c FROM issues WHERE number = 1")
          .one().c,
      ),
  );
  return { id: made.body.id, conversation };
}

/** A change to `who`'s feed in issue 1 of `repo`, as the repository sends it. */
const change = (who: Who, repo: { id: string; conversation: string }, version: number): FeedEntry =>
  entry({
    version,
    thread: 1,
    subject: "issue",
    repoId: repo.id,
    principal: who.principalId,
    conversation: repo.conversation,
    kind: "mention",
    reasons: ["mentioned"],
    member: null,
    eventKey: `${repo.id}:${uniqueId("ev")}`,
  });

const revocationsOf = (subject: string) =>
  env.DIRECTORY.prepare("SELECT count(*) AS n FROM revocations WHERE subject = ?")
    .bind(subject)
    .first<{ n: number }>()
    .then((r) => r?.n ?? 0);

describe("revocations", () => {
  it("are written by the revoking statement itself, once, for what holds authority", async () => {
    const who = await user();
    const token = await scopedToken(who.principalId, []);
    const { id } = (await env.DIRECTORY.prepare(
      "SELECT id FROM tokens WHERE principal_id = ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(who.principalId)
      .first<{ id: string }>()) as { id: string };
    expect(token).toBeTruthy();
    await env.DIRECTORY.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ?").bind(1, id).run();
    // Again: nothing more.
    await env.DIRECTORY.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ?").bind(2, id).run();
    expect(await revocationsOf(`credential:${id}`)).toBe(1);
    const { gen } = (await env.DIRECTORY.prepare(
      "SELECT lifecycle_gen AS gen FROM principals WHERE id = ?",
    )
      .bind(who.principalId)
      .first<{ gen: number }>()) as { gen: number };
    await env.DIRECTORY.prepare(
      "UPDATE principals SET lifecycle = 'suspended', disabled_at = 5 WHERE id = ?",
    )
      .bind(who.principalId)
      .run();
    expect(await revocationsOf(`principal:${who.principalId}:${gen}`)).toBe(1);
  });
});

describe("a live socket", () => {
  it("is not offered while the deployment has not turned live hints on", async () => {
    const who = await user();
    expect((await ticketFor(who.token, {})).status).toBe(503);
  });

  it("is opened by an upgrade only: another request is answered 404, whether on or off", async () => {
    const who = await user();
    for (const vars of [{}, LIVE]) {
      const plain = await call(
        new Request(`${ORIGIN}/api/notifications/live?ticket=x`, {
          headers: { Authorization: `Bearer ${who.token}` },
        }),
        vars,
      );
      expect(plain.status).toBe(404);
    }
  });

  it("hears that a stream it may read changed, and nothing of one it may not", async () => {
    const owner = await user();
    const [mine, hidden] = [await repoWithIssue(owner), await repoWithIssue(owner)];
    // A token limited to one repository.
    const token = await scopedToken(owner.principalId, [], "pat", [mine.id]);
    const socket = await open(token);
    expect(socket.response.status).toBe(101);
    await feedOf(owner).applyFeed([change(owner, hidden, 1), change(owner, mine, 1)]);
    await runDurableObjectAlarm(feedOf(owner));
    expect(await socket.next()).toEqual({
      t: "changed",
      n: 1,
      streams: [{ repo: mine.id, kind: "issue" }],
    });
    // Only the hidden repository changes: no frame.
    await feedOf(owner).applyFeed([change(owner, hidden, 2)]);
    await runDurableObjectAlarm(feedOf(owner));
    expect(socket.frames).toEqual([]);
    socket.ws?.close(1000, "done");
  });

  it("is opened only with its ticket, once, by the credential it was issued to", async () => {
    const owner = await user();
    const other = await scopedToken(owner.principalId, []);
    const issued = (await (await ticketFor(owner.token)).json()) as { ticket: string };
    const upgrade = (token: string) =>
      call(
        new Request(
          `${ORIGIN}/api/notifications/live?ticket=${encodeURIComponent(issued.ticket)}`,
          {
            headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` },
          },
        ),
      );
    // Another credential of the same principal: refused, the ticket left unspent.
    expect((await upgrade(other)).status).toBe(401);
    const first = await upgrade(owner.token);
    expect(first.status).toBe(101);
    first.webSocket?.accept();
    expect((await upgrade(owner.token)).status).toBe(401);
    first.webSocket?.close(1000, "done");
  });

  it("closes when its credential is revoked, its lease released", async () => {
    const owner = await user();
    const token = await scopedToken(owner.principalId, []);
    const socket = await open(token);
    const { id } = (await env.DIRECTORY.prepare(
      "SELECT credential_id AS id FROM live_sockets WHERE feed = ?",
    )
      .bind(owner.principalId)
      .first<{ id: string }>()) as { id: string };
    await env.DIRECTORY.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ?")
      .bind(Date.now(), id)
      .run();
    await sweep(env.DIRECTORY, (feed, deps) => env.USER.getByName(feed).revoked(deps), Date.now());
    expect(await socket.closed).toEqual({ code: 4403 });
    expect(
      await env.DIRECTORY.prepare("SELECT count(*) AS n FROM live_sockets WHERE feed = ?")
        .bind(owner.principalId)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });

  it("closes on a control message past its bounds", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    socket.ws?.send("not json");
    expect(await socket.closed).toEqual({ code: 1008 });
    const again = await open(owner.token);
    again.ws?.send(JSON.stringify({ t: "ack", n: 1, extra: true }));
    expect(await again.closed).toEqual({ code: 1008 });
  });

  it("is refused past the deployment's allowance", async () => {
    const owner = await user();
    const vars = { ...LIVE, FYRDEN_LIVE_SOCKETS: "1" };
    // The allowance counts every open lease: with one already open (any test's), none more.
    await env.DIRECTORY.prepare(
      `INSERT INTO live_sockets (socket_id, ticket_id, feed, credential_id, state, pending_until,
         expires_at) VALUES (?, ?, 'usr_x', 'tok_x', 'open', 0, ?)`,
    )
      .bind(uniqueId("lsk"), uniqueId("t"), Date.now() + 60_000)
      .run();
    const refused = await open(owner.token, vars);
    expect(refused.response.status).toBe(503);
    expect(refused.response.headers.get("Retry-After")).toBe("60");
  });

  it("is admitted again after its principal is unsuspended, a delivery for the old authority aside", async () => {
    const owner = await user();
    const token = await scopedToken(owner.principalId, []);
    const { gen } = (await env.DIRECTORY.prepare(
      "SELECT lifecycle_gen AS gen FROM principals WHERE id = ?",
    )
      .bind(owner.principalId)
      .first<{ gen: number }>()) as { gen: number };
    // The old generation's authority revoked, told late.
    await feedOf(owner).revoked([`principal:${owner.principalId}:${gen}`]);
    await env.DIRECTORY.prepare(
      "UPDATE principals SET lifecycle_gen = lifecycle_gen + 1 WHERE id = ?",
    )
      .bind(owner.principalId)
      .run();
    const socket = await open(token);
    expect(socket.response.status).toBe(101);
    await feedOf(owner).revoked([`principal:${owner.principalId}:${gen}`]);
    expect(
      await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
        state.storage.sql.exec("SELECT count(*) AS n FROM live_local").one(),
      ),
    ).toEqual({ n: 1 });
    socket.ws?.close(1000, "done");
  });

  it("holds frames past its window, sends them coalesced once acknowledged, and closes a slow consumer", async () => {
    const owner = await user();
    const repo = await repoWithIssue(owner);
    const socket = await open(owner.token);
    const pump = async (version: number) => {
      await feedOf(owner).applyFeed([change(owner, repo, version)]);
      await runDurableObjectAlarm(feedOf(owner));
    };
    for (let v = 1; v <= 8; v++) {
      await pump(v);
      expect(await socket.next()).toMatchObject({ t: "changed", n: v });
    }
    // The ninth waits: eight are unacknowledged.
    await pump(9);
    expect(socket.frames).toEqual([]);
    socket.ws?.send(JSON.stringify({ t: "ack", n: 8 }));
    await pump(10);
    expect(await socket.next()).toEqual({
      t: "changed",
      n: 9,
      streams: [{ repo: repo.id, kind: "issue" }],
    });
    // Never acknowledged again: past the window for two minutes, closed to resynchronize.
    for (let v = 11; v <= 18; v++) await pump(v);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 3 * 60_000);
    await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
      state.storage.setAlarm(Date.now()),
    );
    await runDurableObjectAlarm(feedOf(owner));
    await runDurableObjectAlarm(feedOf(owner));
    expect(await socket.closed).toEqual({ code: 4409 });
  });

  it("is renewed in its second half, and closed once its credential no longer holds", async () => {
    const owner = await user();
    const token = await scopedToken(owner.principalId, []);
    const socket = await open(token);
    // Early: nothing.
    socket.ws?.send(JSON.stringify({ t: "renew" }));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 6 * 60_000);
    socket.ws?.send(JSON.stringify({ t: "renew" }));
    expect(await socket.next()).toMatchObject({ t: "renewed" });
    await env.DIRECTORY.prepare(
      "UPDATE tokens SET revoked_at = ? WHERE id = (SELECT credential_id FROM live_sockets WHERE feed = ?)",
    )
      .bind(Date.now(), owner.principalId)
      .run();
    vi.setSystemTime(Date.now() + 6 * 60_000);
    socket.ws?.send(JSON.stringify({ t: "renew" }));
    expect(await socket.closed).toEqual({ code: 4401 });
  });

  it("says nothing of activity the principal ignored or unsubscribed from after it changed, but for what asks something of it", async () => {
    const owner = await user();
    const repo = await repoWithIssue(owner);
    const socket = await open(owner.token);
    const comment = {
      ...change(owner, repo, 1),
      recipient: {
        ...change(owner, repo, 1).recipient,
        kind: "activity" as const,
        reasons: ["commenter"],
      },
    };
    await feedOf(owner).applyFeed([comment]);
    await env.DIRECTORY.prepare(
      `INSERT INTO thread_preferences (principal_id, repo_id, conversation, number, kind, root_id,
         state, revision, epoch_gen, at) VALUES (?1, ?2, ?3, 1, 'issue', ?1, 'unsubscribed', 1, 1, ?4)`,
    )
      .bind(owner.principalId, repo.id, repo.conversation, Date.now())
      .run();
    await runDurableObjectAlarm(feedOf(owner));
    expect(socket.frames).toEqual([]);
    // A mention goes through an unsubscribe.
    await feedOf(owner).applyFeed([change(owner, repo, 2)]);
    await runDurableObjectAlarm(feedOf(owner));
    expect(await socket.next()).toMatchObject({ t: "changed", n: 1 });
    // An ignored repository: nothing at all.
    await env.DIRECTORY.prepare(
      `INSERT INTO watch_preferences (principal_id, repo_id, root_id, level, revision, epoch_gen, at)
       VALUES (?1, ?2, ?1, 'ignoring', 1, 1, ?3)`,
    )
      .bind(owner.principalId, repo.id, Date.now())
      .run();
    await feedOf(owner).applyFeed([change(owner, repo, 3)]);
    await runDurableObjectAlarm(feedOf(owner));
    expect(socket.frames).toEqual([]);
    socket.ws?.close(1000, "done");
  });

  it("tells other sockets of the principal's own read, and closes all with the feed's retirement", async () => {
    const owner = await user();
    const repo = await repoWithIssue(owner);
    const socket = await open(owner.token);
    await feedOf(owner).applyFeed([change(owner, repo, 1)]);
    await runDurableObjectAlarm(feedOf(owner));
    expect(await socket.next()).toMatchObject({ n: 1 });
    expect(await feedOf(owner).markInboxThread(threadId(repo.id, repo.conversation), false)).toBe(
      true,
    );
    await runDurableObjectAlarm(feedOf(owner));
    expect(await socket.next()).toMatchObject({
      n: 2,
      streams: [{ repo: repo.id, kind: "issue" }],
    });
    await feedOf(owner).retire();
    expect(await socket.closed).toEqual({ code: 4403 });
  });

  it("opens from a browser only with its session's cookie, from this origin", async () => {
    const owner = await user();
    const { cookie } = await testSession(owner.principalId);
    const headers = { Cookie: `${SESSION_COOKIE}=${cookie}`, "X-Fyrden-Session": "1" };
    const ticket = async () =>
      (
        (await (
          await call(
            new Request(`${ORIGIN}/api/notifications/live`, {
              method: "POST",
              headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
            }),
          )
        ).json()) as { ticket: string }
      ).ticket;
    const upgrade = (t: string, origin: string) =>
      call(
        new Request(`${ORIGIN}/api/notifications/live?ticket=${encodeURIComponent(t)}`, {
          headers: { Upgrade: "websocket", Cookie: headers.Cookie, Origin: origin },
        }),
      );
    const first = await ticket();
    expect((await upgrade(first, "https://evil.test")).status).toBe(401);
    // Refused before it was spent.
    const opened = await upgrade(first, ORIGIN);
    expect(opened.status).toBe(101);
    opened.webSocket?.accept();
    opened.webSocket?.close(1000, "done");
  });
});

describe("a live socket's authority", () => {
  const sweepNow = () =>
    sweep(env.DIRECTORY, (feed, deps) => env.USER.getByName(feed).revoked(deps), Date.now());

  it("is checked again by every run that would send to it, whatever the sweep has done", async () => {
    const owner = await user();
    const repo = await repoWithIssue(owner);
    const token = await scopedToken(owner.principalId, []);
    const socket = await open(token);
    await env.DIRECTORY.prepare("UPDATE tokens SET revoked_at = ? WHERE token_hash = ?")
      .bind(Date.now(), await hashToken(token))
      .run();
    // No sweep yet: the change finds the credential gone, and sends nothing.
    await feedOf(owner).applyFeed([change(owner, repo, 1)]);
    await runDurableObjectAlarm(feedOf(owner));
    expect(await socket.closed).toEqual({ code: 4401 });
    expect(socket.frames).toEqual([]);
  });

  it("closes, after an unsuspension, only the sockets of the ended generation, by a run or a renewal", async () => {
    const owner = await user();
    const repo = await repoWithIssue(owner);
    const token = await scopedToken(owner.principalId, []);
    const old = await open(token);
    // Suspended and unsuspended before any sweep: a new generation.
    await env.DIRECTORY.prepare(
      "UPDATE principals SET lifecycle = 'suspended', disabled_at = ? WHERE id = ?",
    )
      .bind(Date.now(), owner.principalId)
      .run();
    await env.DIRECTORY.prepare(
      `UPDATE principals SET lifecycle = 'active', disabled_at = NULL,
         lifecycle_gen = lifecycle_gen + 1 WHERE id = ?`,
    )
      .bind(owner.principalId)
      .run();
    const fresh = await open(token);
    expect(fresh.response.status).toBe(101);
    await feedOf(owner).applyFeed([change(owner, repo, 1)]);
    await runDurableObjectAlarm(feedOf(owner));
    expect(await old.closed).toEqual({ code: 4401 });
    expect(await fresh.next()).toMatchObject({ t: "changed", n: 1 });
    // A renewal of another ended-generation socket is refused as well.
    const stale = await open(token);
    await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
      state.storage.sql.exec(
        "UPDATE live_local_deps SET dependency = ? WHERE dependency LIKE 'principal:%' AND socket_id = (SELECT max(socket_id) FROM live_local)",
        `principal:${owner.principalId}:0`,
      ),
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 6 * 60_000);
    stale.ws?.send(JSON.stringify({ t: "renew" }));
    expect(await stale.closed).toEqual({ code: 4401 });
    fresh.ws?.close(1000, "done");
  });

  it("rests on an agent's owner: suspending the owner closes the agent's socket", async () => {
    const owner = await user();
    const agent = await agentFor(owner, ["issues:read"]);
    const socket = await open(agent.own);
    expect(socket.response.status).toBe(101);
    await env.DIRECTORY.prepare(
      "UPDATE principals SET lifecycle = 'suspended', disabled_at = ? WHERE id = ?",
    )
      .bind(Date.now(), owner.principalId)
      .run();
    await sweepNow();
    expect(await socket.closed).toEqual({ code: 4403 });
  });

  it("rests on the token it was minted from", async () => {
    const owner = await user();
    const store = new D1TokenStore(env.DIRECTORY, {
      clock: () => Date.now(),
      newId,
      randomBytes: secureRandomBytes,
    });
    const audit = { actorId: owner.principalId, requestId: null } as never;
    const source = await store.mint({
      type: "pat",
      principalId: owner.principalId,
      scopes: [],
      ttlMs: 3_600_000,
      audit,
    });
    const minted = await store.mint({
      type: "pat",
      principalId: owner.principalId,
      scopes: [],
      ttlMs: 3_600_000,
      sourceId: source.id,
      audit,
    });
    const socket = await open(minted.token);
    expect(socket.response.status).toBe(101);
    await env.DIRECTORY.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ?")
      .bind(Date.now(), source.id)
      .run();
    await sweepNow();
    expect(await socket.closed).toEqual({ code: 4403 });
  });

  it("is not opened by a delegated or a DPoP-bound token", async () => {
    const owner = await user();
    const agent = await agentFor(owner, ["issues:read"]);
    expect((await ticketFor(agent.delegated)).status).toBe(403);
    const bound = await scopedToken(owner.principalId, []);
    await env.DIRECTORY.prepare("UPDATE tokens SET dpop_jkt = 'thumbprint' WHERE token_hash = ?")
      .bind(await hashToken(bound))
      .run();
    expect((await ticketFor(bound)).status).toBe(401);
  });

  it("is opened from a browser only with the very session its ticket was issued to", async () => {
    const owner = await user();
    const [mine, other] = [
      await testSession(owner.principalId),
      await testSession(owner.principalId),
    ];
    const issued = (await (
      await call(
        new Request(`${ORIGIN}/api/notifications/live`, {
          method: "POST",
          headers: {
            Cookie: `${SESSION_COOKIE}=${mine.cookie}`,
            "X-Fyrden-Session": "1",
            "Idempotency-Key": crypto.randomUUID(),
          },
        }),
      )
    ).json()) as { ticket: string };
    const upgrade = (cookie: string) =>
      call(
        new Request(
          `${ORIGIN}/api/notifications/live?ticket=${encodeURIComponent(issued.ticket)}`,
          {
            headers: {
              Upgrade: "websocket",
              Cookie: `${SESSION_COOKIE}=${cookie}`,
              Origin: ORIGIN,
            },
          },
        ),
      );
    expect((await upgrade(other.cookie)).status).toBe(401);
    const opened = await upgrade(mine.cookie);
    expect(opened.status).toBe(101);
    opened.webSocket?.accept();
    opened.webSocket?.close(1000, "done");
  });
});

describe("a live socket's protocol", () => {
  it("is closed by a renewal once its deadline passed, and by a control that is not an object", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    socket.ws?.send("null");
    expect(await socket.closed).toEqual({ code: 1008 });
    const late = await open(owner.token);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    late.ws?.send(JSON.stringify({ t: "renew" }));
    expect(await late.closed).toEqual({ code: 4401 });
  });

  it("forgets an admission whose confirmation never finished", async () => {
    const owner = await user();
    await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO live_local (socket_id, credential_id, phase, expires_at, deadline, sent, acked,
           refresh_pending, blocked_since, renew_failures, controls_used, minute_start,
           minute_count, delivered_seq, retry_at, scopes, repo_ids)
         VALUES ('lsk_stale', 'tok_x', 'confirming', ?1, ?1, 0, 0, 0, NULL, 0, 0, ?2, 0, 0, 0, '[]', NULL)`,
        Date.now() + 60 * 60_000,
        Date.now() - 2 * 60_000,
      );
      state.storage.sql.exec(
        "INSERT INTO user_schedule (kind, due_at) VALUES ('live', 0) ON CONFLICT (kind) DO UPDATE SET due_at = 0",
      );
      return state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(feedOf(owner));
    expect(
      await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
        state.storage.sql.exec("SELECT count(*) AS n FROM live_local").one(),
      ),
    ).toEqual({ n: 0 });
  });

  it("owes a slower socket the mention it has not heard of, though a later comment was unsubscribed", async () => {
    const owner = await user();
    const repo = await repoWithIssue(owner);
    const [fast, slow] = [
      await open(owner.token),
      await open(await scopedToken(owner.principalId, [])),
    ];
    const apply = async (e: FeedEntry) => {
      await feedOf(owner).applyFeed([e]);
      await runDurableObjectAlarm(feedOf(owner));
    };
    // The slow socket's window fills; the fast one acknowledges as it goes.
    for (let v = 1; v <= 8; v++) {
      await apply(change(owner, repo, v));
      const frame = (await fast.next()) as { n: number };
      fast.ws?.send(JSON.stringify({ t: "ack", n: frame.n }));
      await slow.next();
    }
    // A mention: the fast socket hears of it; the slow one is full.
    await apply(change(owner, repo, 9));
    const heard = (await fast.next()) as { n: number };
    fast.ws?.send(JSON.stringify({ t: "ack", n: heard.n }));
    // Then a comment in the same conversation, unsubscribed before the next run.
    const comment = change(owner, repo, 10);
    await feedOf(owner).applyFeed([
      { ...comment, recipient: { ...comment.recipient, kind: "activity", reasons: ["commenter"] } },
    ]);
    await env.DIRECTORY.prepare(
      `INSERT INTO thread_preferences (principal_id, repo_id, conversation, number, kind, root_id,
         state, revision, epoch_gen, at) VALUES (?1, ?2, ?3, 1, 'issue', ?1, 'unsubscribed', 1, 1, ?4)`,
    )
      .bind(owner.principalId, repo.id, repo.conversation, Date.now())
      .run();
    slow.ws?.send(JSON.stringify({ t: "ack", n: 8 }));
    await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
      state.storage.setAlarm(Date.now()),
    );
    await runDurableObjectAlarm(feedOf(owner));
    expect(await slow.next()).toMatchObject({ t: "changed", n: 9 });
    expect(fast.frames).toEqual([]);
  });
});

describe("the revocation sweep", () => {
  it("tells every feed in turn, failing ones behind the others", async () => {
    const seq = (
      await env.DIRECTORY.prepare(
        "INSERT INTO revocations (subject, at, expanded) VALUES (?, ?, 1) RETURNING seq",
      )
        .bind(`credential:${uniqueId("tok")}`, Date.now())
        .first<{ seq: number }>()
    )?.seq as number;
    const feeds = Array.from(
      { length: LIVE_ADMISSION.deliveries + 1 },
      (_, i) => `usr_f${String(i).padStart(3, "0")}`,
    );
    const now = Date.now();
    await env.DIRECTORY.batch(
      feeds.map((feed, i) =>
        env.DIRECTORY.prepare(
          "INSERT INTO revocation_targets (seq, feed, attempts, next_attempt_at) VALUES (?, ?, 0, ?)",
        ).bind(seq, feed, now - 1_000_000 + i),
      ),
    );
    const told: string[] = [];
    const failing = new Set(feeds.slice(0, LIVE_ADMISSION.deliveries));
    const tell = async (feed: string) => {
      if (!feed.startsWith("usr_f")) return;
      told.push(feed);
      if (failing.has(feed)) throw new Error("down");
    };
    await sweep(env.DIRECTORY, tell, now);
    // The first run tried the 200 due first; the next takes the 201st before any retried one.
    told.length = 0;
    await sweep(env.DIRECTORY, tell, now + 1);
    expect(told[0]).toBe(feeds.at(-1));
    expect(
      await env.DIRECTORY.prepare(
        "SELECT count(*) AS n FROM revocation_targets WHERE seq = ? AND feed = ?",
      )
        .bind(seq, feeds.at(-1))
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });
});
