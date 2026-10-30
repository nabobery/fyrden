// The read model's maintenance: pausing its writers (the directory's barrier
// to the next generation, then the read model's, paused once no older lease is
// live) and resuming them; expired leases reaped; and, while the deployment's
// maintenance switch is on, ordinary work held back: API writes refused,
// queue messages put back for later, the crons and jobs that write the read
// model skipped.

import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  getQueueResult,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { runMaintenance } from "../src/cron/maintenance.js";
import worker from "../src/index.js";
import { EVENTS_QUEUE } from "../src/queues/events-consumer.js";
import { ReadModelRefused, ReadModelWriter } from "../src/read-model/executor.js";
import {
  barrierHooks,
  MAINTENANCE_RESEND_DELAY_SECONDS,
  pauseReadModel,
  reapExpiredLeases,
  resumeReadModel,
} from "../src/read-model/maintenance.js";
import { user } from "./helpers/api.js";
import { ORIGIN } from "./helpers/git-http.js";
import { leftAs, runningAgain } from "./helpers/read-model.js";

const org = env.ORG_READ;
const MAINTENANCE = { FYRDEN_READ_MODEL_MAINTENANCE: "on" };

const barriers = async () => ({
  directory: await env.DIRECTORY.prepare(
    "SELECT phase, generation FROM read_model_barriers WHERE shard = 'default'",
  ).first(),
  org: await org.prepare("SELECT phase, generation FROM read_model_barrier WHERE id = 1").first(),
});

const epochRow = (source: string) =>
  org
    .prepare("INSERT INTO consumer_epochs (source_id, epoch_gen, updated_at) VALUES (?, 1, 0)")
    .bind(source);

/** An env whose read model throws on any use: work that must not touch it. */
const untouchable = (overrides: object = {}) =>
  ({
    ...env,
    ...MAINTENANCE,
    ORG_READ: new Proxy(env.ORG_READ, {
      get() {
        throw new Error("the read model was used");
      },
    }),
    ...overrides,
  }) as Env;

/** The Worker's queue handler, with the context its results are read through. */
const consume = worker.queue as unknown as (
  batch: MessageBatch,
  env: Env,
  ctx: ExecutionContext,
) => Promise<void>;

/** The generation each test starts at (running): generations only go up. */
let g = 0;
beforeEach(async () => {
  await runningAgain(env);
  g =
    (
      await env.DIRECTORY.prepare(
        "SELECT generation FROM read_model_barriers WHERE shard = 'default'",
      ).first<{ generation: number }>()
    )?.generation ?? 0;
});

