// Repository webhooks: hooks managed by administrators, their secrets made
// by the server and shown once, events routed to them at their
// configuration versions, deliveries made from events (row, body, message),
// and each attempt signed as Standard Webhooks says, posted through the SSRF
// guard and recorded, retried, failed or cancelled as its answer says.
import { env } from "cloudflare:workers";
import { type DomainEvent, eventKey } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { effectStatements } from "../src/effects/journal.js";
import { applyEnvelope } from "../src/queues/events-consumer.js";
import { ATTEMPT_POLICY, attemptDelivery, reconcileWebhooks } from "../src/webhooks/deliver.js";
import { webhookEventOf } from "../src/webhooks/events.js";
import { openSecret, secretKeys, signature } from "../src/webhooks/secrets.js";
import { bodyOf, deliveryIdOf, webhookSink } from "../src/webhooks/sink.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

type HookOut = {
  id: number;
  active: boolean;
  events: string[];
  config: { url: string };
  secret?: string;
  last_response: { code: number | null; status: string };
  disabled_reason: string | null;
  secrets: number;
  code?: string;
};

const RECEIVER = "https://93.184.216.34/hook";

let owner: Who;
let repo: { id: string; name: string };
let path: string;

const stub = () => env.REPO.getByName(repo.id);
const createHook = (body: Record<string, unknown> = {}, who: Who = owner) =>
  json<HookOut>(api("POST", `${path}/hooks`, who.token, { config: { url: RECEIVER }, ...body }));
/** The outbox's events, newest last. */
const outbox = () =>
  inRepo(stub(), (r: RepoDO) =>
    r.git.context.storage.sql
      .exec<{ event: string }>("SELECT event FROM outbox ORDER BY source_seq")
      .toArray()
      .map((row) => JSON.parse(row.event) as DomainEvent),
  );
/** Sent messages, instead of the queue. */
let sent: { delivery: string; delaySeconds?: number }[];
const testEnv = () =>
  ({
    ...env,
    WEBHOOKS: {
      send: async (body: { delivery: string }, options?: { delaySeconds?: number }) => {
        sent.push({
          ...body,
          ...(options?.delaySeconds !== undefined && { delaySeconds: options.delaySeconds }),
        });
      },
      sendBatch: async (messages: { body: { delivery: string } }[]) => {
        for (const m of messages) sent.push(m.body);
      },
    },
  }) as unknown as Env;
/** Makes the deliveries the outbox's events call for (as the events consumer would). */
async function materialize(events: DomainEvent[]) {
  await applyEnvelope(testEnv(), { sourceId: repo.id, events }, { sinks: [webhookSink] });
}
const deliveries = async () =>
  (
    await env.ORG_READ.prepare(
      `SELECT delivery_id, hook_id, event, state, reason, attempts, last_status, private
       FROM webhook_deliveries WHERE repo_id = ? ORDER BY created_at, delivery_id`,
    )
      .bind(repo.id)
      .all<{
        delivery_id: string;
        hook_id: number;
        event: string;
        state: string;
        reason: string | null;
        attempts: number;
        last_status: number | null;
        private: number;
      }>()
  ).results;

/** Requests the receiver got. */
let received: { url: string; headers: Headers; body: string }[];
let answer: () => Response;
const deps = (now = Date.now()) => ({
  env: testEnv(),
  db: env.ORG_READ,
  now: () => now,
  resolver: () => async () => ["93.184.216.34"],
});

