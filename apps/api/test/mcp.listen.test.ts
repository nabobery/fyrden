// MCP feed push: the feed as a resource (`fyrden://feed/{principal}`), and
// `subscriptions/listen` streams (MCP 2026-07-28) bridged to a live socket
// of the feed's object: acknowledged once the socket holds, a hint per
// change the credential may read, the live sockets' credential binding and
// caps, cancellation closing the socket, and the stream ended when the
// socket closes.

import { createExecutionContext, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { FeedEntry } from "@fyrden/domain";
import { hashToken } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { RepoDO } from "../src/do/RepoDO.js";
import type { UserDO } from "../src/do/UserDO.js";
import { LIVE_POLICY } from "../src/do/user/live.js";
import { sweep } from "../src/live/directory.js";
import { agentFor } from "./helpers/agents.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { dpopKey } from "./helpers/dpop.js";
import { entry } from "./helpers/feed.js";
import { scopedToken } from "./helpers/principals.js";

afterEach(() => {
  vi.useRealTimers();
});

const MCP = "https://fyrden.test/mcp";
const LIVE = { FYRDEN_LIVE: "on" };
const feedUri = (who: { principalId: string }) => `fyrden://feed/${who.principalId}`;

/** One request through the Worker (its response may stream on after it returns). */
async function call(request: Request, vars: Record<string, string> = LIVE): Promise<Response> {
  return await createApp().fetch(request, { ...env, ...vars } as Env, createExecutionContext());
}

const envelope = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "fyrden-test", version: "0.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

/** A 2026-07-28 request: its own envelope, its standard headers. */
function rpc(
  method: string,
  params: Record<string, unknown>,
  auth: Record<string, string>,
  signal?: AbortSignal,
  change: { headers?: Record<string, string | null>; body?: unknown } = {},
): Request {
  const headers: Record<string, string | null> = {
    ...auth,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": method,
    ...(typeof params.uri === "string" && { "Mcp-Name": params.uri }),
    ...change.headers,
  };
  return new Request(MCP, {
    method: "POST",
    headers: Object.fromEntries(
      Object.entries(headers).filter((e): e is [string, string] => e[1] !== null),
    ),
    body: JSON.stringify(
      "body" in change
        ? change.body
        : { jsonrpc: "2.0", id: "listen-1", method, params: { ...params, _meta: envelope } },
    ),
    ...(signal && { signal }),
  });
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

type Message = {
  method?: string;
  id?: unknown;
  params?: Record<string, unknown> & { _meta?: Record<string, unknown> };
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: Record<string, unknown> };
};

/** A response's JSON-RPC messages as they arrive (SSE `data:` events; comments skipped). */
function messages(response: Response) {
  // A plain JSON answer is one message.
  if (response.headers.get("Content-Type")?.includes("application/json")) {
    let answer: Promise<Message> | null = response.json() as Promise<Message>;
    return {
      next: async () => {
        const message = answer;
        answer = null;
        return message ? await message : null;
      },
      cancel: async () => {},
    };
  }
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  /** The next message, or null once the stream ended (waiting on the stream, never a timer). */
  async function next(): Promise<Message | null> {
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end >= 0) {
        const event = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = event
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        if (data) return JSON.parse(data) as Message;
        continue;
      }
      if (done) return null;
      const chunk = await reader.read();
      if (chunk.done) done = true;
      else buffer += decoder.decode(chunk.value, { stream: true });
    }
  }
  return { next, cancel: () => reader.cancel() };
}

/** A listen stream of `token`'s for `uris`. */
async function listen(
  uris: string[],
  auth: Record<string, string>,
  vars: Record<string, string> = LIVE,
) {
  const abort = new AbortController();
  const response = await call(
    rpc(
      "subscriptions/listen",
      { notifications: { resourceSubscriptions: uris } },
      auth,
      abort.signal,
    ),
    vars,
  );
  return { response, abort, ...messages(response) };
}

const feedOf = (who: Who) => env.USER.getByName(who.principalId);

const socketsOf = async (who: Who) => ({
  leases: (
    (await env.DIRECTORY.prepare("SELECT count(*) AS n FROM live_sockets WHERE feed = ?")
      .bind(who.principalId)
      .first<{ n: number }>()) as { n: number }
  ).n,
  local: await runInDurableObject(
    feedOf(who),
    (_: UserDO, state) =>
      state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM live_local").one().n,
  ),
});