describe("pausing the read model's writers", () => {
  it("moves both barriers to the next generation, waits for older live leases, then resumes", async () => {
    const held = new ReadModelWriter(env, "default");
    await held.acquire();
    expect(await pauseReadModel(env, "default")).toMatchObject({
      phase: "pausing",
      generation: g + 1,
      live: 1,
      until: held.lease?.until,
    });
    expect(await barriers()).toEqual({
      directory: { phase: "pausing", generation: g + 1 },
      org: { phase: "pausing", generation: g + 1 },
    });
    // The held writer's batch is refused (its generation is over); no new lease is taken.
    const source = uniqueId("held");
    await expect(held.write([epochRow(source)])).rejects.toBeInstanceOf(ReadModelRefused);
    await expect(new ReadModelWriter(env, "default").write([epochRow(source)])).rejects.toThrow(
      ReadModelRefused,
    );
    // Again while it is live: still pausing; once it is released, paused.
    expect(await pauseReadModel(env, "default")).toMatchObject({ phase: "pausing", live: 1 });
    await held.release();
    expect(await pauseReadModel(env, "default")).toEqual({
      phase: "paused",
      generation: g + 1,
      live: 0,
      until: null,
    });
    expect(await barriers()).toEqual({
      directory: { phase: "paused", generation: g + 1 },
      org: { phase: "paused", generation: g + 1 },
    });
    // Paused stays paused, at the same generation.
    expect(await pauseReadModel(env, "default")).toMatchObject({
      phase: "paused",
      generation: g + 1,
    });
    expect(await resumeReadModel(env, "default")).toEqual({ phase: "running", generation: g + 1 });
    expect(await barriers()).toEqual({
      directory: { phase: "running", generation: g + 1 },
      org: { phase: "running", generation: g + 1 },
    });
    const writer = new ReadModelWriter(env, "default");
    await writer.write([epochRow(source)]);
    await writer.release();
    expect(
      await org
        .prepare("SELECT epoch_gen FROM consumer_epochs WHERE source_id = ?")
        .bind(source)
        .first(),
    ).toEqual({ epoch_gen: 1 });
  });

  it("counts a lease taken before the pause, and grants none after it", async () => {
    const before = new ReadModelWriter(env, "default");
    await before.acquire();
    await pauseReadModel(env, "default");
    const after = new ReadModelWriter(env, "default");
    await expect(after.acquire()).rejects.toBeInstanceOf(ReadModelRefused);
    expect(await pauseReadModel(env, "default")).toMatchObject({ live: 1 });
    await before.release();
    expect(await pauseReadModel(env, "default")).toMatchObject({ phase: "paused" });
  });

  it("never lowers the read model's generation when it resumes", async () => {
    // The read model ahead of the directory (as after a restore of the directory).
    await leftAs(
      env,
      { phase: "paused", generation: g + 1 },
      { phase: "paused", generation: g + 4 },
    );
    expect(await resumeReadModel(env, "default")).toEqual({
      phase: "running",
      generation: g + 4,
    });
    expect(await barriers()).toEqual({
      directory: { phase: "running", generation: g + 4 },
      org: { phase: "running", generation: g + 4 },
    });
  });

  it("pauses past a read model ahead of the directory", async () => {
    await leftAs(env, { phase: "running", generation: g }, { phase: "running", generation: g + 4 });
    expect(await pauseReadModel(env, "default")).toMatchObject({
      phase: "paused",
      generation: g + 5,
    });
    expect(await barriers()).toEqual({
      directory: { phase: "paused", generation: g + 5 },
      org: { phase: "paused", generation: g + 5 },
    });
  });

  it("refuses while the barrier is recovering, and leaves a running one as it is on resume", async () => {
    expect(await resumeReadModel(env, "default")).toEqual({ phase: "running", generation: g });
    await env.DIRECTORY.prepare(
      "UPDATE read_model_barriers SET phase = 'recovering' WHERE shard = 'default'",
    ).run();
    await expect(pauseReadModel(env, "default")).rejects.toThrow("recovering");
  });
});

describe("pausing and resuming at once", () => {
  afterEach(() => {
    delete barrierHooks.beforeChange;
    delete barrierHooks.afterPausing;
  });

  it("leaves a resume that comes before a pause's last change standing, and the pause says so", async () => {
    barrierHooks.beforeChange = async (step) => {
      if (step !== "pause") return;
      delete barrierHooks.beforeChange;
      await resumeReadModel(env, "default");
    };
    expect(await pauseReadModel(env, "default")).toMatchObject({
      phase: "running",
      generation: g + 1,
    });
    expect(await barriers()).toEqual({
      directory: { phase: "running", generation: g + 1 },
      org: { phase: "running", generation: g + 1 },
    });
  });

  it("leaves a resume that comes right after a pause's first change standing, and the pause says so", async () => {
    barrierHooks.afterPausing = async () => {
      delete barrierHooks.afterPausing;
      await resumeReadModel(env, "default");
    };
    expect(await pauseReadModel(env, "default")).toMatchObject({
      phase: "running",
      generation: g + 1,
    });
    expect(await barriers()).toEqual({
      directory: { phase: "running", generation: g + 1 },
      org: { phase: "running", generation: g + 1 },
    });
  });

  it("leaves a newer pause standing when a resume decided before it changes the barriers", async () => {
    await pauseReadModel(env, "default");
    await pauseReadModel(env, "default");
    barrierHooks.beforeChange = async (step) => {
      if (step !== "resume") return;
      delete barrierHooks.beforeChange;
      // Another resume, and a newer pause, between this one's look and its changes.
      await resumeReadModel(env, "default");
      await pauseReadModel(env, "default");
      await pauseReadModel(env, "default");
    };
    expect(await resumeReadModel(env, "default")).toEqual({ phase: "paused", generation: g + 2 });
    expect(await barriers()).toEqual({
      directory: { phase: "paused", generation: g + 2 },
      org: { phase: "paused", generation: g + 2 },
    });
  });
});