beforeEach(async () => {
  sent = [];
  received = [];
  answer = () => new Response("ok", { status: 200 });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    received.push({ url: request.url, headers: request.headers, body: await request.text() });
    return answer();
  });
  owner = await user();
  repo = (
    await json<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    )
  ).body;
  path = `/repos/${owner.handle}/${repo.name}`;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("webhooks", () => {
  it("are made by administrators with a secret shown once, and refuse unsafe URLs", async () => {
    const made = await createHook({ events: ["push", "pull_request"] });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      active: true,
      events: ["pull_request", "push"],
      config: { url: RECEIVER },
      last_response: { code: null, status: "unused" },
      secrets: 1,
    });
    expect(made.body.secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    const listed = await json<HookOut[]>(api("GET", `${path}/hooks`, owner.token));
    expect(listed.body).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain("whsec_");
    // Sealed at rest, bound to its repository and hook.
    const stored = await inRepo(stub(), (r: RepoDO) =>
      r.git.context.storage.sql.exec<{ secrets: string }>("SELECT secrets FROM webhooks").one(),
    );
    expect(stored.secrets).not.toContain((made.body.secret as string).slice(6));
    const [sealed] = JSON.parse(stored.secrets);
    const keys = await secretKeys(env);
    expect(await openSecret(keys, { repoId: repo.id, hookId: made.body.id }, sealed)).toBe(
      made.body.secret,
    );
    expect(
      await openSecret(keys, { repoId: repo.id, hookId: made.body.id + 1 }, sealed),
    ).toBeUndefined();

    for (const url of ["https://10.0.0.1/x", "http://93.184.216.34/x", "https://localhost/x"])
      expect((await createHook({ config: { url } })).body).toMatchObject({ code: "invalid_url" });
    const writer = await user();
    await api("PUT", `${path}/collaborators/${writer.handle}`, owner.token, { permission: "push" });
    expect((await createHook({}, writer)).status).toBe(404);
    expect((await json(api("GET", `${path}/hooks`, writer.token))).status).toBe(404);
  });

  it("route events to the active hooks that take them, at their configuration versions", async () => {
    const pushes = (await createHook({ events: ["push"] })).body;
    const prs = (await createHook({ events: ["pull_request"] })).body;
    const off = (await createHook({ events: ["push"], active: false })).body;
    expect(
      (
        await json(
          api("POST", "/repos/" + owner.handle + "/" + repo.name + "/file-commits", owner.token, {
            message: "first",
            changes: [{ path: "a.txt", content: "a\n" }],
          }),
        )
      ).status,
    ).toBe(201);
    const events = await outbox();
    const pushed = events.find((e) => e.type === "refs.updated");
    expect(pushed?.webhooks).toEqual({
      hooks: [{ id: pushes.id, v: 1 }],
      repo: { name: repo.name, ownerId: owner.principalId, private: true },
    });
    // Each hook made got its ping (the inactive one none).
    const pings = events.filter((e) => e.type === "webhook.ping").map((e) => e.webhooks?.hooks);
    expect(pings).toEqual([[{ id: pushes.id, v: 1 }], [{ id: prs.id, v: 1 }]]);
    expect(off.active).toBe(false);
  });

  it("are delivered: one row, its body, a message; signed as Standard Webhooks says", async () => {
    const hook = (await createHook({ events: ["push"] })).body;
    await api("POST", `${path}/file-commits`, owner.token, {
      message: "first",
      changes: [{ path: "a.txt", content: "a\n" }],
    });
    const events = (await outbox()).filter((e) => e.webhooks);
    await materialize(events);
    await materialize(events);
    const rows = (await deliveries()).sort((a, b) => (a.event < b.event ? -1 : 1));
    expect(rows.map((r) => [r.event, r.state, r.private])).toEqual([
      ["ping", "pending", 1],
      ["push", "pending", 1],
    ]);
    // Made again: nothing more.
    expect(sent.map((s) => s.delivery).sort()).toEqual(rows.map((r) => r.delivery_id).sort());
    const push = rows[1] as (typeof rows)[number];
    expect(push.delivery_id).toBe(
      await deliveryIdOf(eventKey((events[1] as DomainEvent).id), hook.id),
    );

    await attemptDelivery(deps(), push.delivery_id);
    expect(received).toHaveLength(1);
    const request = received[0] as (typeof received)[number];
    expect(request.url).toBe(RECEIVER);
    const body = JSON.parse(request.body);
    expect(body).toMatchObject({
      event: "push",
      repository: { id: repo.id, name: repo.name, private: true },
      refs: [{ ref: "refs/heads/main", before: null, created: true, deleted: false }],
    });
    expect(request.headers.get("webhook-id")).toBe(push.delivery_id);
    const timestamp = Number(request.headers.get("webhook-timestamp"));
    expect(request.headers.get("webhook-signature")).toBe(
      await signature([hook.secret as string], {
        id: push.delivery_id,
        timestamp,
        body: new TextEncoder().encode(request.body),
      }),
    );
    expect((await deliveries()).find((d) => d.event === "push")).toMatchObject({
      state: "done",
      attempts: 1,
      last_status: 200,
    });
    // Done: another message makes no attempt.
    await attemptDelivery(deps(), push.delivery_id);
    expect(received).toHaveLength(1);
  });

  it("list a push's refs up to a bound, so its journal row stays within a D1 value", () => {
    const name = `refs/heads/${'q"'.repeat(480)}`;
    const refs = Array.from({ length: 500 }, (_, i) => ({
      ref: `${name}${i}`,
      old: null,
      new: "a".repeat(40),
    }));
    const body = bodyOf({
      id: { sourceId: "rep_0", epochGen: 1, sourceSeq: 1 },
      type: "refs.updated",
      at: 0,
      actor: null,
      actChain: [],
      ownerGen: 1,
      entity: null,
      data: { via: "push", refs },
      stored: false,
      webhooks: { hooks: [{ id: 1, v: 1 }], repo: { name: "r", ownerId: "usr_0", private: true } },
    }) as { refs: unknown[]; refs_count: number; refs_truncated: boolean };
    expect(body.refs_count).toBe(500);
    expect(body.refs_truncated).toBe(true);
    expect(body.refs.length).toBeLessThan(500);
    const bound = new TextEncoder().encode(JSON.stringify(JSON.stringify(body))).length;
    expect(bound).toBeLessThan(1_000_000);
  });

  it("leave a message to a later invocation once its D1 queries are spent, never the first", async () => {
    await createHook();
    const events = (await outbox()).filter((e) => e.webhooks);
    const envelope = { sourceId: repo.id, events };
    const spent = { left: 1, applied: true };
    expect(await applyEnvelope(testEnv(), envelope, { sinks: [webhookSink], queries: spent })).toBe(
      "deferred",
    );
    const fresh = { left: 1, applied: false };
    expect(await applyEnvelope(testEnv(), envelope, { sinks: [webhookSink], queries: fresh })).toBe(
      "applied",
    );
  });

  it("journal an envelope of 50 large pushes in at most ten statements", () => {
    const name = `refs/heads/${'q"'.repeat(480)}`;
    const events: DomainEvent[] = Array.from({ length: 50 }, (_, n) => ({
      id: { sourceId: "rep_0", epochGen: 1, sourceSeq: n + 1 },
      type: "refs.updated",
      at: 0,
      actor: null,
      actChain: [],
      ownerGen: 1,
      entity: null,
      data: {
        via: "push",
        refs: Array.from({ length: 500 }, (_, i) => ({
          ref: `${name}${i}`,
          old: null,
          new: "a".repeat(40),
        })),
      },
      stored: false,
      webhooks: { hooks: [{ id: 1, v: 1 }], repo: { name: "r", ownerId: "usr_0", private: true } },
    }));
    expect(
      effectStatements(env.ORG_READ, [webhookSink], "rep_0", events, 0).length,
    ).toBeLessThanOrEqual(10);
  });

  it("are dropped, not sent empty, when an event's stored data cannot be read", async () => {
    await createHook();
    const ping = (await outbox()).find((e) => e.webhooks) as DomainEvent;
    // Still stored after hydration: its data was not found.
    await materialize([{ ...ping, data: null, stored: true }]);
    expect(await deliveries()).toEqual([
      expect.objectContaining({ state: "dropped", reason: "payload_missing" }),
    ]);
  });

  it("sign with the Standard Webhooks test vector, and with both secrets while one is replaced", async () => {
    const body = new TextEncoder().encode('{"test": 2432232314}');
    const message = { id: "msg_p5jXN8AQM9LWM0D4loKWxJek", timestamp: 1614265330, body };
    expect(await signature(["whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"], message)).toBe(
      "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
    );
    const hook = (await createHook()).body;
    const rotated = await json<{ secret: string }>(
      api("POST", `${path}/hooks/${hook.id}/secret`, owner.token),
    );
    expect(rotated.body.secret).not.toBe(hook.secret);
    const both = await stub().hookForDelivery(hook.id);
    expect(both.kind === "hook" && both.secrets).toEqual([rotated.body.secret, hook.secret]);
    await api("DELETE", `${path}/hooks/${hook.id}/secret/previous`, owner.token);
    const one = await stub().hookForDelivery(hook.id);
    expect(one.kind === "hook" && one.secrets).toEqual([rotated.body.secret]);
  });

  it("retry what may pass later, fail what will not, and turn a gone receiver's hook off", async () => {
    const hook = (await createHook()).body;
    await materialize((await outbox()).filter((e) => e.webhooks));
    const [ping] = await deliveries();
    const id = (ping as { delivery_id: string }).delivery_id;
    const now = Date.now();

    answer = () => new Response("busy", { status: 503, headers: { "retry-after": "30" } });
    await attemptDelivery(deps(now), id);
    expect((await deliveries())[0]).toMatchObject({
      state: "pending",
      attempts: 1,
      last_status: 503,
    });
    expect(sent.at(-1)).toEqual({ delivery: id, delaySeconds: 30 });
    // Not due yet.
    await attemptDelivery(deps(now + 1_000), id);
    expect(received).toHaveLength(1);

    answer = () => new Response("gone", { status: 410 });
    await attemptDelivery(deps(now + 31_000), id);
    expect((await deliveries())[0]).toMatchObject({ state: "failed", reason: "gone", attempts: 2 });
    const after = await json<HookOut>(api("GET", `${path}/hooks/${hook.id}`, owner.token));
    expect(after.body).toMatchObject({
      active: false,
      disabled_reason: expect.stringContaining("410"),
      last_response: { code: 410, status: "failed" },
    });
  });

  it("are cancelled when their hook goes, and never go over http for a private repository", async () => {
    const hook = (await createHook()).body;
    await materialize((await outbox()).filter((e) => e.webhooks));
    await api("DELETE", `${path}/hooks/${hook.id}`, owner.token);
    expect((await deliveries())[0]).toMatchObject({ state: "cancelled", reason: "hook_deleted" });

    // An http hook (as one made while the repository was public), and a private repository's event.
    const second = (await createHook()).body;
    await inRepo(stub(), (r: RepoDO) => {
      r.git.context.storage.sql.exec(
        "UPDATE webhooks SET url = ? WHERE hook_id = ?",
        "http://93.184.216.34/hook",
        second.id,
      );
    });
    await materialize(
      (await outbox()).filter((e) => e.webhooks?.hooks.some((h) => h.id === second.id)),
    );
    const ping = (await deliveries()).find((d) => d.hook_id === second.id) as {
      delivery_id: string;
    };
    await attemptDelivery(deps(), ping.delivery_id);
    expect(received).toHaveLength(0);
    expect((await deliveries()).find((d) => d.hook_id === second.id)).toMatchObject({
      state: "failed",
      reason: "insecure_url",
    });
  });

  it("are sent again by the cron when their message is late, and pruned past retention", async () => {
    await createHook();
    await materialize((await outbox()).filter((e) => e.webhooks));
    const [ping] = await deliveries();
    const id = (ping as { delivery_id: string }).delivery_id;
    sent = [];
    // Due, and its message lost: sent again once, after the grace period.
    // (The cron sees every repository's deliveries: only this one's are counted.)
    const late = Date.now() + 16 * 60_000;
    for (let i = 0; i < 5 && !sent.some((s) => s.delivery === id); i++)
      await reconcileWebhooks(deps(late));
    await reconcileWebhooks(deps(late));
    expect(sent.filter((s) => s.delivery === id)).toEqual([{ delivery: id }]);
    // The cron prunes in batches, other tests' deliveries too: until none of this one's is left.
    for (let i = 0; i < 20 && (await deliveries()).length > 0; i++)
      await reconcileWebhooks(deps(Date.now() + 31 * 24 * 60 * 60_000));
    expect(await deliveries()).toEqual([]);
  });

  it("turn a hook off only for a 410 their claim recorded, and the cron finishes a failed one", async () => {
    const hook = (await createHook()).body;
    await materialize((await outbox()).filter((e) => e.webhooks));
    const [ping] = await deliveries();
    const id = (ping as { delivery_id: string }).delivery_id;
    // A's request is held; its claim expires; B delivers; then A gets 410.
    let release = () => {};
    let entered = () => {};
    const inFetch = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      if (calls > 1) return new Response("ok", { status: 200 });
      await new Promise<void>((resolve) => {
        release = resolve;
        entered();
      });
      return new Response("gone", { status: 410 });
    });
    const now = Date.now();
    const first = attemptDelivery(deps(now), id);
    await inFetch;
    await attemptDelivery(deps(now + 2 * 60_000), id);
    release();
    await first;
    expect((await deliveries())[0]).toMatchObject({ state: "done", last_status: 200 });
    expect(
      (await json<HookOut>(api("GET", `${path}/hooks/${hook.id}`, owner.token))).body.active,
    ).toBe(true);

    // A 410 recorded while the repository object cannot be told: the cron turns the hook off.
    const second = (await createHook()).body;
    await materialize(
      (await outbox()).filter((e) => e.webhooks?.hooks.some((h) => h.id === second.id)),
    );
    const gone = (await deliveries()).find((d) => d.hook_id === second.id) as {
      delivery_id: string;
    };
    vi.stubGlobal("fetch", async () => new Response("gone", { status: 410 }));
    const unreachable = {
      ...deps(),
      env: {
        ...testEnv(),
        REPO: {
          getByName: (name: string) => {
            const real = env.REPO.getByName(name);
            return {
              hookForDelivery: (hookId: number) => real.hookForDelivery(hookId),
              disableHook: async () => {
                throw new Error("unavailable");
              },
            };
          },
        },
      } as unknown as Env,
    };
    await attemptDelivery(unreachable, gone.delivery_id);
    expect(
      (await json<HookOut>(api("GET", `${path}/hooks/${second.id}`, owner.token))).body.active,
    ).toBe(true);
    for (let i = 0; i < 20; i++) {
      await reconcileWebhooks(deps());
      if (!(await json<HookOut>(api("GET", `${path}/hooks/${second.id}`, owner.token))).body.active)
        break;
    }
    expect(
      (await json<HookOut>(api("GET", `${path}/hooks/${second.id}`, owner.token))).body,
    ).toMatchObject({
      active: false,
      disabled_reason: expect.stringContaining("410"),
    });
  });

  it("let a hook that cannot be turned off yet wait behind others", async () => {
    const stuck = (await createHook()).body;
    const other = (await createHook()).body;
    await materialize((await outbox()).filter((e) => e.webhooks));
    vi.stubGlobal("fetch", async () => new Response("gone", { status: 410 }));
    // Both 410s recorded while the repository object cannot be told.
    const failingFor = (hookIds: number[]) =>
      ({
        ...testEnv(),
        REPO: {
          getByName: (name: string) => {
            const real = env.REPO.getByName(name);
            return {
              hookForDelivery: (hookId: number) => real.hookForDelivery(hookId),
              disableHook: async (hookId: number, version: number, reason: string) => {
                if (hookIds.includes(hookId)) throw new Error("unavailable");
                return real.disableHook(hookId, version, reason);
              },
            };
          },
        },
      }) as unknown as Env;
    const rows = await deliveries();
    const byHook = (id: number) =>
      (rows.find((d) => d.hook_id === id) as { delivery_id: string }).delivery_id;
    await attemptDelivery({ ...deps(), env: failingFor([stuck.id, other.id]) }, byHook(stuck.id));
    await attemptDelivery({ ...deps(), env: failingFor([stuck.id, other.id]) }, byHook(other.id));
    // One a run: the stuck one first, then (behind it now) the other.
    const oneARun = {
      ...deps(),
      env: failingFor([stuck.id]),
      policy: { ...ATTEMPT_POLICY, disableBatch: 1 },
    };
    for (let i = 0; i < 3; i++) await reconcileWebhooks(oneARun);
    const active = async (id: number) =>
      (await json<HookOut>(api("GET", `${path}/hooks/${id}`, owner.token))).body.active;
    expect(await active(other.id)).toBe(false);
    expect(await active(stuck.id)).toBe(true);
  });

  it("record nothing over a cancellation, keep a bounded excerpt, and wait for a body", async () => {
    const hook = (await createHook()).body;
    await materialize((await outbox()).filter((e) => e.webhooks));
    const [ping] = await deliveries();
    const id = (ping as { delivery_id: string }).delivery_id;
    // The hook is deleted while its attempt is under way.
    let release = () => {};
    let entered = () => {};
    const inFetch = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.stubGlobal("fetch", async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
        entered();
      });
      return new Response("late", { status: 200 });
    });
    const running = attemptDelivery(deps(), id);
    await inFetch;
    await api("DELETE", `${path}/hooks/${hook.id}`, owner.token);
    const messages = sent.length;
    release();
    await running;
    expect((await deliveries())[0]).toMatchObject({ state: "cancelled", reason: "hook_deleted" });
    const attempts = await env.ORG_READ.prepare(
      "SELECT count(*) AS n FROM webhook_attempts WHERE delivery_id = ?",
    )
      .bind(id)
      .first<{ n: number }>();
    expect(attempts?.n).toBe(0);
    expect(sent.length).toBe(messages);

    // Malformed bytes read as U+FFFD: still 4 KiB of UTF-8 at most.
    const second = (await createHook()).body;
    vi.stubGlobal(
      "fetch",
      async () => new Response(new Uint8Array(4096).fill(0xff), { status: 500 }),
    );
    await materialize(
      (await outbox()).filter((e) => e.webhooks?.hooks.some((h) => h.id === second.id)),
    );
    const failing = (await deliveries()).find((d) => d.hook_id === second.id) as {
      delivery_id: string;
    };
    await attemptDelivery(deps(), failing.delivery_id);
    const excerpt = await env.ORG_READ.prepare(
      "SELECT response_excerpt FROM webhook_attempts WHERE delivery_id = ?",
    )
      .bind(failing.delivery_id)
      .first<{ response_excerpt: string }>();
    expect(new TextEncoder().encode(excerpt?.response_excerpt ?? "").length).toBeLessThanOrEqual(
      4096,
    );

    // Its body not stored (yet): no attempt spent, until an hour has passed.
    const third = (await createHook()).body;
    await materialize(
      (await outbox()).filter((e) => e.webhooks?.hooks.some((h) => h.id === third.id)),
    );
    const waiting = (await deliveries()).find((d) => d.hook_id === third.id) as {
      delivery_id: string;
    };
    const key = await env.ORG_READ.prepare(
      "SELECT payload_key FROM webhook_deliveries WHERE delivery_id = ?",
    )
      .bind(waiting.delivery_id)
      .first<{ payload_key: string }>();
    await env.ASSETS.delete(key?.payload_key as string);
    await attemptDelivery(deps(), waiting.delivery_id);
    expect((await deliveries()).find((d) => d.hook_id === third.id)).toMatchObject({
      state: "pending",
      attempts: 0,
    });
    await attemptDelivery(deps(Date.now() + 61 * 60_000), waiting.delivery_id);
    expect((await deliveries()).find((d) => d.hook_id === third.id)).toMatchObject({
      state: "failed",
      reason: "payload_missing",
    });
  });

  it("are sealed with a new key brought in beside the old one, then opened by it alone", async () => {
    const hook = (await createHook()).body;
    const next = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    const original = (env as { WEBHOOKS_KEY?: string }).WEBHOOKS_KEY as string;
    const vars = (r: RepoDO) =>
      (r as unknown as { env: { WEBHOOKS_KEY?: string; WEBHOOKS_KEY_NEXT?: string } }).env;
    try {
      // The new key beside the old one: everything sealed again with it.
      await inRepo(stub(), (r: RepoDO) => {
        vars(r).WEBHOOKS_KEY_NEXT = next;
      });
      expect(await stub().resealHookSecrets(50)).toEqual({
        resealed: 1,
        remaining: 0,
        unreadable: 0,
      });
      // Then the new key alone: the secret still opens.
      await inRepo(stub(), (r: RepoDO) => {
        vars(r).WEBHOOKS_KEY = next;
        delete vars(r).WEBHOOKS_KEY_NEXT;
      });
      const opened = await stub().hookForDelivery(hook.id);
      expect(opened.kind === "hook" && opened.secrets).toEqual([hook.secret]);
    } finally {
      await inRepo(stub(), (r: RepoDO) => {
        vars(r).WEBHOOKS_KEY = original;
        delete vars(r).WEBHOOKS_KEY_NEXT;
      });
    }
  });

  it("seal nothing under a malformed next key, the old one still opening", async () => {
    const keys = await secretKeys({
      WEBHOOKS_KEY: (env as { WEBHOOKS_KEY?: string }).WEBHOOKS_KEY,
      WEBHOOKS_KEY_NEXT: btoa("x".repeat(31)),
    });
    expect(keys.current).toBeUndefined();
    expect(keys.misconfigured).toContain("WEBHOOKS_KEY_NEXT");
    expect(keys.byId.size).toBe(1);
    // One after the other, nothing else changing: absent, then empty, then absent again.
    const valid = (env as { WEBHOOKS_KEY?: string }).WEBHOOKS_KEY;
    expect((await secretKeys({ WEBHOOKS_KEY: valid })).current).toBeDefined();
    expect(
      (await secretKeys({ WEBHOOKS_KEY: valid, WEBHOOKS_KEY_NEXT: "" })).current,
    ).toBeUndefined();
    expect((await secretKeys({ WEBHOOKS_KEY: valid })).current).toBeDefined();
    for (const empty of [{ WEBHOOKS_KEY_NEXT: "" }, { WEBHOOKS_KEY: "" }]) {
      const set = await secretKeys({
        WEBHOOKS_KEY: (env as { WEBHOOKS_KEY?: string }).WEBHOOKS_KEY,
        ...empty,
      });
      expect(set.current).toBeUndefined();
      expect(set.misconfigured).toBeDefined();
    }
  });

  it("drop a replaced secret past its week, so a key rotation finds nothing unreadable", async () => {
    const hook = (await createHook()).body;
    const rotated = await json<{ secret: string }>(
      api("POST", `${path}/hooks/${hook.id}/secret`, owner.token),
    );
    // The previous secret's week is over, and the key that sealed it is gone.
    await inRepo(stub(), (r: RepoDO) => {
      const sql = r.git.context.storage.sql;
      const [current, previous] = JSON.parse(
        sql.exec<{ secrets: string }>("SELECT secrets FROM webhooks").one().secrets,
      );
      sql.exec(
        "UPDATE webhooks SET secrets = ?",
        JSON.stringify([current, { ...previous, keyId: "0000000000000000", until: 1 }]),
      );
    });
    expect(await stub().resealHookSecrets(50)).toMatchObject({ unreadable: 0 });
    const left = await inRepo(stub(), (r: RepoDO) =>
      JSON.parse(
        r.git.context.storage.sql.exec<{ secrets: string }>("SELECT secrets FROM webhooks").one()
          .secrets,
      ),
    );
    expect(left).toHaveLength(1);
    const opened = await stub().hookForDelivery(hook.id);
    expect(opened.kind === "hook" && opened.secrets).toEqual([rotated.body.secret]);
  });

  it("are cancelled, and leave nothing to turn off, once their repository is erased", async () => {
    const hook = (await createHook()).body;
    await materialize((await outbox()).filter((e) => e.webhooks));
    const [ping] = await deliveries();
    const id = (ping as { delivery_id: string }).delivery_id;
    await api("DELETE", `/repos/${owner.handle}/${repo.name}`, owner.token);
    expect(await stub().eraseForDeletion()).toBe("erased");
    await attemptDelivery(deps(), id);
    expect(received).toHaveLength(0);
    expect((await deliveries())[0]).toMatchObject({ state: "cancelled", reason: "hook_deleted" });
    expect(await stub().disableHook(hook.id, 1, "gone")).toBe(false);
  });

  it("show deliveries and their attempts to administrators", async () => {
    const hook = (await createHook()).body;
    await materialize((await outbox()).filter((e) => e.webhooks));
    const [ping] = await deliveries();
    const id = (ping as { delivery_id: string }).delivery_id;
    await attemptDelivery(deps(), id);
    const listed = await json<{ deliveries: { id: string; state: string }[] }>(
      api("GET", `${path}/hooks/${hook.id}/deliveries`, owner.token),
    );
    expect(listed.body.deliveries).toEqual([expect.objectContaining({ id, state: "done" })]);
    const one = await json<{
      request: { payload: Record<string, unknown> };
      attempts_made: { n: number; status_code: number; response: string }[];
    }>(api("GET", `${path}/hooks/${hook.id}/deliveries/${id}`, owner.token));
    expect(one.body.request.payload).toMatchObject({ event: "ping", hook_id: hook.id });
    expect(one.body.attempts_made).toEqual([
      expect.objectContaining({ n: 1, status_code: 200, response: "ok" }),
    ]);
    expect(JSON.stringify(one.body)).not.toContain("whsec_");
  });
});

