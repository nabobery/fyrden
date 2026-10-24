// What full webhook bodies promise, end to end: the largest issues and
// pull requests (every field at its limit, escaped as expensively as it
// allows, and the shape just short of the fallback that keeps short text
// inline) are captured within the inline bound, made (not dropped) and
// delivered as the API shows them; overlapping runs, a recovered body, a
// retry and a redelivery all send the same bytes; an event recorded
// without a capture still gets its own body; text a change's events share
// is kept once; and a 100-label replacement's fan-out is what it costs.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import {
  type DomainEvent,
  eventKey,
  MAX_ASSIGNEES,
  MAX_ISSUE_BODY_LENGTH,
  MAX_ISSUE_TITLE_LENGTH,
  MAX_LABEL_DESCRIPTION_LENGTH,
  MAX_LABEL_NAME_LENGTH,
  MAX_MILESTONE_DESCRIPTION_LENGTH,
  MAX_MILESTONE_TITLE_LENGTH,
  MAX_SUBJECT_LABELS,
} from "@fyrden/domain";
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { RepoWebhookBlobs } from "../src/do/repo/webhook-blobs.js";
import { effectCalls } from "../src/effects/journal.js";
import { BLOB_FALLBACK_MIN_BYTES, INLINE_MAX_BYTES } from "../src/webhooks/capture.js";
import { attemptDelivery } from "../src/webhooks/deliver.js";
import { bodyKeyOf, createWebhookSink, DELIVERY_POLICY } from "../src/webhooks/sink.js";
import { api, user } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { webhookTest } from "./helpers/webhooks.js";

const t = webhookTest();

type Body = Record<string, unknown>;

const encoder = new TextEncoder();
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;

/** Fails with the answer when a call does not succeed; the answer's JSON otherwise. */
async function ok<T = Body>(res: Promise<Response>): Promise<T> {
  const answer = await res;
  if (answer.status >= 300) throw new Error(`${answer.status}: ${await answer.text()}`);
  return (answer.status === 204 ? {} : await answer.json()) as T;
}

/** `n` characters of `c`, after `seed`: each control character JSON escapes to six bytes. */
const costly = (n: number, c = "\u0000", seed = "") => (seed + c.repeat(n)).slice(0, n);

/** A label name just short of the 64 bytes as JSON past which a fallen-back capture stores it apart. */
const nameUnderFallback = (i: number) =>
  `${i}${'"'.repeat(Math.floor((BLOB_FALLBACK_MIN_BYTES - 3 - String(i).length) / 2))}`;

/**
 * Label names and descriptions, each capture falling back (storing text of
 * 64 bytes or more apart): every one at its limit (`max`), or names just
 * short of 64 bytes, so they stay inline (`inline-names`: the most a
 * capture keeps inline once it fell back). A name allows no control
 * characters: quotes (two bytes) instead.
 */
const LABEL_SHAPES = {
  max: (i: number) => ({
    name: `${i}${'"'.repeat(MAX_LABEL_NAME_LENGTH)}`.slice(0, MAX_LABEL_NAME_LENGTH),
    description: costly(MAX_LABEL_DESCRIPTION_LENGTH),
  }),
  "inline-names": (i: number) => ({
    name: nameUnderFallback(i),
    description: costly(MAX_LABEL_DESCRIPTION_LENGTH),
  }),
} as const;

/** Whether a capture fell back: its first label's description stored apart. */
const fellBack = (tree: unknown) =>
  typeof (tree as { issue: { labels: { description: unknown }[] } }).issue.labels[0]
    ?.description === "object";

/** What a captured event holds: its inline tree, wherever the event's data travelled. */
async function captureOf(event: DomainEvent): Promise<{ tree: unknown }> {
  if (!event.stored) return event.data?.webhook as { tree: unknown };
  const kept = await runInDurableObject(t.stub(), (_, state) =>
    state.storage.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM event_payloads WHERE event_key = ?",
        eventKey(event.id),
      )
      .one(),
  );
  return (JSON.parse(kept.payload) as { data: { webhook: { tree: unknown } } }).data.webhook;
}