describe("a pause or a resume interrupted between its two changes", () => {
  /** The directory's barrier and the read model's as an interrupted step left them. */
  const left = (directory: string, local: string, generation = g + 1) =>
    leftAs(env, { phase: directory, generation }, { phase: local, generation });

  afterEach(() => {
    delete barrierHooks.beforeChange;
    delete barrierHooks.afterPausing;
  });

  it("is finished by the next pause, at its generation", async () => {
    await left("paused", "pausing");
    expect(await pauseReadModel(env, "default")).toMatchObject({
      phase: "paused",
      generation: g + 1,
    });
    expect(await barriers()).toEqual({
      directory: { phase: "paused", generation: g + 1 },
      org: { phase: "paused", generation: g + 1 },
    });
  });

  it("is fenced off by the next pause when it was a resume, or finished by the next resume", async () => {
    await left("paused", "running");
    expect(await pauseReadModel(env, "default")).toMatchObject({
      phase: "paused",
      generation: g + 2,
    });
    expect(await barriers()).toEqual({
      directory: { phase: "paused", generation: g + 2 },
      org: { phase: "paused", generation: g + 2 },
    });
    await left("paused", "running", g + 3);
    expect(await resumeReadModel(env, "default")).toEqual({ phase: "running", generation: g + 3 });
    expect(await barriers()).toEqual({
      directory: { phase: "running", generation: g + 3 },
      org: { phase: "running", generation: g + 3 },
    });
  });

  it("opens no lease admission when a pause finishes between a resume's look and its changes", async () => {
    await left("paused", "pausing");
    barrierHooks.beforeChange = async (step) => {
      if (step !== "resume") return;
      delete barrierHooks.beforeChange;
      await pauseReadModel(env, "default");
    };
    expect(await resumeReadModel(env, "default")).toEqual({ phase: "paused", generation: g + 1 });
    expect(await barriers()).toEqual({
      directory: { phase: "paused", generation: g + 1 },
      org: { phase: "paused", generation: g + 1 },
    });
  });
});

describe("expired leases", () => {
  it("are reaped, and live ones kept", async () => {
    const live = new ReadModelWriter(env, "default");
    await live.acquire();
    const lost = new ReadModelWriter(env, "default");
    await lost.acquire();
    await env.DIRECTORY.prepare("UPDATE read_model_writers SET until = 1 WHERE lease_id = ?")
      .bind(lost.lease?.id)
      .run();
    expect(await reapExpiredLeases(env)).toBe(1);
    const left = await env.DIRECTORY.prepare("SELECT lease_id FROM read_model_writers").all();
    expect(left.results).toEqual([{ lease_id: live.lease?.id }]);
    await live.release();
  });
});