/**
 * The feed's sockets once its object has handled a close: each round trip to the object runs
 * after events it already received (a bounded number of them, no timer).
 */
async function released(who: Who) {
  for (let i = 0; i < 100; i++) {
    const now = await socketsOf(who);
    if (now.leases === 0 && now.local === 0) return now;
    await runInDurableObject(feedOf(who), () => {});
  }
  return socketsOf(who);
}

/** A repository of `owner`'s with one issue; its id and the issue's conversation. */
async function repoWithIssue(owner: Who): Promise<{ id: string; conversation: string }> {
  const made = await json<{ id: string; name: string }>(
    api("POST", "/user/repos", owner.token, { name: uniqueId("listen") }),
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

/** Applies a change and runs the feed's alarm (its pump). */
async function pump(who: Who, repo: { id: string; conversation: string }, version: number) {
  await feedOf(who).applyFeed([change(who, repo, version)]);
  await runDurableObjectAlarm(feedOf(who));
}

const updated = (who: Who) => ({
  method: "notifications/resources/updated",
  params: {
    uri: feedUri(who),
    _meta: { "io.modelcontextprotocol/subscriptionId": "listen-1" },
  },
});

const graceful = (message: Message | null) =>
  expect(message).toMatchObject({
    id: "listen-1",
    result: { _meta: { "io.modelcontextprotocol/subscriptionId": "listen-1" } },
  });

describe("the feed resource", () => {
  it("is offered for subscription only on 2026-07-28 and only while live hints are on", async () => {
    const who = await user();
    const discover = async (vars: Record<string, string>) => {
      const res = await call(rpc("server/discover", {}, bearer(who.token)), vars);
      const text = await res.text();
      const data = text.startsWith("{")
        ? text
        : (text
            .split("\n")
            .find((l) => l.startsWith("data: "))
            ?.slice(6) ?? "");
      return (
        JSON.parse(data) as { result: { capabilities: { resources?: { subscribe?: boolean } } } }
      ).result.capabilities.resources;
    };
    expect(await discover(LIVE)).toMatchObject({ subscribe: true });
    expect((await discover({}))?.subscribe ?? false).toBe(false);
  });

  it("lists the caller's own feed, and reads as a sync of it", async () => {
    const owner = await user();
    const repo = await repoWithIssue(owner);
    await feedOf(owner).applyFeed([change(owner, repo, 1)]);
    const listed = (await (
      await messages(await call(rpc("resources/list", {}, bearer(owner.token)))).next()
    )?.result) as { resources: { uri: string }[] };
    expect(listed.resources.map((r) => r.uri)).toContain(feedUri(owner));
    const read = await messages(
      await call(rpc("resources/read", { uri: feedUri(owner) }, bearer(owner.token))),
    ).next();
    const contents =
      (read?.result as { contents: { uri: string; mimeType: string; text: string }[] } | undefined)
        ?.contents ?? [];
    expect(contents[0]).toMatchObject({ uri: feedUri(owner), mimeType: "application/json" });
    const sync = JSON.parse(contents[0]?.text ?? "{}") as { items: unknown[]; head_cursor: string };
    expect(sync.items).toHaveLength(1);
    expect(sync.head_cursor).toBeTruthy();
  });

  it("is not read for another principal: the same answer as a missing resource", async () => {
    const [owner, other] = [await user(), await user()];
    for (const uri of [feedUri(other), "fyrden://feed/usr_missing"]) {
      const read = await messages(
        await call(rpc("resources/read", { uri }, bearer(owner.token))),
      ).next();
      expect(read?.error?.code).toBe(-32602);
      expect(JSON.stringify(read)).not.toContain(other.handle);
    }
  });
});

describe("a listen stream", () => {
  it("is acknowledged once its socket holds, then hints at each change the credential may read", async () => {
    const owner = await user();
    const [mine, hidden] = [await repoWithIssue(owner), await repoWithIssue(owner)];
    const token = await scopedToken(owner.principalId, [], "pat", [mine.id]);
    const stream = await listen([feedUri(owner)], bearer(token));
    expect(stream.response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(await stream.next()).toEqual({
      jsonrpc: "2.0",
      method: "notifications/subscriptions/acknowledged",
      params: {
        notifications: { resourceSubscriptions: [feedUri(owner)] },
        _meta: { "io.modelcontextprotocol/subscriptionId": "listen-1" },
      },
    });
    // The socket was there before the acknowledgement: a change right after it is heard.
    expect(await socketsOf(owner)).toEqual({ leases: 1, local: 1 });
    await pump(owner, hidden, 1);
    await pump(owner, mine, 1);
    expect(await stream.next()).toMatchObject(updated(owner));
    stream.abort.abort();
  });

  it("honours only the caller's own feed: nothing else is acknowledged, and nothing is opened for it", async () => {
    const [owner, other] = [await user(), await user()];
    const stream = await listen(
      [feedUri(other), "fyrden://repos/a/b/files/README.md", feedUri(owner), feedUri(owner)],
      bearer(owner.token),
    );
    expect(await stream.next()).toMatchObject({
      method: "notifications/subscriptions/acknowledged",
      params: { notifications: { resourceSubscriptions: [feedUri(owner)] } },
    });
    stream.abort.abort();
    const none = await listen([feedUri(other)], bearer(owner.token));
    expect(await none.next()).toMatchObject({
      method: "notifications/subscriptions/acknowledged",
      params: { notifications: {} },
    });
    graceful(await none.next());
    expect(await none.next()).toBeNull();
    expect((await socketsOf(other)).leases).toBe(0);
  });

  it("serves nothing while live hints are off", async () => {
    const owner = await user();
    const stream = await listen([feedUri(owner)], bearer(owner.token), {});
    expect(await stream.next()).toMatchObject({ params: { notifications: {} } });
    graceful(await stream.next());
    expect(await socketsOf(owner)).toEqual({ leases: 0, local: 0 });
  });

  it("closes its socket when the client cancels it, the lease released", async () => {
    const owner = await user();
    const stream = await listen([feedUri(owner)], bearer(owner.token));
    await stream.next();
    expect((await socketsOf(owner)).leases).toBe(1);
    await stream.cancel();
    // The object hears the close; its lease goes with it.
    expect(await released(owner)).toEqual({ leases: 0, local: 0 });
  });

  it("shares the live sockets' caps: a credential's sixth is refused, nothing admitted for it", async () => {
    const owner = await user();
    const streams = [];
    for (let i = 0; i < LIVE_POLICY.perCredential; i++) {
      const stream = await listen([feedUri(owner)], bearer(owner.token));
      expect(await stream.next()).toMatchObject({
        method: "notifications/subscriptions/acknowledged",
      });
      streams.push(stream);
    }
    const sixth = await listen([feedUri(owner)], bearer(owner.token));
    expect(await sixth.next()).toMatchObject({
      id: "listen-1",
      error: { data: { status: 429, code: "too_many_sockets" } },
    });
    expect((await socketsOf(owner)).leases).toBe(LIVE_POLICY.perCredential);
    for (const stream of streams) stream.abort.abort();
  });

  it("is refused to a delegated or a DPoP-bound token, as live sockets are", async () => {
    const owner = await user();
    const agent = await agentFor(owner, ["issues:read"], undefined, MCP);
    const delegated = await listen([feedUri(owner)], bearer(agent.delegated));
    expect(await delegated.next()).toMatchObject({ error: { data: { status: 403 } } });
    const key = await dpopKey();
    const bound = await scopedToken(owner.principalId, []);
    await env.DIRECTORY.prepare("UPDATE tokens SET dpop_jkt = ? WHERE token_hash = ?")
      .bind(key.jkt, await hashToken(bound))
      .run();
    const proven = await listen([feedUri(owner)], {
      Authorization: `DPoP ${bound}`,
      DPoP: await key.proof("POST", MCP, bound),
    });
    expect(await proven.next()).toMatchObject({ error: { data: { status: 401 } } });
    expect(await socketsOf(owner)).toEqual({ leases: 0, local: 0 });
  });

  it("ends when its credential is revoked: the socket closed, the lease released", async () => {
    const owner = await user();
    const token = await scopedToken(owner.principalId, []);
    const stream = await listen([feedUri(owner)], bearer(token));
    await stream.next();
    await env.DIRECTORY.prepare("UPDATE tokens SET revoked_at = ? WHERE token_hash = ?")
      .bind(Date.now(), await hashToken(token))
      .run();
    await sweep(env.DIRECTORY, (feed, deps) => env.USER.getByName(feed).revoked(deps), Date.now());
    graceful(await stream.next());
    expect(await stream.next()).toBeNull();
    expect((await socketsOf(owner)).leases).toBe(0);
  });

  it("acknowledges only what its reader took: one that stops reading ends after the slow-consumer deadline", async () => {
    const owner = await user();
    const repo = await repoWithIssue(owner);
    const stream = await listen([feedUri(owner)], bearer(owner.token));
    await stream.next();
    // Read as they come: acknowledged, so more than a window's worth arrives.
    for (let v = 1; v <= LIVE_POLICY.window + 4; v++) {
      await pump(owner, repo, v);
      expect(await stream.next()).toMatchObject(updated(owner));
    }
    // No longer read: the socket's window fills, its frames held by the object, not the Worker.
    for (let v = 20; v < 40; v++) await pump(owner, repo, v);
    const held = await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
      state.storage.sql
        .exec<{ sent: number; acked: number }>("SELECT sent, acked FROM live_local")
        .one(),
    );
    expect(held.sent - held.acked).toBe(LIVE_POLICY.window);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + LIVE_POLICY.slowMs + 60_000);
    await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
      state.storage.setAlarm(Date.now()),
    );
    await runDurableObjectAlarm(feedOf(owner));
    await runDurableObjectAlarm(feedOf(owner));
    // What the Worker held for it (one hint: the frames it heard fold together), then the
    // graceful end, then nothing.
    expect(await stream.next()).toMatchObject(updated(owner));
    graceful(await stream.next());
    expect(await stream.next()).toBeNull();
    expect((await socketsOf(owner)).leases).toBe(0);
  });

  it("can be opened again after it ended, and the feed read from there", async () => {
    const owner = await user();
    const repo = await repoWithIssue(owner);
    const first = await listen([feedUri(owner)], bearer(owner.token));
    await first.next();
    await first.cancel();
    expect(await released(owner)).toEqual({ leases: 0, local: 0 });
    const again = await listen([feedUri(owner)], bearer(owner.token));
    expect(await again.next()).toMatchObject({
      method: "notifications/subscriptions/acknowledged",
    });
    await pump(owner, repo, 1);
    expect(await again.next()).toMatchObject(updated(owner));
    again.abort.abort();
  });

  it("opens nothing for a request it does not serve as a stream", async () => {
    const owner = await user();
    const listenOf = (change: Parameters<typeof rpc>[4]) =>
      call(
        rpc(
          "subscriptions/listen",
          { notifications: { resourceSubscriptions: [feedUri(owner)] } },
          bearer(owner.token),
          undefined,
          change,
        ),
      );
    const own = { resourceSubscriptions: [feedUri(owner)] };
    const answers = [
      // A 2025-era request (no envelope): those revisions have no listen.
      await listenOf({
        headers: { "MCP-Protocol-Version": null, "Mcp-Method": null },
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "subscriptions/listen",
          params: { notifications: own },
        },
      }),
      // An invalid filter, though narrowing it would have made it valid.
      await listenOf({
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "subscriptions/listen",
          params: {
            notifications: { resourceSubscriptions: [feedUri(owner), 42] },
            _meta: envelope,
          },
        },
      }),
      // A required header missing.
      await listenOf({ headers: { "Mcp-Method": null } }),
      // A batch.
      await listenOf({
        body: [
          {
            jsonrpc: "2.0",
            id: 1,
            method: "subscriptions/listen",
            params: { notifications: own, _meta: envelope },
          },
        ],
      }),
    ];
    for (const answer of answers) {
      const text = await answer.text();
      expect(text).not.toContain("notifications/subscriptions/acknowledged");
      expect(text).toContain('"error"');
    }
    // An id too long to stamp on every message, counted in bytes; the refusal names it.
    for (const id of ["x".repeat(300), "\u6f22".repeat(100)]) {
      const long = await listenOf({
        body: {
          jsonrpc: "2.0",
          id,
          method: "subscriptions/listen",
          params: { notifications: own, _meta: envelope },
        },
      });
      expect(await long.json()).toMatchObject({
        id,
        error: { code: 400, data: { code: "listen_id_too_long" } },
      });
    }
    expect(await socketsOf(owner)).toEqual({ leases: 0, local: 0 });
  });
});