/** Each event's capture within the inline bound, and its effect within the journal's. */
async function withinBounds(events: DomainEvent[]): Promise<void> {
  for (const event of events) {
    const { tree } = await captureOf(event);
    expect(bytes(tree), event.type).toBeLessThanOrEqual(INLINE_MAX_BYTES);
    // As the journal binds it (escaped twice): within the bound past which it is dropped.
    expect(bytes(JSON.stringify({ tree })), event.type).toBeLessThanOrEqual(
      DELIVERY_POLICY.maxBodyBytes,
    );
  }
}

/** A property of `target`, its methods bound to it. */
const forward = (target: object, prop: string | symbol) => {
  const value = Reflect.get(target, prop);
  return typeof value === "function" ? value.bind(target) : value;
};

/**
 * A property of a Durable Object stub: a method called on the stub itself
 * (its RPC methods cannot be bound or applied: `bind` and `apply` are
 * taken for methods of the object).
 */
const forwardStub = (target: object, prop: string | symbol) => {
  const value = Reflect.get(target, prop);
  return typeof value === "function"
    ? (...args: unknown[]) =>
        (target as Record<string | symbol, (...a: unknown[]) => unknown>)[prop]?.(...args)
    : value;
};

/** `base` with its binding `name` replaced by `replace(the binding)`. */
const withBinding = <K extends keyof Env>(base: Env, name: K, replace: (b: Env[K]) => unknown) =>
  new Proxy(base, {
    get: (target, prop) =>
      prop === name ? replace(Reflect.get(target, prop) as Env[K]) : Reflect.get(target, prop),
  });

/**
 * `base` counting, in `calls`, each call making an event's deliveries
 * takes: D1 round trips (the org database's and the directory's), R2
 * operations, queue sends and the repository object's calls.
 */
function measured(base: Env, calls: { n: number; blobReads?: number }): Env {
  const counted = <T extends object>(target: T, methods: readonly string[]): T =>
    new Proxy(target, {
      get(object, prop) {
        const value = Reflect.get(object, prop);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (methods.includes(String(prop))) calls.n++;
          const result = value.apply(object, args);
          // A prepared statement counts when it runs (bound or not); a session as its database.
          if (prop === "prepare" || prop === "bind")
            return counted(result, ["run", "first", "all", "raw"]);
          if (prop === "withSession") return counted(result, ["batch"]);
          return result;
        };
      },
    });
  const repoCalls = ["webhookBlobs", "hooksForDelivery", "disableHook"];
  return {
    ...base,
    ORG_READ: counted(base.ORG_READ, ["batch"]),
    DIRECTORY: counted(base.DIRECTORY, ["batch"]),
    ASSETS: counted(base.ASSETS, ["put", "get", "delete", "head"]),
    WEBHOOKS: counted(base.WEBHOOKS, ["send", "sendBatch"]),
    REPO: {
      getByName: (name: string) => {
        const stub = base.REPO.getByName(name);
        return new Proxy(stub, {
          get(target, prop) {
            const value = forwardStub(target, prop);
            if (typeof value !== "function" || !repoCalls.includes(String(prop))) return value;
            return (...args: unknown[]) => {
              calls.n++;
              if (prop === "webhookBlobs") calls.blobReads = (calls.blobReads ?? 0) + 1;
              return value(...args);
            };
          },
        });
      },
    },
  } as unknown as Env;
}

/** Rows the repository object wrote keeping capture blobs, since `countBlobWrites`. */
let blobWrites = 0;

/** From now on, counts the rows the test's repository object writes keeping capture blobs. */
async function countBlobWrites(): Promise<void> {
  blobWrites = 0;
  await runInDurableObject(t.stub(), (instance: RepoDO) => {
    const metrics = {
      count(name: string, _dimensions: Record<string, string>, value = 1) {
        if (name === "do.rows_written") blobWrites += value;
      },
    } as unknown as Metrics;
    Object.assign(instance, {
      webhookBlobStore: new RepoWebhookBlobs({ git: instance.git, metrics, pruneAt: () => {} }),
    });
  });
}

/** The bodies stored for `events`, in order. */
const storedBodies = (repoId: string, events: DomainEvent[]) =>
  Promise.all(
    events.map(async (e) =>
      (await env.ASSETS.get(await bodyKeyOf(repoId, eventKey(e.id))))?.text(),
    ),
  );

