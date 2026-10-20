import { env } from "cloudflare:workers";
import type { DomainEvent } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { afterEach, beforeEach, vi } from "vitest";
import type { RepoDO } from "../../src/do/RepoDO.js";
import { deliverEffects, invocationBudget } from "../../src/effects/dispatcher.js";
import { applyEnvelope } from "../../src/queues/events-consumer.js";
import type { DeliveryDeps } from "../../src/webhooks/deliver.js";
import { webhookSink } from "../../src/webhooks/sink.js";
import { api, json, user, type Who } from "./api.js";
import { recordingPublish } from "./effects.js";
import { inRepo } from "./repo-git.js";

/*
 * What the webhook tests share: each test's owner and repository, a
 * receiver (`fetch` stubbed for the test) whose answer the test sets, and
 * a stand-in for the webhooks queue whose messages are kept, not sent.
 * Deliveries are made and attempted by calling the code directly; the real
 * queue's consumer would make an attempt whenever it ran.
 */

export type HookOut = {
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

export type DeliveryRow = {
  delivery_id: string;
  hook_id: number;
  event: string;
  state: string;
  reason: string | null;
  attempts: number;
  last_status: number | null;
  private: number;
};

/** A public address the SSRF guard lets through (the receiver is `fetch`, stubbed). */
export const RECEIVER = "https://93.184.216.34/hook";

type Sent = { delivery: string; delaySeconds?: number };
type Received = { url: string; headers: Headers; body: string };
type World = { readonly owner: Who; readonly repo: { readonly id: string; readonly name: string } };

const ok = () => new Response("ok", { status: 200 });

/** One test's webhook world, made afresh before each test (see `webhookTest`). */
export class WebhookTest {
  #world: World | undefined;
  #answer: () => Response = ok;
  #sent: Sent[] = [];
  #received: Received[] = [];

  get #now(): World {
    if (!this.#world) throw new Error("a webhook test's world exists only while a test runs");
    return this.#world;
  }

  get owner(): Who {
    return this.#now.owner;
  }
  get repo(): World["repo"] {
    return this.#now.repo;
  }
  get path(): string {
    return `/repos/${this.owner.handle}/${this.repo.name}`;
  }
  /** Messages sent to the stand-in queue, in order. */
  get sent(): Sent[] {
    return this.#sent;
  }
  /** Requests the receiver got, in order. */
  get received(): readonly Received[] {
    return this.#received;
  }
  /** How the receiver answers from now on (200 "ok" until set). */
  set answer(answer: () => Response) {
    this.#answer = answer;
  }

  async setUp(): Promise<void> {
    this.#answer = ok;
    this.#sent = [];
    this.#received = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      this.#received.push({
        url: request.url,
        headers: request.headers,
        body: await request.text(),
      });
      return this.#answer();
    });
    const owner = await user();
    const repo = (
      await json<{ id: string; name: string }>(
        api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
      )
    ).body;
    this.#world = { owner, repo };
  }

  tearDown(): void {
    this.#world = undefined;
    vi.unstubAllGlobals();
  }

  stub() {
    return env.REPO.getByName(this.repo.id);
  }

  createHook(body: Record<string, unknown> = {}, who: Who = this.owner) {
    return json<HookOut>(
      api("POST", `${this.path}/hooks`, who.token, { config: { url: RECEIVER }, ...body }),
    );
  }

  /** The repository's outbox events, oldest first. */
  outbox(): Promise<DomainEvent[]> {
    return inRepo(this.stub(), (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ event: string }>("SELECT event FROM outbox ORDER BY source_seq")
        .toArray()
        .map((row) => JSON.parse(row.event) as DomainEvent),
    );
  }

  /** The environment with the stand-in queue (and effects queues that keep nothing). */
  testEnv(): Env {
    const sent = this.#sent;
    const kept = { send: async () => {}, sendBatch: async () => {} };
    return {
      ...env,
      EFFECTS_WEBHOOKS: kept,
      EFFECTS_FEED: kept,
      EFFECTS_REFERENCES: kept,
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
    } as unknown as Env;
  }

  /**
   * Makes the deliveries `events` call for, as the events consumer and the
   * webhook effects' queue would: the consumer journals the effects and
   * sends their ids, and the queue's consumer delivers them.
   */
  async materialize(events: DomainEvent[]): Promise<void> {
    const { publish, sent } = recordingPublish();
    await applyEnvelope(
      this.testEnv(),
      { sourceId: this.repo.id, events },
      { sinks: [webhookSink], publish },
    );
    for (let next = sent.shift(); next; next = sent.shift()) {
      const now = Date.now();
      await deliverEffects(
        { db: env.ORG_READ, env: this.testEnv(), sinks: [webhookSink], now: () => now, publish },
        next.sink,
        next.ids,
        invocationBudget(now),
      );
    }
  }

  /** This repository's deliveries, oldest first. */
  async deliveries(): Promise<DeliveryRow[]> {
    return (
      await env.ORG_READ.prepare(
        `SELECT delivery_id, hook_id, event, state, reason, attempts, last_status, private
         FROM webhook_deliveries WHERE repo_id = ? ORDER BY created_at, delivery_id`,
      )
        .bind(this.repo.id)
        .all<DeliveryRow>()
    ).results;
  }

  /** What an attempt or the cron runs with, at `now`, the receiver's host resolving publicly. */
  deps(now = Date.now()): DeliveryDeps {
    return {
      env: this.testEnv(),
      db: env.ORG_READ,
      now: () => now,
      resolver: () => async () => ["93.184.216.34"],
    };
  }
}

/** A `WebhookTest` set up before each test of the calling file and torn down after it. */
export function webhookTest(): WebhookTest {
  const t = new WebhookTest();
  beforeEach(() => t.setUp());
  afterEach(() => t.tearDown());
  return t;
}