describe("pull request webhooks", () => {
  const fx = inject("pushFixtures");
  const commitOn = async (branch: string, content: string) => {
    const made = await json<{ commit: { sha: string } }>(
      api("POST", `${path}/file-commits`, owner.token, {
        branch,
        message: "change",
        changes: [{ path: "a.txt", content }],
      }),
    );
    expect(made.status).toBe(201);
    return made.body.commit.sha;
  };
  const branchAt = async (name: string, sha: string) => {
    const target: PushTarget = {
      repo: { id: repo.id, name: repo.name, stub: stub() },
      owner: {
        principalId: owner.principalId,
        token: await scopedToken(owner.principalId, [], "git"),
      },
      path: `/${owner.handle}/${repo.name}.git`,
    };
    const pushed = await postPush(
      target,
      pushBody([{ old: ZERO, new: sha, ref: `refs/heads/${name}` }], { pack: fx.packEmpty }),
    );
    expect(pushed.report).toContain(`ok refs/heads/${name}\n`);
  };
  /** The bodies the outbox's events make, in order. */
  const bodies = async () =>
    (await outbox())
      .filter((e) => e.webhooks && e.type !== "webhook.ping")
      .map((e) => bodyOf(e) as Record<string, unknown>);

  it("tell of pull requests, reviews and comments with their action and snapshot", async () => {
    await createHook({
      events: [
        "pull_request",
        "pull_request_review",
        "pull_request_review_comment",
        "issue_comment",
      ],
    });
    await branchAt("feature", await commitOn("main", "one\n"));
    const head = await commitOn("feature", "one\ntwo\n");
    expect(
      (
        await api("POST", `${path}/pulls`, owner.token, {
          title: "A change",
          head: "feature",
          base: "main",
        })
      ).status,
    ).toBe(201);
    await api("PATCH", `${path}/pulls/1`, owner.token, { title: "A better change" });
    const comment = await json<{ id: number }>(
      api("POST", `${path}/issues/1/comments`, owner.token, { body: "Looks right." }),
    );
    await api("DELETE", `${path}/issues/comments/${comment.body.id}`, owner.token);
    const diff = await json<{ id: number }>(
      api("POST", `${path}/pulls/1/comments`, owner.token, {
        body: "Why?",
        commit_id: head,
        path: "a.txt",
        line: 2,
      }),
    );
    expect(diff.status).toBe(201);
    expect(
      (
        await api("POST", `${path}/pulls/1/reviews`, owner.token, {
          event: "COMMENT",
          body: "Ok",
          commit_id: head,
        })
      ).status,
    ).toBe(200);
    const made = await bodies();
    expect(made.map((b) => `${b.event}.${b.action}`)).toEqual([
      "pull_request.opened",
      "pull_request.edited",
      "issue_comment.created",
      "issue_comment.deleted",
      "pull_request_review_comment.created",
      "pull_request_review.submitted",
    ]);
    const [opened, edited, created, deleted, onDiff, review] = made;
    expect(opened).toMatchObject({
      number: 1,
      repository: { id: repo.id },
      sender: { id: owner.principalId },
      pull_request: {
        number: 1,
        state: "open",
        merged: false,
        title: "A change",
        head: { ref: "feature", sha: head, repo_id: null },
        base: { ref: "main" },
        user: { id: owner.principalId },
      },
    });
    expect((opened?.pull_request as { created_at?: string } | undefined)?.created_at).toMatch(
      /^\d{4}-\d\d-\d\dT/,
    );
    expect(edited).toMatchObject({
      pull_request: { title: "A better change" },
      changes: { title: { from: "A change" } },
    });
    expect(created).toMatchObject({
      number: 1,
      comment: { id: comment.body.id, body: "Looks right." },
    });
    // Gone: what it was on, and its id.
    expect(deleted).toMatchObject({ number: 1, comment: { id: comment.body.id } });
    expect(onDiff).toMatchObject({
      number: 1,
      comment: { id: diff.body.id, path: "a.txt", line: 2, commit_id: head, side: "RIGHT" },
    });
    expect(review).toMatchObject({ number: 1, review: { state: "COMMENTED", body: "Ok" } });
    // Each made its own delivery, with its action recorded.
    // One event per run: a run delivers only a few effects itself (the rest wait for the sweep).
    for (const event of (await outbox()).filter((e) => e.webhooks)) await materialize([event]);
    const actions = (
      await env.ORG_READ.prepare(
        "SELECT event, action FROM webhook_deliveries WHERE repo_id = ? AND event != 'ping'",
      )
        .bind(repo.id)
        .all<{ event: string; action: string }>()
    ).results.map((r) => `${r.event}.${r.action}`);
    expect(actions.sort()).toEqual(made.map((b) => `${b.event}.${b.action}`).sort());
  });

  it("show a dismissed review as dismissed, and tell of a head branch deleted or back", () => {
    const at = Date.now();
    const event = {
      id: { sourceId: repo.id, epochGen: 1, sourceSeq: 7 },
      type: "pull_request_review.dismissed",
      at,
      actor: owner.principalId,
      actChain: [],
      ownerGen: 1,
      entity: {
        type: "pull_review",
        id: `${repo.id}#1/reviews/3`,
        version: 2,
        deleted: false,
        row: {
          id: 3,
          number: 1,
          reviewerId: owner.principalId,
          actChain: [],
          state: "APPROVED",
          commitSha: "a".repeat(40),
          body: null,
          submittedAt: at,
          dismissedAt: at,
          dismissedBy: owner.principalId,
          dismissalMessage: "stale",
        },
      },
      data: null,
      stored: false,
      webhooks: {
        hooks: [{ id: 1, v: 1 }],
        repo: { name: repo.name, ownerId: owner.principalId, private: true },
      },
    } as unknown as DomainEvent;
    expect(bodyOf(event)).toMatchObject({
      action: "dismissed",
      review: { id: 3, state: "DISMISSED", dismissal_message: "stale" },
    });
    for (const action of ["head_ref_deleted", "head_ref_restored"])
      expect(webhookEventOf(`pull_request.${action}`)).toEqual({ event: "pull_request", action });
  });

  it("go only to hooks that take the event", async () => {
    await createHook({ events: ["issue_comment"] });
    await branchAt("feature", await commitOn("main", "one\n"));
    await commitOn("feature", "one\ntwo\n");
    await api("POST", `${path}/pulls`, owner.token, {
      title: "A change",
      head: "feature",
      base: "main",
    });
    await api("POST", `${path}/issues/1/comments`, owner.token, { body: "Hi." });
    expect((await bodies()).map((b) => b.event)).toEqual(["issue_comment"]);
  });
});