describe("full webhook bodies", () => {
  // Fixtures of hundreds of labels each: the request rate limits are another test's subject.
  beforeEach(() => {
    vi.spyOn(env.RATE_LIMIT_AUTH, "limit").mockResolvedValue({ success: true });
    vi.spyOn(env.RATE_LIMIT_WRITE, "limit").mockResolvedValue({ success: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const fx = inject("pushFixtures");
  const commitOn = async (branch: string, content: string) =>
    (
      await ok<{ commit: { sha: string } }>(
        api("POST", `${t.path}/file-commits`, t.owner.token, {
          branch,
          message: "change",
          changes: [{ path: "a.txt", content }],
        }),
      )
    ).commit.sha;
  const branchAt = async (name: string, sha: string) => {
    const target: PushTarget = {
      repo: { id: t.repo.id, name: t.repo.name, stub: t.stub() },
      owner: {
        principalId: t.owner.principalId,
        token: await scopedToken(t.owner.principalId, [], "git"),
      },
      path: `/${t.owner.handle}/${t.repo.name}.git`,
    };
    await postPush(
      target,
      pushBody([{ old: ZERO, new: sha, ref: `refs/heads/${name}` }], { pack: fx.packEmpty }),
    );
  };
  /** The repository's labels (`shape`), a maximal milestone and nine more assignable users. */
  const metadata = async (shape: keyof typeof LABEL_SHAPES) => {
    const labels = Array.from({ length: MAX_SUBJECT_LABELS }, (_, i) => LABEL_SHAPES[shape](i));
    for (const label of labels)
      await ok(api("POST", `${t.path}/labels`, t.owner.token, { ...label, color: "ffffff" }));
    await ok(
      api("POST", `${t.path}/milestones`, t.owner.token, {
        title: costly(MAX_MILESTONE_TITLE_LENGTH, "\u0003", "m"),
        description: costly(MAX_MILESTONE_DESCRIPTION_LENGTH, "\u0001"),
      }),
    );
    const assignees = [t.owner.handle];
    while (assignees.length < MAX_ASSIGNEES) {
      const who = await user();
      await ok(
        api("PUT", `${t.path}/collaborators/${who.handle}`, t.owner.token, { permission: "push" }),
      );
      assignees.push(who.handle);
    }
    return { labels: labels.map((l) => l.name), assignees };
  };

  for (const shape of Object.keys(LABEL_SHAPES) as (keyof typeof LABEL_SHAPES)[])
    it(`capture the largest issue (labels: ${shape}) within its bounds, and deliver it as the API shows it`, async () => {
      await t.createHook({ events: ["issues"] });
      const { labels, assignees } = await metadata(shape);
      await ok(
        api("POST", `${t.path}/issues`, t.owner.token, {
          title: costly(MAX_ISSUE_TITLE_LENGTH, "\u0000", "t"),
          body: costly(MAX_ISSUE_BODY_LENGTH),
          labels,
          assignees,
          milestone: 1,
        }),
      );
      // An edit: the body before and after, two distinct texts at the limit.
      await ok(
        api("PATCH", `${t.path}/issues/1`, t.owner.token, {
          body: costly(MAX_ISSUE_BODY_LENGTH, "\u0002"),
        }),
      );
      // A label off and on again: each event carries the label in full.
      const [first = ""] = labels;
      await ok(
        api("DELETE", `${t.path}/issues/1/labels/${encodeURIComponent(first)}`, t.owner.token),
      );
      await ok(api("POST", `${t.path}/issues/1/labels`, t.owner.token, { labels: [first] }));
      // An assignee off: the event carries the user in full.
      await ok(
        api("DELETE", `${t.path}/issues/1/assignees`, t.owner.token, {
          assignees: [t.owner.handle],
        }),
      );

      const events = await t.routed();
      expect(events.map((e) => e.type)).toEqual([
        "issue.opened",
        "issue.edited",
        "issue.unlabeled",
        "issue.labeled",
        "issue.unassigned",
      ]);
      await withinBounds(events);
      for (const event of events) expect(fellBack((await captureOf(event)).tree)).toBe(true);
      await t.materialize(events, 1);
      // Made and sent, none dropped: the receiver got the stored bytes.
      expect(new Set((await t.deliveries()).map((d) => d.state))).toEqual(new Set(["done"]));
      const stored = await storedBodies(t.repo.id, events);
      expect(t.received.map((r) => r.body).sort()).toEqual([...stored].sort());
      const [, edited, unlabeled, , unassigned] = stored.map((s) => JSON.parse(s ?? "{}") as Body);
      expect((edited?.changes as { body: { from: string } } | undefined)?.body.from).toBe(
        costly(MAX_ISSUE_BODY_LENGTH),
      );
      const label = await ok<Body>(
        api("GET", `${t.path}/labels/${encodeURIComponent(first)}`, t.owner.token),
      );
      expect(unlabeled?.label).toEqual(label);
      expect(unassigned?.assignee).toEqual({ id: t.owner.principalId, login: t.owner.handle });
      // The issue as the API shows it, after the last change.
      const shown = await ok<Body>(api("GET", `${t.path}/issues/1`, t.owner.token));
      const issue = unassigned?.issue as Body;
      // The reader's own reactions (`viewer`) are the API's, read alone, not the event's.
      const { viewer: _viewer, ...counts } = shown.reactions as Body;
      for (const field of ["number", "title", "body", "state", "labels"])
        expect(issue[field], field).toEqual(shown[field]);
      expect(issue.reactions).toEqual(counts);
      expect((issue.assignees as Body[]).map((a) => a.id)).toEqual(
        (shown.assignees as Body[]).map((a) => a.id),
      );
      const {
        creator: _creator,
        created_at: _created,
        updated_at: _updated,
        closed_at: _closed,
        due_on: _due,
        ...milestone
      } = shown.milestone as Body;
      expect(issue.milestone).toMatchObject(milestone);
    });

  // An issue with 100 labels whose descriptions are `length` control characters: each adds about
  // 600 bytes to its labeled event's capture, which 92 keep just under the inline bound and 93
  // take just over it (measured; the test fails if the shapes change enough to move it).
  for (const [length, falls] of [
    [92, false],
    [93, true],
  ] as const)
    it(`keep a capture just ${falls ? "over" : "under"} the inline bound ${falls ? "fallen back" : "whole"}`, async () => {
      await t.createHook({ events: ["issues"] });
      const names = Array.from({ length: MAX_SUBJECT_LABELS }, (_, i) => `l${i}`);
      for (const name of names)
        await ok(
          api("POST", `${t.path}/labels`, t.owner.token, {
            name,
            color: "ffffff",
            description: costly(length),
          }),
        );
      await ok(
        api("POST", `${t.path}/issues`, t.owner.token, {
          title: "T",
          body: "b",
          labels: names.slice(0, -1),
        }),
      );
      await ok(
        api("POST", `${t.path}/issues/1/labels`, t.owner.token, { labels: names.slice(-1) }),
      );
      const [, labeled] = await t.routed();
      if (!labeled) throw new Error("no event");
      const { tree } = await captureOf(labeled);
      expect(fellBack(tree)).toBe(falls);
      expect(bytes(tree)).toBeLessThanOrEqual(INLINE_MAX_BYTES);
      if (!falls) expect(bytes(tree)).toBeGreaterThan(INLINE_MAX_BYTES - 1_024);
      await withinBounds([labeled]);
      const [body] = await t.bodies([labeled]);
      expect((body?.label as Body | undefined)?.description).toBe(costly(length));
    });

  it("capture the largest pull request within its bounds, and deliver it", async () => {
    await t.createHook({ events: ["pull_request"] });
    const { labels, assignees } = await metadata("inline-names");
    // A head branch named at the limit.
    const head = `${"b".repeat(200)}/`.repeat(6).slice(0, 1024 - "refs/heads/".length);
    await branchAt("short", await commitOn("main", "one\n"));
    await branchAt(head, await commitOn("short", "one\ntwo\n"));
    await ok(
      api("POST", `${t.path}/pulls`, t.owner.token, {
        title: costly(MAX_ISSUE_TITLE_LENGTH, "\u0000", "p"),
        body: costly(MAX_ISSUE_BODY_LENGTH),
        head,
        base: "main",
      }),
    );
    await ok(
      api("PATCH", `${t.path}/issues/1`, t.owner.token, { labels, assignees, milestone: 1 }),
    );
    const events = await t.routed();
    await withinBounds(events);
    await t.materialize(events, 1);
    expect(new Set((await t.deliveries()).map((d) => d.state))).toEqual(new Set(["done"]));
    const stored = await storedBodies(t.repo.id, events);
    expect(t.received.map((r) => r.body).sort()).toEqual([...stored].sort());
    const last = JSON.parse(stored.at(-1) ?? "{}") as Body;
    expect(last.pull_request).toMatchObject({ head: { ref: head }, milestone: { number: 1 } });
  });

  it("send the same bytes from overlapping runs, a recovered body, a retry and a redelivery", async () => {
    const hook = (await t.createHook({ events: ["issues"] })).body;
    await t.createHook({ events: ["issues"] });
    await ok(
      api("POST", `${t.path}/issues`, t.owner.token, {
        title: "Large",
        // Long enough to be kept apart, short enough for the event to travel whole.
        body: costly(10_000),
      }),
    );
    const [opened] = await t.routed();
    if (!opened) throw new Error("no event");
    expect(opened.stored).toBe(false);
    // Two runs of the effect at once, both held before storing the body, then let go together:
    // one stores it, the other finds it stored and uses its bytes.
    const sink = createWebhookSink({
      firstAttempts: 2,
      resolver: () => async () => ["93.184.216.34"],
    });
    const [planned] = sink.plan(opened);
    if (!planned) throw new Error("no effect");
    const effect = { id: "e", sink: "webhooks", ...planned, attempts: 1, claimedAt: Date.now() };
    const puts: (R2Object | null)[] = [];
    let waiting = 0;
    let release = () => {};
    const together = new Promise<void>((resolve) => {
      release = resolve;
    });
    const racing = withBinding(
      t.testEnv(),
      "ASSETS",
      (assets) =>
        new Proxy(assets, {
          get(target, prop) {
            if (prop !== "put") return forward(target, prop);
            return async (...args: Parameters<R2Bucket["put"]>) => {
              if (++waiting === 2) release();
              await together;
              const put = await target.put(...args);
              puts.push(put);
              return put;
            };
          },
        }),
    );
    await Promise.all([
      sink.deliver(effect, racing, env.ORG_READ),
      sink.deliver(effect, racing, env.ORG_READ),
    ]);
    expect(puts).toHaveLength(2);
    expect(puts.filter((put) => put === null)).toHaveLength(1);
    const [stored] = await storedBodies(t.repo.id, [opened]);
    // Each delivery's first attempt, made once (by whichever run claimed it).
    expect(t.received.map((r) => r.body)).toEqual([stored, stored]);
    // Its deliveries lost, it is made again from the stored body.
    await env.ORG_READ.prepare("DELETE FROM webhook_deliveries WHERE repo_id = ?")
      .bind(t.repo.id)
      .run();
    let seen = t.received.length;
    await sink.deliver(effect, t.testEnv(), env.ORG_READ);
    expect(t.received.slice(seen).map((r) => r.body)).toEqual([stored, stored]);
    // A delivery waiting again: a failed attempt, its retry, then a redelivery.
    const [delivery] = (await t.deliveries()).filter((d) => d.hook_id === hook.id);
    const id = delivery?.delivery_id ?? "";
    await env.ORG_READ.prepare(
      `UPDATE webhook_deliveries SET state = 'pending', next_attempt_at = 0, attempts = 0
       WHERE delivery_id = ?`,
    )
      .bind(id)
      .run();
    seen = t.received.length;
    t.answer = () => new Response("busy", { status: 503 });
    await attemptDelivery(t.deps(), id);
    t.answer = () => new Response("ok", { status: 200 });
    await attemptDelivery(t.deps(Date.now() + 7 * 60 * 60_000), id);
    vi.spyOn(env.WEBHOOKS, "send").mockResolvedValue({} as QueueSendResponse);
    try {
      await ok(api("POST", `${t.path}/hooks/${hook.id}/deliveries/${id}/attempts`, t.owner.token));
      await attemptDelivery(t.deps(Date.now() + 8 * 60 * 60_000), id);
    } finally {
      vi.restoreAllMocks();
    }
    const sent = t.received.slice(seen);
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((r) => r.body))).toEqual(new Set([stored]));
    expect(new Set(sent.map((r) => r.headers.get("webhook-id")))).toEqual(new Set([id]));
  });

  it("are not made once the repository changed owners between the claim and its texts' read", async () => {
    await t.createHook({ events: ["issues"] });
    await ok(
      api("POST", `${t.path}/issues`, t.owner.token, { title: "Moved", body: "o".repeat(4_000) }),
    );
    const [opened] = await t.routed();
    if (!opened) throw new Error("no event");
    const sink = createWebhookSink({ resolver: () => async () => ["93.184.216.34"] });
    const [planned] = sink.plan(opened);
    if (!planned) throw new Error("no effect");
    const effect = { id: "e", sink: "webhooks", ...planned, attempts: 1, claimedAt: Date.now() };
    // Claimed, then, before its texts are read, the repository's ownership moves on (as a
    // transfer moves it).
    const moving = withBinding(t.testEnv(), "REPO", (repos) => ({
      getByName: (name: string) => {
        const stub = repos.getByName(name);
        return new Proxy(stub, {
          get(target, prop) {
            if (prop !== "webhookBlobs") return forwardStub(target, prop);
            return async (...args: Parameters<typeof stub.webhookBlobs>) => {
              await runInDurableObject(stub, (_, state) => {
                state.storage.sql.exec("UPDATE repo_meta SET owner_gen = owner_gen + 1");
              });
              return target.webhookBlobs(...args);
            };
          },
        });
      },
    }));
    expect(await sink.deliver(effect, moving, env.ORG_READ)).toEqual({
      ended: "invalidated: its source was transferred",
    });
    expect(await t.deliveries()).toEqual([]);
    expect(await storedBodies(t.repo.id, [opened])).toEqual([undefined]);
  });

  it("make an event's deliveries within the calls it reserves, fresh, losing the put and recovered", async () => {
    for (let i = 0; i < 3; i++) await t.createHook({ events: ["issues"] });
    await ok(
      api("POST", `${t.path}/milestones`, t.owner.token, {
        title: "v1",
        description: costly(2_000, "\u0001"),
      }),
    );
    // Three texts kept apart (its title, its body, its milestone's description): read in one call.
    await ok(
      api("POST", `${t.path}/issues`, t.owner.token, {
        title: costly(MAX_ISSUE_TITLE_LENGTH, "\u0000", "c"),
        body: costly(10_000),
        assignees: [t.owner.handle],
        milestone: 1,
      }),
    );
    const [opened] = await t.routed();
    if (!opened) throw new Error("no event");
    // The costliest answer: gone, so each attempt also turns its hook off.
    t.answer = () => new Response("gone", { status: 410 });
    const sink = createWebhookSink({ resolver: () => async () => ["93.184.216.34"] });
    const [planned] = sink.plan(opened);
    if (!planned) throw new Error("no effect");
    const reserved = effectCalls(sink, planned);
    const effect = { id: "e", sink: "webhooks", ...planned, attempts: 1, claimedAt: Date.now() };
    // Two runs at once, both held before storing the body: one stores it, the other loses.
    const runs = [
      { n: 0, blobReads: 0 },
      { n: 0, blobReads: 0 },
    ];
    let waiting = 0;
    let release = () => {};
    const together = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = (calls: { n: number }) =>
      withBinding(
        measured(t.testEnv(), calls),
        "ASSETS",
        (assets) =>
          new Proxy(assets, {
            get(target, prop) {
              if (prop !== "put") return forward(target, prop);
              return async (...args: Parameters<R2Bucket["put"]>) => {
                if (++waiting === 2) release();
                await together;
                return target.put(...args);
              };
            },
          }),
      );
    await Promise.all(
      runs.map((calls) => {
        const measuredEnv = held(calls);
        return sink.deliver(effect, measuredEnv, measuredEnv.ORG_READ);
      }),
    );
    for (const calls of runs) expect(calls.n).toBeLessThanOrEqual(reserved);
    // Its deliveries lost, made again from the stored body.
    await env.ORG_READ.prepare("DELETE FROM webhook_deliveries WHERE repo_id = ?")
      .bind(t.repo.id)
      .run();
    const recovered = { n: 0 };
    const recovering = measured(t.testEnv(), recovered);
    await sink.deliver(effect, recovering, recovering.ORG_READ);
    expect(recovered.n).toBeLessThanOrEqual(reserved);
    // Which run claims the first attempts depends on scheduling (measured: 11 and 19, or 8 and
    // 20): each within the reservation, each composing run reading its texts in one call.
    expect(runs.map((r) => r.blobReads)).toEqual([1, 1]);
    // The recovery, alone: 9 calls of the 27 reserved (measured).
    expect(recovered.n).toBe(9);
    expect(reserved).toBe(27);
  });

  it("make an event recorded without a capture its own body, as before", async () => {
    await t.createHook({ events: ["issues"] });
    await ok(api("POST", `${t.path}/issues`, t.owner.token, { title: "Old" }));
    const [opened] = await t.routed();
    if (!opened) throw new Error("no event");
    const { webhook: _capture, ...data } = opened.data ?? {};
    const [body] = await t.bodies([{ ...opened, data }]);
    expect(body).toMatchObject({ event: "issues", action: "opened", issue: { title: "Old" } });
    expect(body?.fyrden_payload).toBeUndefined();
  });

  it("keep text a change's events share once, and make each body with it", async () => {
    await t.createHook({ events: ["issues"] });
    const names = Array.from({ length: 20 }, (_, i) => `l${i}`);
    for (const name of names)
      await ok(api("POST", `${t.path}/labels`, t.owner.token, { name, color: "ffffff" }));
    const shared = "s".repeat(5_000);
    await ok(api("POST", `${t.path}/issues`, t.owner.token, { title: "Shared", body: shared }));
    await ok(api("PUT", `${t.path}/issues/1/labels`, t.owner.token, { labels: names }));
    const labeled = (await t.routed()).filter((e) => e.type === "issue.labeled");
    expect(labeled).toHaveLength(20);
    const kept = await runInDurableObject(t.stub(), (_, state) =>
      state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM webhook_blobs").one(),
    );
    // The body, once, for the opening and all twenty label events.
    expect(kept.n).toBe(1);
    for (const body of await t.bodies(labeled)) expect((body.issue as Body).body).toBe(shared);
  });

  for (const hooks of [0, 1, 20])
    it(`fan a 100-label replacement out to ${hooks} hooks: its deliveries, messages and writes`, async () => {
      for (let i = 0; i < hooks; i++) await t.createHook({ events: ["issues"] });
      const before = Array.from({ length: MAX_SUBJECT_LABELS }, (_, i) => `a${i}`);
      const after = Array.from({ length: MAX_SUBJECT_LABELS }, (_, i) => `b${i}`);
      for (const name of [...before, ...after])
        await ok(api("POST", `${t.path}/labels`, t.owner.token, { name, color: "ffffff" }));
      await countBlobWrites();
      await ok(
        api("POST", `${t.path}/issues`, t.owner.token, {
          title: "Relabeled",
          body: "r".repeat(5_000),
          labels: before,
        }),
      );
      // The issue's body kept once (a row and its index entry), when a hook takes the event.
      expect(blobWrites).toBe(hooks > 0 ? 2 : 0);
      const from = (await t.routed()).length;
      blobWrites = 0;
      await ok(api("PUT", `${t.path}/issues/1/labels`, t.owner.token, { labels: after }));
      // The replacement's 200 events name the same body at one deadline: it is kept longer at
      // most once (its row and index entry, when the clock moved since it was stored), not once
      // per event.
      expect(blobWrites).toBeLessThanOrEqual(hooks > 0 ? 2 : 0);
      const events = (await t.routed()).slice(from);
      // One event per label removed and per label added, each to every hook.
      expect(events).toHaveLength(hooks > 0 ? 2 * MAX_SUBJECT_LABELS : 0);
      if (hooks === 0) return;
      await t.materialize(events, 2);
      // Every hook a delivery of each event; the sink makes two first attempts per event (one
      // with a single hook), the others are a queue message each (3,600 for 20 hooks).
      const deliveries = (await t.deliveries()).filter((d) => d.event === "issues");
      expect(deliveries).toHaveLength(2 * MAX_SUBJECT_LABELS * hooks);
      expect(deliveries.filter((d) => d.state === "dropped")).toEqual([]);
      expect(t.received).toHaveLength(2 * MAX_SUBJECT_LABELS * Math.min(hooks, 2));
      expect(t.sent).toHaveLength(2 * MAX_SUBJECT_LABELS * Math.max(hooks - 2, 0));
      // A removal tells of the label it took off, in full.
      const removed = t.received
        .map((r) => JSON.parse(r.body) as Body)
        .find((b) => b.action === "unlabeled" && (b.label as Body).name === "a0");
      expect(removed).toMatchObject({ label: { name: "a0", color: "ffffff", default: false } });
    });
});