describe("the read model's maintenance switch", () => {
  it("refuses API writes, and still serves reads", async () => {
    const who = await user();
    const call = async (method: string, path: string, body?: unknown) => {
      const ctx = createExecutionContext();
      const response = await createApp().fetch(
        new Request(`${ORIGIN}/api${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${who.token}`,
            ...(body !== undefined && { "Content-Type": "application/json" }),
          },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        }),
        { ...env, ...MAINTENANCE },
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return response;
    };
    const write = await call("POST", "/user/repos", { name: uniqueId("held") });
    expect(write.status).toBe(503);
    expect(write.headers.get("Retry-After")).toBe("300");
    expect(await write.json()).toMatchObject({ code: "read_model_maintenance" });
    expect((await call("GET", "/user")).status).toBe(200);
  });

  it("refuses pushes, saying why where git prints it", async () => {
    const discovery = createExecutionContext();
    const advertised = await createApp().fetch(
      new Request(`${ORIGIN}/someone/repo.git/info/refs?service=git-receive-pack`),
      { ...env, ...MAINTENANCE },
      discovery,
    );
    await waitOnExecutionContext(discovery);
    expect(new TextDecoder().decode(await advertised.arrayBuffer())).toContain(
      "ERR Pushes are paused for maintenance",
    );
    const ctx = createExecutionContext();
    const response = await createApp().fetch(
      new Request(`${ORIGIN}/someone/repo.git/git-receive-pack`, {
        method: "POST",
        headers: { "Content-Type": "application/x-git-receive-pack-request" },
        body: new Uint8Array(4),
      }),
      { ...env, ...MAINTENANCE },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("300");
  });

  it("leaves an abandoned generation as it is (settling it deletes from the read model)", async () => {
    const owner = await user();
    const id = uniqueId("rep");
    await env.DIRECTORY.prepare(
      `INSERT INTO repos (id, owner_id, name, network_id, org_shard, visibility, state, created_at,
         updated_at, generating_since)
       VALUES (?, ?, ?, ?, 'default', 'private', 'active', 0, 0, 1)`,
    )
      .bind(id, owner.principalId, id.toLowerCase(), uniqueId("net"))
      .run();
    const since = () =>
      env.DIRECTORY.prepare("SELECT generating_since AS since FROM repos WHERE id = ?")
        .bind(id)
        .first<{ since: number | null }>();
    const metrics = { count() {}, gauge() {}, timing() {} } as unknown as Parameters<
      typeof runMaintenance
    >[1];
    await runMaintenance({ ...env, ...MAINTENANCE } as Env, metrics).catch(() => {});
    expect(await since()).toEqual({ since: 1 });
    // Without maintenance it is settled (its object never confirms it).
    await runMaintenance(env, metrics).catch(() => {});
    expect(await since()).not.toEqual({ since: 1 });
  });

  it("puts a queue's messages back for later, acknowledged once sent", async () => {
    const sent: {
      body: unknown;
      delaySeconds: number | undefined;
      contentType: string | undefined;
    }[] = [];
    const queue = {
      send: async (body: unknown, options?: { delaySeconds?: number; contentType?: string }) => {
        sent.push({ body, delaySeconds: options?.delaySeconds, contentType: options?.contentType });
      },
    };
    const batch = createMessageBatch(EVENTS_QUEUE, [
      { id: "m1", timestamp: new Date(), attempts: 3, body: { sourceId: "rep_1", events: [] } },
      // A body JSON could not carry (no producer sends one): by structured clone.
      { id: "m2", timestamp: new Date(), attempts: 1, body: { sourceId: "rep_2", n: 2n } },
    ]);
    const ctx = createExecutionContext();
    await consume(batch, untouchable({ EVENTS: queue }), ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks.sort()).toEqual(["m1", "m2"]);
    expect(result.retryMessages).toEqual([]);
    const delaySeconds = MAINTENANCE_RESEND_DELAY_SECONDS;
    expect(sent).toEqual([
      { body: { sourceId: "rep_1", events: [] }, delaySeconds, contentType: "json" },
      { body: { sourceId: "rep_2", n: 2n }, delaySeconds, contentType: "v8" },
    ]);
  });

  it("retries a message it could not put back", async () => {
    const queue = {
      send: async () => {
        throw new Error("queue unavailable");
      },
    };
    const batch = createMessageBatch("fyrden-effects-feed", [
      { id: "m1", timestamp: new Date(), attempts: 1, body: { v: 1, sink: "feed", ids: ["e"] } },
    ]);
    const ctx = createExecutionContext();
    await consume(batch, untouchable({ EFFECTS_FEED: queue }), ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toMatchObject([{ msgId: "m1" }]);
  });

  it("keeps the effects cron and the maintenance tasks that write the read model from starting", async () => {
    const effectsCron = createScheduledController({ cron: "2-59/5 * * * *" });
    await worker.scheduled?.(effectsCron, untouchable());
    await expect(
      worker.scheduled?.(effectsCron, untouchable({ FYRDEN_READ_MODEL_MAINTENANCE: "off" })),
    ).rejects.toThrow("tasks failed");
    // The maintenance's other tasks still run; none of those that write the read model do (with
    // the switch off, they do).
    const metrics = { count() {}, gauge() {}, timing() {} } as unknown as Parameters<
      typeof runMaintenance
    >[1];
    await runMaintenance(untouchable(), metrics);
    await expect(
      runMaintenance(untouchable({ FYRDEN_READ_MODEL_MAINTENANCE: "off" }), metrics),
    ).rejects.toThrow("scheduled task");
  });
});