describe("redelivery", () => {
  // What the API queues for an attempt is kept here, not sent: the real queue's consumer would
  // make the attempt whenever it ran (in this test or a later one), and each test makes its own.
  let queued: string[];
  beforeEach(() => {
    queued = [];
    vi.spyOn(env.WEBHOOKS, "send").mockImplementation(async (body: unknown) => {
      queued.push((body as { delivery: string }).delivery);
      return {} as QueueSendResponse;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const redeliver = (hook: number, id: string, who: Who = owner) =>
    json<{ id: string; state: string; code?: string }>(
      api("POST", `${path}/hooks/${hook}/deliveries/${id}/attempts`, who.token),
    );
  /** A hook, its ping delivered once (answered `status`). */
  const delivered = async (status = 200) => {
    const hook = (await createHook()).body;
    await materialize((await outbox()).filter((e) => e.webhooks));
    const id = ((await deliveries())[0] as { delivery_id: string }).delivery_id;
    answer = () => new Response("no", { status });
    await attemptDelivery(deps(), id);
    return { hook: hook.id, id };
  };

  it("sends a finished delivery once more: the same id and body, signed now", async () => {
    const { hook, id } = await delivered(400);
    expect((await deliveries())[0]).toMatchObject({ state: "failed", attempts: 1 });
    const again = await redeliver(hook, id);
    // Queued for its attempt.
    expect(queued).toEqual([id]);
    expect(again.status).toBe(202);
    expect(again.body).toMatchObject({ id, state: "pending" });
    answer = () => new Response("ok", { status: 200 });
    await attemptDelivery(deps(Date.now() + 1_000), id);
    expect(received).toHaveLength(2);
    expect(received[1]?.headers.get("webhook-id")).toBe(id);
    expect(received[1]?.body).toBe(received[0]?.body);
    expect((await deliveries())[0]).toMatchObject({ state: "done", attempts: 2 });
    const one = await json<{ attempts_made: { n: number; status_code: number }[] }>(
      api("GET", `${path}/hooks/${hook}/deliveries/${id}`, owner.token),
    );
    expect(one.body.attempts_made.map((a) => [a.n, a.status_code])).toEqual([
      [1, 400],
      [2, 200],
    ]);
  });

  it("makes one attempt only, not the automatic retries", async () => {
    const { hook, id } = await delivered(400);
    expect((await redeliver(hook, id)).status).toBe(202);
    answer = () => new Response("busy", { status: 503 });
    await attemptDelivery(deps(Date.now() + 1_000), id);
    expect((await deliveries())[0]).toMatchObject({
      state: "failed",
      reason: "attempts_spent",
      attempts: 2,
    });
    // Nothing more is claimed.
    await attemptDelivery(deps(Date.now() + 10 * 60 * 60_000), id);
    expect(received).toHaveLength(2);
  });

  it("refuses a pending delivery, a gone body, other hooks and non-administrators", async () => {
    const hook = (await createHook()).body;
    await materialize((await outbox()).filter((e) => e.webhooks));
    const id = ((await deliveries())[0] as { delivery_id: string }).delivery_id;
    expect((await redeliver(hook.id, id)).body.code).toBe("delivery_pending");
    await attemptDelivery(deps(), id);
    const other = (await createHook()).body;
    expect((await redeliver(other.id, id)).body.code).toBe("delivery_not_found");
    const stranger = await user();
    expect((await redeliver(hook.id, id, stranger)).status).toBe(404);
    const key = (
      await env.ORG_READ.prepare("SELECT payload_key FROM webhook_deliveries WHERE delivery_id = ?")
        .bind(id)
        .first<{ payload_key: string }>()
    )?.payload_key as string;
    await env.ASSETS.delete(key);
    expect((await redeliver(hook.id, id)).body.code).toBe("payload_gone");
  });

  it("waits for a hook a 410 is turning off, and refuses an expired delivery", async () => {
    const { hook, id } = await delivered(400);
    const set = (column: string, value: number) =>
      env.ORG_READ.prepare(`UPDATE webhook_deliveries SET ${column} = ? WHERE delivery_id = ?`)
        .bind(value, id)
        .run();
    await set("disable_hook_version", 1);
    expect((await redeliver(hook, id)).body.code).toBe("hook_being_disabled");
    await env.ORG_READ.prepare(
      "UPDATE webhook_deliveries SET disable_hook_version = NULL WHERE delivery_id = ?",
    )
      .bind(id)
      .run();
    await set("expires_at", Date.now() - 1);
    expect((await redeliver(hook, id)).body.code).toBe("payload_gone");
  });

  it("leaves nothing for a claim of an earlier attempt to record", async () => {
    const { hook, id } = await delivered(400);
    // A claim of the first round, still running (its lease long gone) when the delivery is sent again.
    await env.ORG_READ.prepare(
      "UPDATE webhook_deliveries SET lease_token = 'stale' WHERE delivery_id = ?",
    )
      .bind(id)
      .run();
    expect((await redeliver(hook, id)).status).toBe(202);
    const row = await env.ORG_READ.prepare(
      "SELECT lease_token, attempt_limit, attempts FROM webhook_deliveries WHERE delivery_id = ?",
    )
      .bind(id)
      .first<{ lease_token: string | null; attempt_limit: number; attempts: number }>();
    expect(row).toEqual({ lease_token: null, attempt_limit: 2, attempts: 1 });
  });
});
