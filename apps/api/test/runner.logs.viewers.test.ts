// Watching a job's log live: a ticket (`actions.runs.jobs.live_ticket`), then
// a WebSocket upgrade on the run's object that sends the job's masked rows in
// order, each once, from stored chunks and from what the latest log request
// settled, rechecking the credential and the repository access before sending
// once 60 s have passed, within a window of unacknowledged frames, and ending
// once the log is closed. Interleavings are driven by hooks on the object's
// module (an R2 read held, a clock moved before a send), never by time.
import {
  createExecutionContext,
  evictDurableObject,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { hashToken } from "@fyrden/domain";
import { isLogOmission, LOG_ROW_TOO_LARGE, type StoredLogLine } from "@fyrden/domain/ci";
import { uniqueId } from "@fyrden/testing";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { OrgDO } from "../src/do/OrgDO.js";
import { LOG_LATE_MS } from "../src/do/run/logs.js";
import {
  LOG_VIEWER_POLICY,
  VIEWER_READ_PROGRESS,
  type ViewerAttachment,
  viewerHooks,
} from "../src/do/run/viewers.js";
import { ticketHash } from "../src/do/user/live.js";
import { randomSecret } from "../src/oauth/params.js";
import { SESSION_COOKIE } from "../src/oauth/session.js";
import { type LogRow, Result } from "../src/runner/proto/messages.js";
import { agentFor } from "./helpers/agents.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { insertPlainMask } from "./helpers/log-masks.js";
import { testSession } from "./helpers/oauth.js";
import {
  decodeUpdateLogResponse,
  encodeLogRow,
  encodeUpdateLogRequest,
} from "./helpers/runner-proto.js";
import {
  type Credentials,
  fetchTask,
  jobTokenOf,
  orgRepo,
  proto,
  registerRunner,
  runnerCall,
  taskRow,
  updateTask,
} from "./helpers/runners.js";
import {
  at,
  drain,
  inRun,
  job,
  jobNamed,
  now,
  runStub,
  started,
  workflow,
} from "./helpers/runs.js";

const ORIGIN = "https://fyrden.test";
const one = workflow(job("a"));
const KIB = 1024;
const MIB = 1024 * KIB;

afterEach(() => {
  for (const key of Object.keys(viewerHooks)) delete viewerHooks[key as keyof typeof viewerHooks];
  installCounters();
});

// ------------------------------------------------------------------ counting what the object sends

/** Frames each socket was sent (by socket id), messages and rechecks each run's object handled. */
const sent = new Map<string, number>();
const sentBytes = new Map<string, number>();
const messages = new Map<string, number>();
const rechecks = new Map<string, number>();
const charged = new Map<string, { gets: number; bytes: number }>();
const chargedTo = (socket: string) => charged.get(socket) ?? { gets: 0, bytes: 0 };
function installCounters() {
  viewerHooks.readCharged = (socket, charge) => {
    const was = chargedTo(socket);
    charged.set(socket, { gets: was.gets + charge.gets, bytes: was.bytes + charge.bytes });
  };
  viewerHooks.afterSend = (socket, frame) => {
    sent.set(socket, (sent.get(socket) ?? 0) + 1);
    sentBytes.set(socket, (sentBytes.get(socket) ?? 0) + new TextEncoder().encode(frame).length);
  };
  viewerHooks.messageHandled = (runId) => messages.set(runId, (messages.get(runId) ?? 0) + 1);
  viewerHooks.beforeRecheck = (runId) => {
    rechecks.set(runId, (rechecks.get(runId) ?? 0) + 1);
  };
}
installCounters();

// ------------------------------------------------------------------ runs, runners and log rows

interface Task {
  f: Awaited<ReturnType<typeof orgRepo>>;
  runId: string;
  runner: Credentials;
  wire: number;
  number: number;
  jobId: number;
  token: string;
}

/** A run of one job in a new organization, with a runner holding its task. */
async function withTask(source = one): Promise<Task> {
  const f = await orgRepo();
  const runId = await started(f, source);
  const runner = await registerRunner(f.org.login, f.owner);
  const task = (await fetchTask(runner, 0)).task;
  if (!task) throw new Error("no task");
  const number = (await taskRow(task.id))?.task;
  if (typeof number !== "number") throw new Error("the task was not recorded");
  const { jobId } = await jobNamed(runId, "a");
  return { f, runId, runner, wire: task.id, number, jobId, token: jobTokenOf(task) };
}

const row = (content: string, ms?: number): LogRow =>
  ms === undefined
    ? { content }
    : { content, time: { seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 } };
/** Filler rows `[from, from + n)`. */
const filler = (from: number, n: number, ms?: number): LogRow[] =>
  Array.from({ length: n }, (_, k) => row(`line ${from + k}`, ms));

type LogRequest = { taskId: number; index: number; rows?: LogRow[]; noMore?: boolean };

async function ackOf(runner: Credentials, request: LogRequest): Promise<number> {
  const res = await runnerCall("UpdateLog", encodeUpdateLogRequest(request), {
    credentials: runner,
  });
  return decodeUpdateLogResponse(await proto(res)).ackIndex;
}

/** The runner as it behaves: it keeps every row past its ack and resends them with each call. */
function runnerModel(t: Task) {
  const rows: LogRow[] = [];
  let ack = 0;
  return {
    rows,
    get ack() {
      return ack;
    },
    async send(more: LogRow[] = [], noMore = false) {
      rows.push(...more);
      ack = await ackOf(t.runner, {
        taskId: t.wire,
        index: ack,
        rows: rows.slice(ack),
        noMore,
      });
      return ack;
    },
  };
}

interface Line {
  i: number;
  t: number | null;
  c: string;
}

/** The stored NDJSON lines of every chunk the manifest names, contiguous from 0. */
async function storedText(runId: string, task: number): Promise<string[]> {
  const chunks = await inRun(runId, (r) =>
    r.engine.rows<{ start_index: number; end_index: number; r2_key: string }>(
      "SELECT start_index, end_index, r2_key FROM ci_log_chunks WHERE task = ? ORDER BY start_index",
      task,
    ),
  );
  const lines: string[] = [];
  let next = 0;
  for (const chunk of chunks) {
    expect(chunk.start_index).toBe(next);
    const object = await env.CI.get(chunk.r2_key);
    if (!object) throw new Error(`the manifest names ${chunk.r2_key}, which is not stored`);
    lines.push(...(await object.text()).split("\n").filter((l) => l !== ""));
    next = chunk.end_index;
  }
  return lines;
}

// ------------------------------------------------------------------ tickets, upgrades and clients

/** One request through the Worker. */
async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await createApp().fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const livePath = (path: string, runId: string, jobId: number) =>
  `${path}/actions/runs/${runId}/jobs/${jobId}/logs/live`;

function ticketCall(t: Pick<Task, "f" | "runId" | "jobId">, token: string, path = t.f.path) {
  return json<{ ticket: string; expires_in: number; url: string; code?: string }>(
    api("POST", livePath(path, t.runId, t.jobId), token),
  );
}

async function ticketOf(t: Pick<Task, "f" | "runId" | "jobId">, token: string) {
  const issued = await ticketCall(t, token);
  expect(issued.status).toBe(200);
  return issued.body.ticket;
}

/** Each upgrade from its own address, so no test meets another's rate limit. */
const address = () => {
  const n = Number.parseInt(uniqueId("").replace(/\D/g, "").slice(-6) || "1", 10);
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
};

interface UpgradeOptions {
  token?: string;
  cookie?: string;
  origin?: string;
  from?: string | number;
  headers?: Record<string, string>;
  path?: string;
  upgrade?: boolean;
  /** Whether the object's first check of the socket runs before it is returned (default true). */
  checked?: boolean;
}

function upgrade(
  t: Pick<Task, "f" | "runId" | "jobId">,
  ticket: string,
  options: UpgradeOptions = {},
): Promise<Response> {
  const from = options.from === undefined ? "" : `&from=${options.from}`;
  return call(
    new Request(
      `${ORIGIN}/api${livePath(options.path ?? t.f.path, t.runId, t.jobId)}?ticket=${encodeURIComponent(ticket)}${from}`,
      {
        headers: {
          ...(options.upgrade !== false && { Upgrade: "websocket" }),
          "CF-Connecting-IP": address(),
          ...(options.token !== undefined && { Authorization: `Bearer ${options.token}` }),
          ...(options.cookie !== undefined && { Cookie: options.cookie }),
          ...(options.origin !== undefined && { Origin: options.origin }),
          ...options.headers,
        },
      },
    ),
  );
}

type Frame =
  | { t: "rows"; rows: StoredLogLine[] }
  | { t: "part"; i: number; o: number; c: string; end: boolean; ts?: number | null }
  | { t: "end"; log: "complete" | "incomplete"; durable: number; unfinished?: number }
  | { t: string; [key: string]: unknown };

interface Client {
  ws: WebSocket;
  /** The socket's id in the object (the first 16 hex chars of its ticket's hash). */
  id: string;
  frames: Frame[];
  texts: string[];
  closed: Promise<{ code: number }>;
  code: number | null;
}

/** A socket that `token` opened on the job's log, its frames collected. */
async function watch(
  t: Pick<Task, "f" | "runId" | "jobId">,
  token: string,
  options: UpgradeOptions = {},
): Promise<Client> {
  const ticket = await ticketOf(t, token);
  const response = await upgrade(t, ticket, { token, ...options });
  expect(response.status).toBe(101);
  const c = await client(response, ticket);
  // A socket opens unchecked: the object's own check (the job's first run) comes before any row.
  if (options.checked !== false) await slice(t.runId);
  return c;
}

async function client(response: Response, ticket: string): Promise<Client> {
  const ws = response.webSocket;
  if (!ws) throw new Error(`no socket: ${response.status}`);
  ws.accept();
  const c: Client = {
    ws,
    id: (await ticketHash(ticket)).slice(0, 16),
    frames: [],
    texts: [],
    closed: Promise.resolve({ code: 0 }),
    code: null,
  };
  ws.addEventListener("message", (event) => {
    const text = String(event.data);
    if (text === "pong") return;
    c.texts.push(text);
    c.frames.push(JSON.parse(text) as Frame);
    for (const w of waiters.splice(0)) w();
  });
  c.closed = new Promise((resolve) =>
    ws.addEventListener("close", (event) => {
      c.code = event.code;
      resolve({ code: event.code });
      for (const w of waiters.splice(0)) w();
    }),
  );
  return c;
}

const waiters: (() => void)[] = [];
/** Waits (on message events, never a timer) until `c` received every frame its socket was sent. */
async function settle(c: Client): Promise<void> {
  while (c.frames.length < (sent.get(c.id) ?? 0) && c.code === null)
    await new Promise<void>((resolve) => waiters.push(resolve));
  expect(c.frames.length).toBe(sent.get(c.id) ?? 0);
}

/** The rows `c` received, parts joined, checked contiguous from `from`. */
function receivedLines(c: Client, from = 0): StoredLogLine[] {
  const lines: StoredLogLine[] = [];
  let part: Line | null = null;
  for (const frame of c.frames) {
    if (frame.t === "rows") lines.push(...(frame as { rows: StoredLogLine[] }).rows);
    else if (frame.t === "part") {
      const p = frame as Extract<Frame, { t: "part" }>;
      if (p.o === 0) {
        expect(part).toBeNull();
        part = { i: p.i, t: p.ts ?? null, c: "" };
      }
      if (!part) throw new Error("a part with no first part");
      expect(p.i).toBe(part.i);
      expect(p.o).toBe(part.c.length);
      part.c += p.c;
      if (p.end) {
        lines.push(part);
        part = null;
      }
    }
  }
  expect(lines.map((l) => l.i)).toEqual(Array.from({ length: lines.length }, (_, k) => from + k));
  return lines;
}

function received(c: Client, from = 0): Line[] {
  const lines = receivedLines(c, from);
  expect(lines.every((line) => !isLogOmission(line))).toBe(true);
  return lines.filter((line): line is Line => !isLogOmission(line));
}

const endOf = (c: Client) =>
  c.frames.find((f) => f.t === "end") as Extract<Frame, { t: "end" }> | undefined;

/** The next position `c` expects, as its ack names it. */
function position(c: Client): { i: number; o: number } {
  let pos = { i: -1, o: 0 };
  for (const frame of c.frames) {
    if (frame.t === "rows") {
      const rows = (frame as { rows: StoredLogLine[] }).rows;
      pos = { i: (rows.at(-1) as StoredLogLine).i + 1, o: 0 };
    } else if (frame.t === "part") {
      const p = frame as Extract<Frame, { t: "part" }>;
      pos = p.end ? { i: p.i + 1, o: 0 } : { i: p.i, o: p.o + p.c.length };
    }
  }
  return pos;
}

/** The position after `c`'s first `n` frames. */
function positionAfter(c: Client, n: number): { i: number; o: number } {
  return position({ ...c, frames: c.frames.slice(0, n) });
}

/** Sends `message` and waits (bounded round trips to the object) until the object handled it. */
async function say(runId: string, c: Client, message: unknown): Promise<void> {
  const before = messages.get(runId) ?? 0;
  c.ws.send(typeof message === "string" ? message : JSON.stringify(message));
  for (let i = 0; i < 200 && (messages.get(runId) ?? 0) <= before && c.code === null; i++)
    await runInDurableObject(runStub(runId), () => {});
}

/** Acknowledges everything `c` received. */
async function ackAll(runId: string, c: Client): Promise<void> {
  await settle(c);
  const p = position(c);
  if (p.i >= 0) await say(runId, c, { t: "ack", i: p.i, o: p.o });
}

/**
 * A point a hook in the run's object waits at until released. The test learns it was reached
 * by round trips to the object, not by the hook resolving a promise of the test's: a test
 * resumed from inside the object would go on in the object's I/O context, where the test's
 * sockets cannot be used.
 */
function hold(runId: string) {
  let reached = false;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release,
    hold: async () => {
      reached = true;
      await released;
    },
    /** Waits (bounded round trips) until the hook is reached, or `done` settles first. */
    reached: async (done: Promise<unknown>) => {
      let settled = false;
      void done.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      for (let i = 0; i < 500 && !reached && !settled; i++)
        await runInDurableObject(runStub(runId), () => {});
      return reached;
    },
  };
}

const attachments = (runId: string): Promise<ViewerAttachment[]> =>
  inRun(runId, (r) => r.viewers.attachments());

/** Runs the viewers' slice (and anything else due) until nothing is due at the run's clock. */
const slice = (runId: string) => drain(runId);

/** A reset of the object's memory (as a hibernation wake leaves it): only the settled cache is lost. */
const forget = (runId: string) => inRun(runId, (r) => r.viewers.dropCaches());

/** Expects every line `c` received to be byte-identical to the stored one. */
async function expectStored(t: Task, c: Client, from = 0) {
  const stored = await storedText(t.runId, t.number);
  const lines = receivedLines(c, from);
  expect(lines.map((l) => JSON.stringify(l))).toEqual(stored.slice(from, from + lines.length));
}

describe("pre-masking log history", () => {
  for (const state of ["complete", "incomplete"] as const) {
    it(`hides a sealed ${state} legacy log without reading its objects or accepting more rows`, async () => {
      const t = await withTask();
      const runner = runnerModel(t);
      expect(await runner.send(filler(0, 50))).toBe(50);
      const key = await inRun(t.runId, (r) => {
        const key = r.engine.rows<{ r2_key: string }>(
          "SELECT r2_key FROM ci_log_chunks WHERE task = ?",
          t.number,
        )[0]?.r2_key;
        if (!key) throw new Error("no stored chunk");
        r.engine.exec("DELETE FROM ci_log_masks WHERE task = ?", t.number);
        r.engine.exec(
          "UPDATE ci_logs SET unmasked = 1, finalized = 1, state = ? WHERE task = ?",
          state === "complete" ? "complete" : "incomplete",
          t.number,
        );
        return key;
      });
      const history = `${Array.from({ length: 50 }, (_, i) =>
        JSON.stringify({ i, t: null, c: i === 0 ? t.token : `old line ${i}` }),
      ).join("\n")}\n`;
      await env.CI.put(key, history);
      await inRun(t.runId, (r) =>
        r.engine.exec(
          "UPDATE ci_log_chunks SET bytes = ? WHERE r2_key = ?",
          new TextEncoder().encode(history).byteLength,
          key,
        ),
      );
      await evictDurableObject(runStub(t.runId));
      await at(t.runId, now(t.runId));
      let gets = 0;
      let published = 0;
      let puts = 0;
      await inRun(t.runId, (r) => {
        r.hooks.afterLogPut = () => {
          puts++;
        };
      });
      viewerHooks.afterChunkGet = () => {
        gets++;
      };
      viewerHooks.beforePublish = () => {
        published++;
      };
      const socket = await watch(t, t.f.owner.token);
      expect(await socket.closed).toEqual({ code: 1000 });
      expect(receivedLines(socket).length).toBe(0);
      expect(endOf(socket)).toEqual({ t: "end", log: "incomplete", durable: 0 });
      expect(gets).toBe(0);
      expect(await runner.send([row(t.token)], true)).toBe(50);
      expect(published).toBe(0);
      expect(puts).toBe(0);
      expect(
        await inRun(t.runId, (r) =>
          r.engine.rows(
            "SELECT ack_index, rows, unmasked, finalized FROM ci_logs WHERE task = ?",
            t.number,
          ),
        ),
      ).toEqual([{ ack_index: 50, rows: 50, unmasked: 1, finalized: 1 }]);
      expect((await env.CI.get(key)) !== null).toBe(true);
      await expect((await env.CI.get(key))?.text().then((text) => text === history)).resolves.toBe(
        true,
      );
      expect(
        await inRun(t.runId, (r) =>
          r.engine.rows("SELECT COUNT(*) AS n FROM ci_log_chunks WHERE task = ?", t.number),
        ),
      ).toEqual([{ n: 1 }]);
    });
  }

  it("keeps an unconfirmed legacy re-offer sealed, while a new task is masked normally", async () => {
    const t = await withTask(workflow([job("a"), job("b")].join("\n")));
    await inRun(t.runId, (r) => {
      r.engine.exec("DELETE FROM ci_log_masks WHERE task = ?", t.number);
      r.engine.exec(
        "INSERT INTO ci_logs (task, state, updated_at, unmasked, finalized) VALUES (?, 'incomplete', ?, 1, 1)",
        t.number,
        now(t.runId),
      );
    });
    const offered = await taskRow(t.wire);
    if (!offered) throw new Error("no task mapping");
    const repeated = await runStub(t.runId).assignTask(
      t.wire,
      t.jobId,
      offered.runner_id,
      t.f.org.id,
    );
    expect("task" in repeated).toBe(true);
    expect(
      await inRun(t.runId, (r) =>
        r.engine.rows("SELECT COUNT(*) AS n FROM ci_log_masks WHERE task = ?", t.number),
      ),
    ).toEqual([{ n: 0 }]);
    expect(
      await ackOf(t.runner, { taskId: t.wire, index: 0, rows: [row(t.token)], noMore: true }),
    ).toBe(0);
    const otherRunner = await registerRunner(t.f.org.login, t.f.owner);
    const fresh = (await fetchTask(otherRunner, 0)).task;
    if (!fresh) throw new Error("no new task");
    const freshNumber = (await taskRow(fresh.id))?.task;
    expect(freshNumber).not.toBe(t.number);
    expect(
      await ackOf(otherRunner, {
        taskId: fresh.id,
        index: 0,
        rows: [row(jobTokenOf(fresh))],
        noMore: true,
      }),
    ).toBe(1);
    const stored = await storedText(t.runId, freshNumber as number);
    expect(stored.length).toBe(1);
    expect(JSON.parse(stored[0] as string).c === "***").toBe(true);
  });
});

// ------------------------------------------------------------------ the ticket

describe("the ticket operation", () => {
  it("issues a 30 s ticket to an actions:read holder, with the socket's address", async () => {
    const t = await withTask();
    const issued = await ticketCall(t, t.f.owner.token);
    expect(issued.status).toBe(200);
    // 30 s less the time to store and admit it, on the operation's own clock.
    expect(issued.body.expires_in).toBeGreaterThan(0);
    expect(issued.body.expires_in).toBeLessThanOrEqual(30);
    expect(issued.body.url).toBe(
      `wss://fyrden.test/api${livePath(t.f.path, t.runId, t.jobId)}?ticket=${encodeURIComponent(issued.body.ticket)}`,
    );
    const rows = await inRun(t.runId, (r) =>
      r.engine.rows<{ hash: string; job_id: number; expires_at: number }>(
        "SELECT hash, job_id, expires_at FROM ci_log_tickets",
      ),
    );
    expect(rows).toEqual([
      {
        hash: await ticketHash(issued.body.ticket),
        job_id: t.jobId,
        expires_at: now(t.runId) + 30_000,
      },
    ]);
  });

  it("keeps a failed pre-write run lookup retryable with the same key", async () => {
    const t = await withTask();
    const unavailable = {
      ...env,
      RUN: {
        getByName() {
          return {
            get: async () => {
              throw new Error("run transport unavailable");
            },
          };
        },
      },
    };
    const key = crypto.randomUUID();
    const request = () =>
      new Request(`${ORIGIN}/api${livePath(t.f.path, t.runId, t.jobId)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${t.f.owner.token}`,
          "Idempotency-Key": key,
          "CF-Connecting-IP": address(),
        },
      });
    const ctx = createExecutionContext();
    const response = await createApp().fetch(request(), unavailable as unknown as Env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "run_lookup_unavailable" });
    const retry = createExecutionContext();
    const answer = await createApp().fetch(request(), env, retry);
    await waitOnExecutionContext(retry);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ ticket: expect.any(String) });
  });

  it("answers a principal without access as if the repository did not exist", async () => {
    const t = await withTask();
    const stranger = await user();
    expect(await ticketCall(t, stranger.token)).toMatchObject({
      status: 404,
      body: { code: "repo_not_found" },
    });
  });

  it("keeps an uncertain ticket write unknown for the original key", async () => {
    const t = await withTask();
    const uncertain = {
      ...env,
      RUN: {
        getByName(id: string) {
          const run = env.RUN.getByName(id);
          return {
            get: () => run.get(),
            storeLogTicket: async (input: Parameters<typeof run.storeLogTicket>[0]) => {
              await run.storeLogTicket(input);
              throw new Error("ticket response lost after commit");
            },
          };
        },
      },
    };
    const key = crypto.randomUUID();
    const request = () =>
      new Request(`${ORIGIN}/api${livePath(t.f.path, t.runId, t.jobId)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${t.f.owner.token}`,
          "Idempotency-Key": key,
          "CF-Connecting-IP": address(),
        },
      });
    const ctx = createExecutionContext();
    const response = await createApp().fetch(request(), uncertain as unknown as Env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "run_unavailable" });
    const retry = createExecutionContext();
    const answer = await createApp().fetch(request(), env, retry);
    await waitOnExecutionContext(retry);
    expect(answer.status).toBe(409);
    expect(await answer.json()).toMatchObject({ code: "idempotent_outcome_unknown" });
    expect(
      await inRun(t.runId, (r) => r.engine.rows("SELECT hash FROM ci_log_tickets")),
    ).toHaveLength(1);
  });

  it("admits an organization owner past the live team-grant bound", async () => {
    const t = await withTask();
    await runInDurableObject(env.ORG.getByName(t.f.org.id), (_org: OrgDO, state) => {
      for (let i = 0; i < 101; i++) {
        state.storage.sql.exec(
          "INSERT INTO teams (team_id, slug, name, created_at) VALUES (?, ?, ?, 0)",
          `tm_owner${i}`,
          `owner-${i}`,
          `Owner ${i}`,
        );
        state.storage.sql.exec(
          "INSERT INTO team_repos (team_id, repo_id, role, added_at) VALUES (?, ?, 'read', 0)",
          `tm_owner${i}`,
          t.f.repo.id,
        );
      }
    });
    const socket = await watch(t, t.f.owner.token);
    await runnerModel(t).send(filler(0, 50));
    await settle(socket);
    expect(received(socket)).toHaveLength(50);
  });

  it("refuses a delegated token, an unknown job and an unknown run", async () => {
    const t = await withTask();
    const agent = await agentFor(t.f.owner, ["actions:read"]);
    expect(await ticketCall(t, agent.delegated)).toMatchObject({
      status: 403,
      body: { code: "delegated_listing" },
    });
    expect(await ticketCall({ ...t, jobId: t.jobId + 50 }, t.f.owner.token)).toMatchObject({
      status: 404,
      body: { code: "job_not_found" },
    });
    expect(await ticketCall({ ...t, runId: "0".repeat(26) }, t.f.owner.token)).toMatchObject({
      status: 404,
      body: { code: "run_not_found" },
    });
  });

  it("keeps 20 unredeemed tickets a run, reaping expired ones", async () => {
    const t = await withTask();
    for (let i = 0; i < LOG_VIEWER_POLICY.tickets; i++) await ticketOf(t, t.f.owner.token);
    expect(await ticketCall(t, t.f.owner.token)).toMatchObject({
      status: 429,
      body: { code: "too_many_tickets" },
    });
    await at(t.runId, now(t.runId) + 30_000);
    await ticketOf(t, t.f.owner.token);
    expect(
      await inRun(t.runId, (r) => r.engine.rows("SELECT hash FROM ci_log_tickets").length),
    ).toBe(1);
  });
});

// ------------------------------------------------------------------ the upgrade

describe("the upgrade", () => {
  it("accepts an ASCII case-insensitive WebSocket upgrade", async () => {
    const t = await withTask();
    const ticket = await ticketOf(t, t.f.owner.token);
    const response = await upgrade(t, ticket, {
      token: t.f.owner.token,
      headers: { Upgrade: "WebSocket" },
    });
    expect(response.status).toBe(101);
    const socket = await client(response, ticket);
    socket.ws.close();
  });

  it("is a WebSocket upgrade with a ticket and a position, or refused before anything is read", async () => {
    const t = await withTask();
    const ticket = await ticketOf(t, t.f.owner.token);
    const token = t.f.owner.token;
    expect((await upgrade(t, ticket, { token, upgrade: false })).status).toBe(426);
    expect((await upgrade(t, "short", { token })).status).toBe(400);
    for (const from of ["-1", "x", "1.5", String(2 ** 31)])
      expect((await upgrade(t, ticket, { token, from })).status).toBe(400);
    // None of those spent it.
    expect((await upgrade(t, ticket, { token, from: 2 ** 31 - 1 })).status).toBe(101);
  });

  it("spends a ticket once, refuses it expired, and leaves another credential's unspent", async () => {
    const t = await withTask();
    const token = t.f.owner.token;
    const used = await ticketOf(t, token);
    expect((await upgrade(t, used, { token })).status).toBe(101);
    expect((await upgrade(t, used, { token })).status).toBe(401);

    const late = await ticketOf(t, token);
    await at(t.runId, now(t.runId) + 30_000);
    expect((await upgrade(t, late, { token })).status).toBe(401);

    // Another token of the same user: a credential the ticket was not issued to.
    const other = await json<{ token: string }>(
      api("POST", "/user/tokens", token, { scopes: ["actions:read"] }),
    );
    const theirs = await ticketOf(t, token);
    expect((await upgrade(t, theirs, { token: other.body.token })).status).toBe(401);
    expect((await upgrade(t, theirs, { token })).status).toBe(101);
  });

  it("takes a session's cookie only from this origin, and a bearer token with no origin", async () => {
    const t = await withTask();
    const { cookie } = await testSession(t.f.owner.principalId);
    const issued = await call(
      new Request(`${ORIGIN}/api${livePath(t.f.path, t.runId, t.jobId)}`, {
        method: "POST",
        headers: {
          Cookie: `${SESSION_COOKIE}=${cookie}`,
          "X-Fyrden-Session": "1",
          "Idempotency-Key": crypto.randomUUID(),
        },
      }),
    );
    expect(issued.status).toBe(200);
    const { ticket } = (await issued.json()) as { ticket: string };
    const session = { cookie: `${SESSION_COOKIE}=${cookie}` };
    expect((await upgrade(t, ticket, { ...session, origin: "https://evil.test" })).status).toBe(
      401,
    );
    expect((await upgrade(t, ticket, session)).status).toBe(401);
    expect((await upgrade(t, ticket, { ...session, origin: ORIGIN })).status).toBe(101);
    const bearer = await ticketOf(t, t.f.owner.token);
    expect((await upgrade(t, bearer, { token: t.f.owner.token })).status).toBe(101);
  });

  it("refuses run A's ticket through repository B's address, leaving it unspent", async () => {
    const t = await withTask();
    const other = await json<{ name: string }>(
      api("POST", `/orgs/${t.f.org.login}/repos`, t.f.owner.token, { name: uniqueId("r") }),
    );
    expect(other.status).toBe(201);
    const ticket = await ticketOf(t, t.f.owner.token);
    const token = t.f.owner.token;
    const path = `/repos/${t.f.org.login}/${other.body.name}`;
    expect((await upgrade(t, ticket, { token, path })).status).toBe(404);
    expect((await upgrade(t, ticket, { token })).status).toBe(101);
  });

  it("ignores a client's copy of the internal header", async () => {
    const t = await withTask();
    const reader = await user();
    await json(
      api("PUT", `${t.f.path}/collaborators/${reader.handle}`, t.f.owner.token, {
        permission: "pull",
      }),
    );
    const ownersTicket = await ticketOf(t, t.f.owner.token);
    // The owner's credential, as the object would be told it: trusted, it would spend the ticket.
    const ownerToken = await env.DIRECTORY.prepare("SELECT id FROM tokens WHERE token_hash = ?")
      .bind(await hashToken(t.f.owner.token))
      .first<string>("id");
    const forged = JSON.stringify({
      repoId: t.f.repo.id,
      credentialId: ownerToken,
      principalId: t.f.owner.principalId,
      principalType: "user",
      dependencies: [],
      hash: await ticketHash(ownersTicket),
      jobId: t.jobId,
      from: 0,
    });
    const res = await upgrade(t, ownersTicket, {
      token: reader.token,
      headers: { "X-Fyrden-Log-Viewer": forged },
    });
    expect(res.status).toBe(401);
    expect((await upgrade(t, ownersTicket, { token: t.f.owner.token })).status).toBe(101);
  });

  it("refuses an agent whose owner lost access at the upgrade, and closes its socket 4403 on a recheck", async () => {
    const t = await withTask();
    const alice = await user();
    await json(
      api("PUT", `${t.f.path}/collaborators/${alice.handle}`, t.f.owner.token, {
        permission: "pull",
      }),
    );
    const agent = await agentFor(alice, ["actions:read"]);
    // The agent's own role, put in directly (agents are not added as collaborators).
    const grant = await runInDurableObject(env.ORG.getByName(t.f.org.id), (_: OrgDO, state) => {
      const sql = state.storage.sql;
      sql.exec(
        "INSERT INTO members (principal_id, handle, role, added_at) VALUES (?, ?, 'member', 0)",
        agent.id,
        agent.handle,
      );
      sql.exec(
        "INSERT INTO collaborators (repo_id, principal_id, handle, role, added_at) VALUES (?, ?, ?, 'read', 0)",
        t.f.repo.id,
        agent.id,
        agent.handle,
      );
      return sql
        .exec<{ epoch: number; version: number }>(
          `UPDATE org_meta SET acl_version = acl_version + 1
           RETURNING epoch_gen AS epoch, acl_version AS version`,
        )
        .one();
    });
    await env.REPO.getByName(t.f.repo.id).invalidateAcl(t.f.org.id, grant.epoch, grant.version);
    const socket = await watch(t, agent.own);
    const ticket = await ticketOf(t, agent.own);
    // Alice's access goes; the agent's own role stays.
    expect(
      (await api("DELETE", `${t.f.path}/collaborators/${alice.handle}`, t.f.owner.token)).status,
    ).toBe(200);
    expect((await upgrade(t, ticket, { token: agent.own })).status).toBe(404);
    const model = runnerModel(t);
    await at(t.runId, now(t.runId) + LOG_VIEWER_POLICY.freshMs);
    await model.send(filler(0, 50));
    expect(sent.get(socket.id) ?? 0).toBe(0);
    await slice(t.runId);
    expect(await socket.closed).toEqual({ code: 4403 });
    expect(sent.get(socket.id) ?? 0).toBe(0);
  });

  it("caps sockets a credential (5), a principal (10) and a run (20)", async () => {
    const t = await withTask();
    const owner = t.f.owner;
    const tokens = [owner.token];
    for (let i = 0; i < 2; i++)
      tokens.push(
        (
          await json<{ token: string }>(
            api("POST", "/user/tokens", owner.token, { scopes: ["actions:read"] }),
          )
        ).body.token,
      );
    const [a, b, c] = tokens as [string, string, string];
    for (let i = 0; i < 5; i++) await watch(t, a);
    expect((await upgrade(t, await ticketOf(t, a), { token: a })).status).toBe(429);
    for (let i = 0; i < 5; i++) await watch(t, b);
    expect((await upgrade(t, await ticketOf(t, c), { token: c })).status).toBe(429);
    const others: Who[] = [];
    for (let i = 0; i < 3; i++) {
      const who = await user();
      await json(
        api("PUT", `${t.f.path}/collaborators/${who.handle}`, owner.token, { permission: "pull" }),
      );
      others.push(who);
    }
    const [x, y, z] = others as [Who, Who, Who];
    for (let i = 0; i < 5; i++) await watch(t, x.token);
    for (let i = 0; i < 5; i++) await watch(t, y.token);
    expect((await upgrade(t, await ticketOf(t, z.token), { token: z.token })).status).toBe(429);
    expect(await attachments(t.runId)).toHaveLength(20);
  });
});

// ------------------------------------------------------------------ delivery

describe("delivery", () => {
  it("joins mid-job from storage while live rows land during a held read: 0..130 once each, in order", async () => {
    const t = await withTask();
    const model = runnerModel(t);
    expect(await model.send(filler(0, 50))).toBe(50);
    expect(await model.send(filler(50, 50))).toBe(100);
    await model.send(filler(100, 20));
    await at(t.runId, now(t.runId) + 15_000);
    expect(await model.send()).toBe(120);
    expect(await inRun(t.runId, (r) => r.engine.rows("SELECT 1 FROM ci_log_chunks").length)).toBe(
      3,
    );
    const socket = await watch(t, t.f.owner.token, { checked: false });
    const held = hold(t.runId);
    let reads = 0;
    viewerHooks.afterChunkGet = async () => {
      if (reads++ === 0) await held.hold();
    };
    const running = slice(t.runId);
    try {
      expect(await held.reached(running)).toBe(true);
      expect(await model.send(filler(120, 11))).toBe(120);
      expect(sent.get(socket.id) ?? 0).toBe(0);
    } finally {
      held.release();
      await running;
      delete viewerHooks.afterChunkGet;
    }
    await slice(t.runId);
    await settle(socket);
    const lines = received(socket);
    expect(lines.map((l) => l.i)).toEqual(Array.from({ length: 131 }, (_, i) => i));
    expect(lines.map((l) => l.c)).toEqual(model.rows.map((r) => r.content));
    // Rows 120..130 were sent live: stored now, they are what was sent.
    expect(await model.send([], true)).toBe(131);
    await expectStored(t, socket);
  });

  it("catches up during a small upload with memory available, then sends each row once", async () => {
    const t = await withTask();
    const socket = await watch(t, t.f.owner.token);
    const held = hold(t.runId);
    viewerHooks.beforePublish = () => held.hold();
    const storing = runnerModel(t).send(filler(0, 50));
    try {
      expect(await held.reached(storing)).toBe(true);
      delete viewerHooks.beforePublish;
      await inRun(t.runId, (r) => r.viewers.slice());
      await settle(socket);
      expect(received(socket)).toHaveLength(50);
    } finally {
      held.release();
      await storing;
      delete viewerHooks.beforePublish;
    }
    expect(await storing).toBe(50);
    await settle(socket);
    expect(received(socket)).toHaveLength(50);
    await expectStored(t, socket);
  });

  it("catches up while two tasks have small uploads in flight", async () => {
    const t = await withTask(workflow([job("a"), job("b")].join("\n")));
    await updateTask(t.runner, t.wire);
    const sibling = await registerRunner(t.f.org.login, t.f.owner);
    const task = (await fetchTask(sibling, 0)).task;
    if (!task) throw new Error("no sibling task");
    const socket = await watch(t, t.f.owner.token);
    const first = hold(t.runId);
    const second = hold(t.runId);
    let calls = 0;
    viewerHooks.beforePublish = () => (calls++ === 0 ? first : second).hold();
    const pending: Promise<unknown>[] = [];
    try {
      const a = runnerModel(t).send(filler(0, 50));
      pending.push(a);
      expect(await first.reached(a)).toBe(true);
      const b = ackOf(sibling, { taskId: task.id, index: 0, rows: filler(0, 50) });
      pending.push(b);
      expect(await second.reached(b)).toBe(true);
      await inRun(t.runId, (r) => r.viewers.slice());
      await settle(socket);
      expect(received(socket)).toHaveLength(50);
    } finally {
      first.release();
      second.release();
      await Promise.allSettled(pending);
      delete viewerHooks.beforePublish;
    }
    await slice(t.runId);
    await settle(socket);
    expect(received(socket)).toHaveLength(50);
  });

  it("starts at `from`", async () => {
    const t = await withTask();
    const model = runnerModel(t);
    await model.send(filler(0, 50));
    await model.send(filler(50, 50));
    const socket = await watch(t, t.f.owner.token, { from: 57 });
    await slice(t.runId);
    await settle(socket);
    expect(received(socket, 57).map((l) => l.i)).toEqual(
      Array.from({ length: 43 }, (_, i) => 57 + i),
    );
    await expectStored(t, socket, 57);
  });

  it("keeps attempts apart: attempt 1's late rows never reach attempt 2's job socket", async () => {
    const t = await withTask();
    const model = runnerModel(t);
    await model.send(filler(0, 10));
    await updateTask(t.runner, t.wire, Result.SUCCESS);
    await drain(t.runId);
    expect(
      (await api("POST", `${t.f.path}/actions/runs/${t.runId}/rerun`, t.f.owner.token)).status,
    ).toBe(201);
    await drain(t.runId);
    const second = await jobNamed(t.runId, "a", 2);
    expect(second.jobId).not.toBe(t.jobId);
    const socket = await watch({ ...t, jobId: second.jobId }, t.f.owner.token);
    // Within the late window: stored for attempt 1's task.
    await model.send(filler(10, 50));
    await slice(t.runId);
    await settle(socket);
    // Attempt 1's job has them all (its log ended: then its end).
    const first = await watch(t, t.f.owner.token);
    await settle(first);
    expect(socket.frames.filter((f) => f.t === "rows" || f.t === "part")).toEqual([]);
    expect(received(first).length).toBeGreaterThanOrEqual(50);
  });

  it("sends a held row live exactly as it is later stored: an ::add-mask:: in held rows, a reset between, a token added between", async () => {
    const t = await withTask();
    const socket = await watch(t, t.f.owner.token);
    const model = runnerModel(t);
    const secret = "s3cr3t-value-0123456789";
    // A hold pass: the add-mask row and the rows after it settle, unstored.
    await model.send([
      row(`::add-mask::${secret}`, 1_000),
      row(`one ${secret} two`, 2_000),
      row("plain", 3_000),
    ]);
    expect(model.ack).toBe(0);
    await settle(socket);
    const live = received(socket);
    expect(live.map((l) => l.c)).toEqual(["::add-mask::***", "one *** two", "plain"]);
    // A new job token registered meanwhile (a re-offer), then a reset.
    await inRun(t.runId, (r) =>
      insertPlainMask(r, t.number, "job_token", 0, `fyrden_job_${"Z".repeat(36)}`),
    );
    await evictDurableObject(runStub(t.runId));
    await at(t.runId, now(t.runId));
    // A real wake: the socket and its cursor outlive the object's memory.
    expect((await attachments(t.runId)).map((a) => a.sent)).toEqual([3]);
    // The resend after the reset stores them, and the socket goes on from its cursor.
    expect(await model.send(filler(3, 47))).toBe(50);
    await settle(socket);
    await expectStored(t, socket);
    expect(received(socket)).toHaveLength(50);
  });

  it("sends nothing to a socket past its life, and closes it 1001", async () => {
    const t = await withTask();
    const socket = await watch(t, t.f.owner.token);
    await at(t.runId, now(t.runId) + 24 * 60 * 60_000);
    await runnerModel(t).send(filler(0, 50));
    await slice(t.runId);
    expect(await socket.closed).toEqual({ code: 1001 });
    expect(sent.get(socket.id) ?? 0).toBe(0);
  });
});

// ------------------------------------------------------------------ rechecks

describe("omission records", () => {
  const oversized = () => row("x".repeat(4 * MIB));

  it("publishes an omission once, then keeps held suffix rows byte-identical to storage", async () => {
    const t = await withTask();
    const socket = await watch(t, t.f.owner.token);
    const big = oversized();
    expect(await ackOf(t.runner, { taskId: t.wire, index: 0, rows: [big] })).toBe(1);
    await settle(socket);
    expect(receivedLines(socket)).toEqual([
      { i: 0, omitted: LOG_ROW_TOO_LARGE, bytes: encodeLogRow(big).length },
    ]);
    const frames = socket.frames.length;
    expect(await ackOf(t.runner, { taskId: t.wire, index: 0, rows: [big] })).toBe(1);
    await settle(socket);
    expect(socket.frames).toHaveLength(frames);
    const suffix = t.token.slice(-6);
    const rows = [row(`${suffix}!`), row("short tail!")];
    expect(await ackOf(t.runner, { taskId: t.wire, index: 1, rows })).toBe(1);
    await settle(socket);
    const live = receivedLines(socket);
    expect(live).toHaveLength(3);
    expect(live.slice(1)).toEqual([
      { i: 1, t: null, c: "***" },
      { i: 2, t: null, c: "***" },
    ]);
    expect(socket.texts.join("")).not.toContain(suffix);
    expect((await storedText(t.runId, t.number)).length).toBe(1);
    expect(await ackOf(t.runner, { taskId: t.wire, index: 1, rows, noMore: true })).toBe(3);
    await slice(t.runId);
    expect(await socket.closed).toEqual({ code: 1000 });
    expect(receivedLines(socket)).toEqual(live);
    await expectStored(t, socket);
    expect(endOf(socket)).toEqual({ t: "end", log: "incomplete", durable: 3 });
    expect(
      socket.texts.every(
        (text) => new TextEncoder().encode(text).length <= LOG_VIEWER_POLICY.frameBytes,
      ),
    ).toBe(true);
    expect(await inRun(t.runId, (r) => r.viewers.cacheBytes())).toBe(0);
  });

  it("backfills and resumes at or after a gap, with a following long row still sent in parts", async () => {
    const t = await withTask();
    const big = oversized();
    expect(await ackOf(t.runner, { taskId: t.wire, index: 0, rows: [row("before"), big] })).toBe(1);
    expect(await ackOf(t.runner, { taskId: t.wire, index: 1, rows: [big] })).toBe(2);
    expect(
      await ackOf(t.runner, {
        taskId: t.wire,
        index: 2,
        rows: [row("r".repeat(300 * KIB), 12_345)],
        noMore: true,
      }),
    ).toBe(3);
    await evictDurableObject(runStub(t.runId));
    await at(t.runId, now(t.runId));
    for (const from of [1, 2, 3]) {
      const socket = await watch(t, t.f.owner.token, { from });
      await slice(t.runId);
      expect(await socket.closed).toEqual({ code: 1000 });
      const lines = receivedLines(socket, from);
      expect(lines.map((line) => JSON.stringify(line))).toEqual(
        (await storedText(t.runId, t.number)).slice(from),
      );
      if (from === 1) expect(lines[0]).toMatchObject({ i: 1, omitted: LOG_ROW_TOO_LARGE });
      if (from < 3) {
        expect(socket.frames.some((frame) => frame.t === "part")).toBe(true);
        expect(lines.find((line) => line.i === 2)).toMatchObject({ t: 12_345 });
      }
      expect(endOf(socket)).toEqual({ t: "end", log: "incomplete", durable: 3 });
      expect(
        socket.texts.every(
          (text) => new TextEncoder().encode(text).length <= LOG_VIEWER_POLICY.frameBytes,
        ),
      ).toBe(true);
    }
  });

  it.each<[string, LogRow[], number]>([
    ["empty final", [], 1],
    ["sentinel final", [row("")], 2],
  ])(
    "ends a sealed incomplete log at its last stored line after an %s",
    async (_form, rows, ack) => {
      const t = await withTask();
      expect(await ackOf(t.runner, { taskId: t.wire, index: 0, rows: [oversized()] })).toBe(1);
      expect(await ackOf(t.runner, { taskId: t.wire, index: 1, rows, noMore: true })).toBe(ack);
      expect(await inRun(t.runId, (r) => r.engine.instance(t.jobId)?.status)).not.toBe("completed");
      const socket = await watch(t, t.f.owner.token);
      await slice(t.runId);
      expect(await socket.closed).toEqual({ code: 1000 });
      expect(receivedLines(socket)).toHaveLength(1);
      expect(endOf(socket)).toEqual({ t: "end", log: "incomplete", durable: 1 });
      const stored = await storedText(t.runId, t.number);
      expect(
        await ackOf(t.runner, { taskId: t.wire, index: ack, rows: [row(t.token)], noMore: true }),
      ).toBe(ack);
      expect(await storedText(t.runId, t.number)).toEqual(stored);
      expect(socket.texts.join("")).not.toContain(t.token);
    },
  );

  it("does not send an omission through an expired credential check", async () => {
    const t = await withTask();
    const minted = await json<{ id: string; token: string }>(
      api("POST", "/user/tokens", t.f.owner.token, { scopes: ["actions:read"] }),
    );
    const socket = await watch(t, minted.body.token);
    expect((await api("DELETE", `/user/tokens/${minted.body.id}`, t.f.owner.token)).status).toBe(
      200,
    );
    await at(t.runId, now(t.runId) + LOG_VIEWER_POLICY.freshMs);
    expect(await ackOf(t.runner, { taskId: t.wire, index: 0, rows: [oversized()] })).toBe(1);
    expect(sent.get(socket.id) ?? 0).toBe(0);
    await slice(t.runId);
    expect(await socket.closed).toEqual({ code: 4401 });
    expect(sent.get(socket.id) ?? 0).toBe(0);
  });

  it("backfills the winning R2 rows instead of publishing an equal-range CAS loser's candidate", async () => {
    const t = await withTask();
    expect(await ackOf(t.runner, { taskId: t.wire, index: 0, rows: filler(0, 50) })).toBe(50);
    const socket = await watch(t, t.f.owner.token, { from: 50 });
    await inRun(t.runId, (r) => {
      r.hooks.afterLogPut = async (key: string) => {
        const winnerKey = key.replace(/-[0-9a-f]{32}\.ndjson$/, `-${"0".repeat(32)}.ndjson`);
        const lines = Array.from({ length: 50 }, (_, k) => ({
          i: 50 + k,
          t: null,
          c: `winner ${50 + k}`,
        }));
        const text = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
        const bytes = new TextEncoder().encode(text).length;
        await env.CI.put(winnerKey, text);
        r.engine.exec(
          "INSERT INTO ci_log_chunks (task, start_index, end_index, bytes, r2_key, created_at) VALUES (?, 50, 100, ?, ?, 0)",
          t.number,
          bytes,
          winnerKey,
        );
        r.engine.exec(
          "UPDATE ci_logs SET ack_index = 100, rows = rows + 50, bytes = bytes + ?, mask_carry = NULL WHERE task = ?",
          bytes,
          t.number,
        );
      };
    });
    expect(
      await ackOf(t.runner, {
        taskId: t.wire,
        index: 50,
        rows: Array.from({ length: 50 }, (_, k) => row(`candidate ${50 + k}`)),
      }),
    ).toBe(100);
    await inRun(t.runId, (r) => {
      r.hooks = {};
    });
    await slice(t.runId);
    await settle(socket);
    expect(received(socket, 50).map((line) => line.c)).toEqual(
      Array.from({ length: 50 }, (_, k) => `winner ${50 + k}`),
    );
    await expectStored(t, socket, 50);
    expect(socket.texts.join("")).not.toContain("candidate");
    expect(await ackOf(t.runner, { taskId: t.wire, index: 100, rows: [], noMore: true })).toBe(100);
    await slice(t.runId);
    expect(await socket.closed).toEqual({ code: 1000 });
  });
});

describe("rechecks", () => {
  it("defers a pending credential check without blocking another credential or applying its late result", async () => {
    const t = await withTask();
    const reader = await user();
    await api("PUT", `${t.f.path}/collaborators/${reader.handle}`, t.f.owner.token, {
      permission: "pull",
    });
    const stalled = await watch(t, t.f.owner.token);
    const revoked = await watch(t, reader.token);
    const ownerCredential = (await attachments(t.runId)).find(
      (s) => s.id === stalled.id,
    )?.credentialId;
    if (!ownerCredential) throw new Error("no owner credential");
    await env.DIRECTORY.prepare("UPDATE tokens SET revoked_at = ? WHERE token_hash = ?")
      .bind(Date.now(), await hashToken(reader.token))
      .run();
    await at(t.runId, now(t.runId) + LOG_VIEWER_POLICY.freshMs);
    await runnerModel(t).send(filler(0, 50));
    const held = hold(t.runId);
    let entered = 0;
    let expire: (() => void) | undefined;
    let cancelled = false;
    viewerHooks.recheckDeadline = (_run, credential, _at, fire) => {
      if (credential === ownerCredential) expire = fire;
      return {
        cancel() {
          if (credential === ownerCredential) cancelled = true;
        },
      };
    };
    viewerHooks.beforeAccessCheck = async (_run, credential) => {
      if (credential === ownerCredential) {
        entered++;
        await held.hold();
        throw new Error("late account rejection");
      }
    };
    let finished = false;
    const running = inRun(t.runId, (r) => r.viewers.slice()).then((result) => {
      finished = true;
      return result;
    });
    try {
      expect(await held.reached(running)).toBe(true);
      await inRun(t.runId, () => {
        if (!expire) throw new Error("no recheck deadline");
        expire();
      });
      for (let i = 0; i < 200 && !finished; i++)
        await runInDurableObject(runStub(t.runId), () => {});
      expect(finished).toBe(true);
      expect(await running).toMatchObject({ done: false, runAfterMs: 5_000 });
      expect(await revoked.closed).toEqual({ code: 4401 });
      expect((await attachments(t.runId)).find((s) => s.id === stalled.id)?.checkedAt).toBe(
        now(t.runId) - LOG_VIEWER_POLICY.freshMs,
      );
      expect(sent.get(stalled.id) ?? 0).toBe(0);
      await inRun(t.runId, (r) => r.viewers.slice());
      expect(entered).toBe(1);
    } finally {
      held.release();
      await running;
      delete viewerHooks.beforeAccessCheck;
      delete viewerHooks.recheckDeadline;
    }
    for (let i = 0; i < 200 && !cancelled; i++)
      await runInDurableObject(runStub(t.runId), () => {});
    expect(cancelled).toBe(true);
    expect(sent.get(stalled.id) ?? 0).toBe(0);
    await slice(t.runId);
    await settle(stalled);
    expect(received(stalled)).toHaveLength(50);
  });

  it("closes known old credential generations even when repository access is unknown", async () => {
    const t = await withTask();
    const older = await watch(t, t.f.owner.token);
    await env.DIRECTORY.prepare(
      "UPDATE principals SET lifecycle_gen = lifecycle_gen + 1 WHERE id = ?",
    )
      .bind(t.f.owner.principalId)
      .run();
    viewerHooks.beforeAccessCheck = () => {
      throw new Error("account unavailable");
    };
    try {
      const newer = await watch(t, t.f.owner.token);
      await settle(older);
      expect(await older.closed).toEqual({ code: 4401 });
      expect(newer.code).toBeNull();
      expect((await attachments(t.runId)).find((s) => s.id === newer.id)?.checkedAt).toBe(0);
      expect(sent.get(older.id) ?? 0).toBe(0);
    } finally {
      delete viewerHooks.beforeAccessCheck;
    }
  });

  it("send to a socket checked under 60 s ago without reading the directory", async () => {
    const t = await withTask();
    const socket = await watch(t, t.f.owner.token);
    const checked = rechecks.get(t.runId) ?? 0;
    expect(checked).toBe(1);
    await at(t.runId, now(t.runId) + LOG_VIEWER_POLICY.freshMs - 1);
    await runnerModel(t).send(filler(0, 50));
    await slice(t.runId);
    await settle(socket);
    expect(received(socket)).toHaveLength(50);
    expect(rechecks.get(t.runId) ?? 0).toBe(checked);
  });

  it("close 4401 once the token is revoked, sending nothing after 60 s", async () => {
    const t = await withTask();
    const minted = await json<{ id: string; token: string }>(
      api("POST", "/user/tokens", t.f.owner.token, { scopes: ["actions:read"] }),
    );
    const socket = await watch(t, minted.body.token);
    const checked = rechecks.get(t.runId) ?? 0;
    expect((await api("DELETE", `/user/tokens/${minted.body.id}`, t.f.owner.token)).status).toBe(
      200,
    );
    await at(t.runId, now(t.runId) + LOG_VIEWER_POLICY.freshMs);
    await runnerModel(t).send(filler(0, 50));
    expect(sent.get(socket.id) ?? 0).toBe(0);
    await slice(t.runId);
    expect(await socket.closed).toEqual({ code: 4401 });
    expect(sent.get(socket.id) ?? 0).toBe(0);
    expect(rechecks.get(t.runId)).toBe(checked + 1);
  });

  it("judge each socket by what it was opened on: one opened before a lifecycle change closes 4401, one after stays", async () => {
    const t = await withTask();
    const older = await watch(t, t.f.owner.token);
    await env.DIRECTORY.prepare(
      "UPDATE principals SET lifecycle_gen = lifecycle_gen + 1 WHERE id = ?",
    )
      .bind(t.f.owner.principalId)
      .run();
    const newer = await watch(t, t.f.owner.token);
    await at(t.runId, now(t.runId) + LOG_VIEWER_POLICY.freshMs);
    await runnerModel(t).send(filler(0, 50));
    await slice(t.runId);
    expect(await older.closed).toEqual({ code: 4401 });
    await settle(newer);
    expect(newer.code).toBeNull();
    expect(received(newer)).toHaveLength(50);
    expect(sent.get(older.id) ?? 0).toBe(0);
  });

  it("does not apply an old generation check to a socket opened while that check was pending", async () => {
    const t = await withTask();
    const older = await watch(t, t.f.owner.token);
    await at(t.runId, now(t.runId) + LOG_VIEWER_POLICY.freshMs);
    await runnerModel(t).send(filler(0, 50));
    const held = hold(t.runId);
    let first = true;
    viewerHooks.afterRecheck = async () => {
      if (first) {
        first = false;
        await held.hold();
      }
    };
    const running = slice(t.runId);
    let newer: Client | undefined;
    try {
      expect(await held.reached(running)).toBe(true);
      await env.DIRECTORY.prepare(
        "UPDATE principals SET lifecycle_gen = lifecycle_gen + 1 WHERE id = ?",
      )
        .bind(t.f.owner.principalId)
        .run();
      newer = await watch(t, t.f.owner.token, { checked: false });
    } finally {
      held.release();
      await running;
      delete viewerHooks.afterRecheck;
    }
    if (!newer) throw new Error("new socket was not opened");
    await settle(newer);
    expect(newer.code).toBeNull();
    expect(received(newer)).toHaveLength(50);
    await at(t.runId, now(t.runId) + LOG_VIEWER_POLICY.freshMs);
    await runnerModel(t).send(filler(50, 50));
    await slice(t.runId);
    expect(await older.closed).toEqual({ code: 4401 });
  });

  it("let a check stand for when it started: a clock past 60 s during it sends nothing until the next", async () => {
    const t = await withTask();
    const socket = await watch(t, t.f.owner.token);
    await at(t.runId, now(t.runId) + LOG_VIEWER_POLICY.freshMs);
    await runnerModel(t).send(filler(0, 50));
    const sentAtChecks: number[] = [];
    viewerHooks.beforeRecheck = () => {
      sentAtChecks.push(sent.get(socket.id) ?? 0);
    };
    let first = true;
    viewerHooks.afterRecheck = () => {
      if (first) {
        first = false;
        void at(t.runId, now(t.runId) + LOG_VIEWER_POLICY.freshMs);
      }
    };
    await slice(t.runId);
    await settle(socket);
    // Nothing between the first check and the second; then the rows.
    expect(sentAtChecks).toEqual([0, 0]);
    expect(received(socket)).toHaveLength(50);
  });

  it("close 4403 once access to the repository is removed", async () => {
    const t = await withTask();
    const reader = await user();
    await json(
      api("PUT", `${t.f.path}/collaborators/${reader.handle}`, t.f.owner.token, {
        permission: "pull",
      }),
    );
    const socket = await watch(t, reader.token);
    await api("DELETE", `${t.f.path}/collaborators/${reader.handle}`, t.f.owner.token);
    await at(t.runId, now(t.runId) + LOG_VIEWER_POLICY.freshMs);
    await runnerModel(t).send(filler(0, 50));
    await slice(t.runId);
    expect(await socket.closed).toEqual({ code: 4403 });
    expect(sent.get(socket.id) ?? 0).toBe(0);
  });

  it("stop a page whose read outlived the socket's check: no frame after it, then 4403", async () => {
    const t = await withTask();
    const reader = await user();
    await json(
      api("PUT", `${t.f.path}/collaborators/${reader.handle}`, t.f.owner.token, {
        permission: "pull",
      }),
    );
    await runnerModel(t).send(filler(0, 50));
    const socket = await watch(t, reader.token, { checked: false });
    const held = hold(t.runId);
    viewerHooks.afterChunkGet = () => held.hold();
    const running = slice(t.runId);
    try {
      expect(await held.reached(running)).toBe(true);
      await api("DELETE", `${t.f.path}/collaborators/${reader.handle}`, t.f.owner.token);
      await at(t.runId, now(t.runId) + LOG_VIEWER_POLICY.freshMs + 1_000);
    } finally {
      held.release();
      await running;
      delete viewerHooks.afterChunkGet;
    }
    expect(await socket.closed).toEqual({ code: 4403 });
    expect(sent.get(socket.id) ?? 0).toBe(0);
  });
});

// ------------------------------------------------------------------ flow control

describe("flow control", () => {
  it("counts an ACK inside a whole-row frame as control without extending the slow window", async () => {
    const t = await withTask();
    const model = runnerModel(t);
    for (let k = 0; k < 2; k++)
      await model.send(
        Array.from({ length: 50 }, (_, j) => row(`${k * 50 + j} ${"x".repeat(20 * KIB)}`)),
      );
    const socket = await watch(t, t.f.owner.token);
    await settle(socket);
    const before = (await attachments(t.runId)).find((s) => s.id === socket.id);
    if (!before || before.out[0] === undefined) throw new Error("missing delivery window");
    expect(before.out[0]).toBeGreaterThan(1);
    expect(before.blockedSince).not.toBeNull();
    await at(t.runId, now(t.runId) + 1_000);
    await say(t.runId, socket, { t: "ack", i: 1, o: 0 });
    const after = (await attachments(t.runId)).find((s) => s.id === socket.id);
    expect(after).toMatchObject({
      acked: before.acked,
      ackedPart: before.ackedPart,
      blockedSince: before.blockedSince,
      out: before.out,
      controls: before.controls + 1,
    });
    await say(t.runId, socket, { t: "ack", i: before.out[0], o: before.out[1] });
    expect((await attachments(t.runId)).find((s) => s.id === socket.id)).toMatchObject({
      acked: before.out[0],
      ackedPart: before.out[1],
      blockedSince: before.blockedSince,
      out: before.out.slice(3),
    });
    const k = before.out.length - 6;
    expect(before.out[k + 5]).toBeLessThanOrEqual(LOG_VIEWER_POLICY.ackBytes);
    await say(t.runId, socket, {
      t: "ack",
      i: before.out[k] as number,
      o: before.out[k + 1] as number,
    });
    expect((await attachments(t.runId)).find((s) => s.id === socket.id)).toMatchObject({
      blockedSince: null,
      out: before.out.slice(k + 3),
    });
  });

  it("sends at most 64 frames or 1 MiB unacknowledged, reopens on an ack, and closes 4408 after 2 minutes full", async () => {
    const t = await withTask();
    const model = runnerModel(t);
    // 100 rows of ~20 KiB: 16 KiB-plus frames past 1 MiB.
    for (let k = 0; k < 2; k++)
      await model.send(
        Array.from({ length: 50 }, (_, j) => row(`${k * 50 + j} ${"x".repeat(20 * KIB)}`)),
      );
    let runs = 0;
    viewerHooks.sliceRan = () => {
      runs++;
    };
    // Its first check and its first page, in one run of the job.
    const socket = await watch(t, t.f.owner.token);
    await settle(socket);
    expect(sentBytes.get(socket.id) ?? 0).toBeLessThanOrEqual(LOG_VIEWER_POLICY.windowBytes);
    expect(socket.frames.length).toBeLessThanOrEqual(LOG_VIEWER_POLICY.windowFrames);
    const first = received(socket).length;
    expect(first).toBeLessThan(100);
    // Blocked: no rerun while the clock holds.
    await slice(t.runId);
    expect(runs).toBe(1);
    await ackAll(t.runId, socket);
    await slice(t.runId);
    await settle(socket);
    expect(received(socket).length).toBe(100);
    // A window left full for 2 minutes: rows that cannot go.
    await model.send(
      Array.from({ length: 50 }, (_, j) => row(`${100 + j} ${"y".repeat(30 * KIB)}`)),
    );
    await slice(t.runId);
    await settle(socket);
    expect(received(socket).length).toBeLessThan(150);
    await at(t.runId, now(t.runId) + LOG_VIEWER_POLICY.slowMs - 1);
    await slice(t.runId);
    expect(socket.code).toBeNull();
    await at(t.runId, now(t.runId) + 1);
    await slice(t.runId);
    expect(await socket.closed).toEqual({ code: 4408 });
  });

  it("sends a blocked socket nothing from memory, and keeps its 2 minutes running, until an ack leaves at most 256 KiB and 16 frames out", async () => {
    const t = await withTask();
    const socket = await watch(t, t.f.owner.token);
    let gets = 0;
    viewerHooks.afterChunkGet = () => {
      gets++;
    };
    // Sent while it watches, so held in memory.
    const model = runnerModel(t);
    for (let k = 0; k < 2; k++)
      await model.send(
        Array.from({ length: 50 }, (_, j) => row(`${k * 50 + j} ${"x".repeat(20 * KIB)}`)),
      );
    await slice(t.runId);
    await settle(socket);
    const full = socket.frames.length;
    const before = (await attachments(t.runId)).find((s) => s.id === socket.id);
    expect(before?.blockedSince).not.toBeNull();
    // An ack leaving more than 256 KiB out, then a run of the job something else wakes (another
    // viewer opening).
    await at(t.runId, now(t.runId) + 1_000);
    await say(t.runId, socket, { t: "ack", ...positionAfter(socket, 1) });
    await inRun(t.runId, (r) => r.viewers.slice());
    await settle(socket);
    expect(socket.frames).toHaveLength(full);
    expect((await attachments(t.runId)).find((s) => s.id === socket.id)?.blockedSince).toBe(
      before?.blockedSince,
    );
    await say(t.runId, socket, { t: "ack", ...positionAfter(socket, full - 1) });
    await slice(t.runId);
    await settle(socket);
    expect(socket.frames.length).toBeGreaterThan(full);
    expect(gets).toBe(0);
  });

  it("reads nothing more from storage, and keeps its 2 minutes running, until an ack leaves at most 256 KiB and 16 frames out", async () => {
    const t = await withTask();
    const model = runnerModel(t);
    // One 3 MiB chunk of 300 KiB rows, each sent in 32 KiB parts: reread from its start by each read.
    expect(
      await model.send(
        Array.from({ length: 10 }, (_, j) => row(`${j} ${"x".repeat(300 * KIB)}`)),
        true,
      ),
    ).toBe(10);
    await forget(t.runId);
    let gets = 0;
    viewerHooks.afterChunkGet = () => {
      gets++;
    };
    const socket = await watch(t, t.f.owner.token);
    await settle(socket);
    expect(gets).toBe(1);
    const full = socket.frames.length;
    const blocked = (await attachments(t.runId)).find((s) => s.id === socket.id)?.blockedSince;
    expect(blocked).not.toBeNull();
    await at(t.runId, now(t.runId) + LOG_VIEWER_POLICY.slowMs / 2);
    expect(full).toBeGreaterThan(20);
    await say(t.runId, socket, { t: "ack", ...positionAfter(socket, 1) });
    await say(t.runId, socket, { t: "ack", ...positionAfter(socket, full - 9) });
    await slice(t.runId);
    expect(gets).toBe(1);
    expect(socket.frames).toHaveLength(full);
    expect((await attachments(t.runId)).find((s) => s.id === socket.id)?.blockedSince).toBe(
      blocked,
    );
    await say(t.runId, socket, { t: "ack", ...positionAfter(socket, full - 7) });
    await slice(t.runId);
    await settle(socket);
    expect(gets).toBe(2);
    expect(socket.frames.length).toBeGreaterThan(full + 20);
    await say(t.runId, socket, { t: "ack", ...positionAfter(socket, full + 1) });
    await at(t.runId, now(t.runId) + LOG_VIEWER_POLICY.slowMs);
    await slice(t.runId);
    expect(await socket.closed).toEqual({ code: 4408 });
    expect(gets).toBe(2);
  });

  it("sends rows of 2 MiB and 4 MiB in parts that reassemble to the stored rows, from storage and live", async () => {
    const t = await withTask();
    const model = runnerModel(t);
    // Mostly one byte a char, with chars JSON escapes.
    const big = (n: number, ch: string) => `${ch}${"x".repeat(n - 3)}"\u0001`;
    const behind = await watch(t, t.f.owner.token);
    await model.send([row(big(2 * MIB, "a"), 7_000)]);
    await model.send([row(big(4 * MIB - 64 * KIB, "b"), 8_000)]);
    const later = await watch(t, t.f.owner.token);
    for (let i = 0; i < 20 && (received(later).length < 2 || received(behind).length < 2); i++) {
      await slice(t.runId);
      await ackAll(t.runId, later);
      await ackAll(t.runId, behind);
    }
    for (const socket of [behind, later]) {
      await settle(socket);
      expect(socket.frames.some((f) => f.t === "part")).toBe(true);
      for (const text of socket.texts)
        expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(256 * KIB);
      await expectStored(t, socket);
      expect(received(socket).map((l) => l.t)).toEqual([7_000, 8_000]);
    }
  });

  it("never closes a fast client acknowledging every 16 frames through a 6 MiB backfill", async () => {
    const t = await withTask();
    const model = runnerModel(t);
    // 20 rows of 300 KiB, each sent in parts: an ack every 8 parts.
    for (let k = 0; k < 10; k++)
      await model.send([0, 1].map((j) => row(`${2 * k + j} ${"z".repeat(300 * KIB)}`)));
    const socket = await watch(t, t.f.owner.token);
    let acks = 0;
    let handled = 0;
    for (let i = 0; i < 200 && received(socket).length < 20; i++) {
      await slice(t.runId);
      await settle(socket);
      // An ack after each 256 KiB or 16 frames handled.
      let frames = 0;
      let bytes = 0;
      for (; handled < socket.texts.length; handled++) {
        frames++;
        bytes += new TextEncoder().encode(socket.texts[handled]).length;
        if (frames >= 16 || bytes >= 256 * KIB) {
          acks++;
          await say(t.runId, socket, { t: "ack", ...positionAfter(socket, handled + 1) });
          frames = 0;
          bytes = 0;
        }
      }
      if (frames > 0) handled -= frames;
    }
    expect(acks).toBeGreaterThan(LOG_VIEWER_POLICY.controlsPerMinute);
    expect(socket.code).toBeNull();
    expect(received(socket)).toHaveLength(20);
  });
});

describe("escaped chunk backfill", () => {
  it("admits a final upload while viewer catch-up is waiting for its chunk", async () => {
    const t = await withTask();
    const model = runnerModel(t);
    expect(await model.send([row("\u0001".repeat(MIB))])).toBe(1);
    await forget(t.runId);
    const socket = await watch(t, t.f.owner.token, { checked: false });
    const [chunk] = await inRun(t.runId, (r) =>
      r.engine.rows<{ bytes: number }>("SELECT bytes FROM ci_log_chunks WHERE task = ?", t.number),
    );
    const held = hold(t.runId);
    viewerHooks.afterChunkGet = () => held.hold();
    const reading = slice(t.runId);
    try {
      expect(await held.reached(reading)).toBe(true);
      expect(chargedTo(socket.id)).toEqual({ gets: 1, bytes: 0 });
      const memory = await inRun(t.runId, (r) => r.memory.stats());
      expect(memory.reservedBytes).toBe(0);
      expect(await model.send([row("tail".repeat(512 * KIB))], true)).toBe(2);
    } finally {
      held.release();
      await reading;
      delete viewerHooks.afterChunkGet;
      socket.ws.close();
    }
    const read = chargedTo(socket.id);
    expect(read.gets).toBe(1);
    expect(read.bytes).toBeGreaterThan(0);
    expect(read.bytes).toBeLessThanOrEqual(chunk?.bytes ?? 0);
  });

  it.each([2 * MIB, 4 * MIB - 256])(
    "cancels a stalled body read before admitting a %i-byte upload and resumes without duplicate rows",
    async (tailBytes) => {
      const t = await withTask();
      const prefix = Array.from({ length: 50 }, (_, i) => row(`row ${i} ${"p".repeat(12 * KIB)}`));
      const control = row("\u0001".repeat(MIB));
      const tail = row("tail".repeat(tailBytes / 4));
      const model = runnerModel(t);
      expect(await model.send([...prefix, control])).toBe(51);
      await forget(t.runId);
      const stalled = hold(t.runId);
      const cancellation = hold(t.runId);
      let cancelled = false;
      let delivered = 0;
      await inRun(t.runId, (r) => {
        const host = r as unknown as { env: Env };
        const bucket = host.env.CI;
        Object.defineProperty(host.env, "CI", {
          configurable: true,
          value: new Proxy(bucket, {
            get(target, prop) {
              if (prop === "get")
                return async (key: string) => {
                  Object.defineProperty(host.env, "CI", { configurable: true, value: bucket });
                  const object = await target.get(key);
                  if (!object) return object;
                  const reader = object.body.getReader({ mode: "byob" });
                  let bytes = 0;
                  const body = new ReadableStream({
                    type: "bytes",
                    async pull(controller) {
                      if (bytes >= 768 * KIB) await stalled.hold();
                      if (cancelled) return;
                      const { value, done } = await reader.read(new Uint8Array(16 * KIB));
                      if (cancelled) return;
                      const request = controller.byobRequest;
                      if (!request?.view) throw new Error("missing BYOB request");
                      if (done) {
                        controller.close();
                        request.respond(0);
                        return;
                      }
                      new Uint8Array(
                        request.view.buffer,
                        request.view.byteOffset,
                        request.view.byteLength,
                      ).set(value);
                      bytes += value.byteLength;
                      delivered += value.byteLength;
                      request.respond(value.byteLength);
                    },
                    async cancel() {
                      cancelled = true;
                      stalled.release();
                      try {
                        await reader.cancel();
                      } finally {
                        reader.releaseLock();
                      }
                      await cancellation.hold();
                    },
                  });
                  return new Proxy(object, {
                    get(target, prop) {
                      if (prop === "body") return body;
                      const value = Reflect.get(target, prop);
                      return typeof value === "function" ? value.bind(target) : value;
                    },
                  });
                };
              const value = Reflect.get(target, prop);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        });
      });
      const socket = await watch(t, t.f.owner.token, { checked: false });
      let gets = 0;
      viewerHooks.afterChunkGet = () => {
        gets++;
      };
      const charges: { gets: number; bytes: number }[] = [];
      const counting = viewerHooks.readCharged;
      viewerHooks.readCharged = (id, charge) => {
        counting?.(id, charge);
        if (id === socket.id) charges.push(charge);
      };
      const reading = slice(t.runId);
      let upload: Promise<number> | undefined;
      let overlap: Promise<number> | undefined;
      try {
        expect(await stalled.reached(reading)).toBe(true);
        await settle(socket);
        expect(received(socket).length).toBeGreaterThan(0);
        upload = model.send([tail], true);
        expect(await cancellation.reached(upload)).toBe(true);
        expect(cancelled).toBe(true);
        expect(chargedTo(socket.id).gets).toBe(1);
        expect((await inRun(t.runId, (r) => r.memory.stats())).reservedBytes).toBeGreaterThan(
          15 * MIB,
        );
        let overlapAck: number | undefined;
        overlap = ackOf(t.runner, {
          taskId: t.wire,
          index: 51,
          rows: [row("overlapping request")],
          noMore: true,
        }).then((ack) => {
          overlapAck = ack;
          return ack;
        });
        for (let i = 0; i < 500 && overlapAck === undefined; i++)
          await runInDurableObject(runStub(t.runId), () => {});
        expect(overlapAck).toBe(51);
        cancellation.release();
        expect(await upload).toBe(52);
        await reading;
        expect(charges.slice(0, 2)).toEqual([
          { gets: 1, bytes: 0 },
          { gets: 0, bytes: delivered },
        ]);
        await forget(t.runId);
        expect((await inRun(t.runId, (r) => r.memory.stats())).reservedBytes).toBe(0);
        await at(t.runId, now(t.runId) + 1_000);
        await expectFinished(
          t,
          socket,
          [...prefix, control, tail].map((line, i) => ({ i, t: null, c: line.content })),
        );
        expect(chargedTo(socket.id).gets).toBe(gets);
      } finally {
        stalled.release();
        cancellation.release();
        await Promise.allSettled([
          reading,
          ...(upload ? [upload] : []),
          ...(overlap ? [overlap] : []),
        ]);
        socket.ws.close();
      }
    },
  );

  async function expectFinished(t: Task, socket: Client, expected: Line[]) {
    for (let i = 0; i < 100 && !endOf(socket); i++) {
      await ackAll(t.runId, socket);
      await slice(t.runId);
      await settle(socket);
    }
    expect(received(socket)).toEqual(expected);
    expect(endOf(socket)).toEqual({ t: "end", log: "complete", durable: expected.length });
    expect(await socket.closed).toEqual({ code: 1000 });
    for (const text of socket.texts)
      expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(256 * KIB);
    const state = await inRun(t.runId, (r) => ({
      memory: r.memory.stats(),
      failures: r.engine.rows(
        "SELECT state, attempts, last_error FROM jobs WHERE kind = 'ci_log_viewers' AND (state = 'failed' OR attempts > 0 OR last_error IS NOT NULL)",
      ),
      faults: r.engine.rows("SELECT error FROM run_faults WHERE kind = 'ci_log_viewers'"),
    }));
    expect(state.failures).toEqual([]);
    expect(state.faults).toEqual([]);
    expect(state.memory.peakBytes).toBeLessThanOrEqual(state.memory.totalBytes);
    expect(state.memory.reservedBytes).toBe(0);
  }

  for (const [label, content] of [
    ["a 1 MiB control-heavy row", "\u0001".repeat(MIB)],
    ["a near-4 MiB ordinary row", "x".repeat(4 * MIB - 64 * KIB)],
  ] as const) {
    it(`streams ${label} from ingestion after the cache is lost`, async () => {
      const t = await withTask();
      const expected = [
        { i: 0, t: 7_123, c: content },
        { i: 1, t: 8_456, c: "after the large row" },
      ];
      const model = runnerModel(t);
      expect(await model.send([row(content, 7_123)])).toBe(1);
      expect(await model.send([row("after the large row", 8_456)], true)).toBe(2);
      await forget(t.runId);
      expect(await inRun(t.runId, (r) => r.viewers.cacheBytes())).toBe(0);
      const socket = await watch(t, t.f.owner.token, { checked: false });
      await inRun(t.runId, (r) => r.viewers.slice());
      await settle(socket);
      expect(socket.frames.some((f) => f.t === "part")).toBe(true);
      expect(endOf(socket)).toBeUndefined();
      const first = position(socket);
      expect(first.i).toBe(0);
      expect(first.o).toBeGreaterThan(0);
      expect(first.o).toBeLessThan(content.length);
      const frames = socket.frames.length;
      await slice(t.runId);
      await settle(socket);
      expect(socket.frames).toHaveLength(frames);
      await expectFinished(t, socket, expected);
    });
  }

  it("continues a multirow escaped chunk across acknowledgements while another job progresses", async () => {
    const t = await withTask(workflow([job("a"), job("b")].join("\n")));
    const runner = await registerRunner(t.f.org.login, t.f.owner);
    const sibling = (await fetchTask(runner, 0)).task;
    if (!sibling) throw new Error("no sibling task");
    const { jobId } = await jobNamed(t.runId, "b");
    const expected = [
      { i: 0, t: 1_234, c: "\u0001".repeat(512 * KIB) },
      { i: 1, t: 5_678, c: "\u0002".repeat(512 * KIB) },
      { i: 2, t: 9_012, c: "after the escaped rows" },
    ];
    expect(
      await runnerModel(t).send(
        expected.map((line) => row(line.c, line.t)),
        true,
      ),
    ).toBe(3);
    const chunks = await inRun(t.runId, (r) =>
      r.engine.rows<{ bytes: number; start_index: number; end_index: number }>(
        "SELECT bytes, start_index, end_index FROM ci_log_chunks WHERE task = ?",
        t.number,
      ),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ start_index: 0, end_index: 3 });
    expect(chunks[0]?.bytes).toBeGreaterThan((16 * MIB) / 3);
    expect(
      await ackOf(runner, {
        taskId: sibling.id,
        index: 0,
        rows: [row("sibling progresses", 2_345)],
        noMore: true,
      }),
    ).toBe(1);
    const [siblingChunk] = await inRun(t.runId, (r) =>
      r.engine.rows<{ bytes: number }>(
        "SELECT c.bytes FROM ci_log_chunks c WHERE c.task = (SELECT task FROM ci_tasks WHERE wire_id = ?)",
        sibling.id,
      ),
    );
    await forget(t.runId);
    let gets = 0;
    viewerHooks.afterChunkGet = () => {
      gets++;
    };
    const difficult = await watch(t, t.f.owner.token, { checked: false });
    const other = await watch({ ...t, jobId }, t.f.owner.token, { checked: false });
    await inRun(t.runId, (r) => r.viewers.slice());
    await settle(difficult);
    await settle(other);
    expect(endOf(difficult)).toBeUndefined();
    expect(received(other)).toEqual([{ i: 0, t: 2_345, c: "sibling progresses" }]);
    expect(endOf(other)).toEqual({ t: "end", log: "complete", durable: 1 });
    expect(await other.closed).toEqual({ code: 1000 });
    expect(chargedTo(other.id)).toEqual({ gets: 1, bytes: siblingChunk?.bytes });
    await expectFinished(t, difficult, expected);
    const read = chargedTo(difficult.id);
    const chunkBytes = chunks[0]?.bytes ?? 0;
    expect(read.gets + 1).toBe(gets);
    expect(read.bytes).toBeGreaterThanOrEqual(chunkBytes);
    expect(read.bytes).toBeLessThanOrEqual(read.gets * chunkBytes);
  });
});

/** Budgeted as on a Free deployment, the ledger's grant aside. */
async function budgetedTicket(t: Task) {
  const { ticket, answer } = await storedTicket(t, { maxActiveMs: LOG_VIEWER_POLICY.lifeMs });
  if (!answer.ok || !answer.budget || !answer.stored)
    throw new Error(answer.ok ? "unbudgeted" : answer.code);
  return { ticket, stored: answer.stored, budget: answer.budget };
}

async function storedTicket(t: Task, budget: { readonly maxActiveMs: number } | null) {
  const ticket = randomSecret(32);
  const credentialId = await env.DIRECTORY.prepare("SELECT id FROM tokens WHERE token_hash = ?")
    .bind(await hashToken(t.f.owner.token))
    .first<string>("id");
  if (!credentialId) throw new Error("no credential");
  const answer = await runStub(t.runId).storeLogTicket({
    hash: await ticketHash(ticket),
    repoId: t.f.repo.id,
    jobId: t.jobId,
    credentialId,
    principalId: t.f.owner.principalId,
    budget,
  });
  return { ticket, answer };
}

async function openBudgeted(t: Task, ticket: string, from = 0): Promise<Client> {
  const response = await upgrade(t, ticket, { token: t.f.owner.token, from });
  expect(response.status).toBe(101);
  const c = await client(response, ticket);
  await slice(t.runId);
  return c;
}

async function readToClose(t: Task, c: Client): Promise<number> {
  let slices = 0;
  for (; slices < 200 && c.code === null; slices++) {
    await settle(c);
    if (c.code === null) await ackAll(t.runId, c);
    await slice(t.runId);
  }
  if (c.code === null)
    throw new Error(`still open after ${slices} slices, ${c.texts.length} frames received`);
  await c.closed;
  return slices;
}

const utf8 = new TextEncoder();

/** Acknowledges as rarely as the protocol allows: after each 256 KiB of frames' UTF-8 or 16 frames. */
async function readAtCadence(t: Task, c: Client): Promise<number> {
  let handled = 0;
  let frames = 0;
  let bytes = 0;
  let slices = 0;
  for (; slices < 400 && c.code === null; slices++) {
    await settle(c);
    for (; handled < c.texts.length && c.code === null; handled++) {
      frames++;
      bytes += utf8.encode(c.texts[handled]).length;
      if (frames >= 16 || bytes >= 256 * KIB) {
        await say(t.runId, c, { t: "ack", ...positionAfter(c, handled + 1) });
        frames = 0;
        bytes = 0;
      }
    }
    if (c.code === null) await slice(t.runId);
  }
  if (c.code === null)
    throw new Error(`still open after ${slices} slices, ${c.texts.length} frames received`);
  await c.closed;
  return slices;
}

const storedChunks = (t: Task) =>
  inRun(t.runId, (r) =>
    r.engine.rows<{ bytes: number }>(
      "SELECT bytes FROM ci_log_chunks WHERE task = ? ORDER BY start_index",
      t.number,
    ),
  );

describe("read budgets", () => {
  it("are not sized for an unbudgeted ticket, which answers no stored log", async () => {
    const t = await withTask();
    const { answer } = await storedTicket(t, null);
    expect(answer).toMatchObject({ ok: true, stored: null, budget: null });
  });

  it("keep a backfill over several slices within its bytes and attempts, from the log stored at issuance", async () => {
    const t = await withTask();
    const model = runnerModel(t);
    for (let k = 0; k < 12; k++)
      await model.send(
        Array.from({ length: 20 }, (_, j) => row(`${20 * k + j} ${"q".repeat(10 * KIB)}`)),
      );
    await model.send([], true);
    await forget(t.runId);
    const chunks = await storedChunks(t);
    const { ticket, stored, budget } = await budgetedTicket(t);
    // Each chunk read back once for each read's least progress it holds.
    const reads = (bytes: number) => Math.ceil(bytes / VIEWER_READ_PROGRESS);
    expect(stored).toMatchObject({
      bytes: chunks.reduce((sum, chunk) => sum + chunk.bytes, 0),
      chunks: chunks.length,
      rereadBytes: chunks.reduce((sum, chunk) => sum + chunk.bytes * reads(chunk.bytes), 0),
      reads: chunks.reduce((sum, chunk) => sum + reads(chunk.bytes), 0),
    });
    const socket = await openBudgeted(t, ticket);
    // The opening slice, then at least two more: a window of 1 MiB at a time.
    expect(await readToClose(t, socket)).toBeGreaterThanOrEqual(2);
    expect(endOf(socket)).toEqual({ t: "end", log: "complete", durable: 240 });
    expect(socket.code).toBe(1000);
    await expectStored(t, socket);
    const read = chargedTo(socket.id);
    expect(read.bytes).toBeGreaterThanOrEqual(stored.bytes);
    expect(read.bytes).toBeLessThanOrEqual(budget.readBytes);
    expect(read.gets).toBeGreaterThanOrEqual(stored.chunks);
    expect(read.gets).toBeLessThanOrEqual(budget.getAttempts);
  });

  it("end a socket whose next read would pass its bytes with `budget`; a new ticket resumes at its next row", async () => {
    const t = await withTask();
    const { ticket, budget } = await budgetedTicket(t);
    expect(budget.readBytes).toBe(4 * MIB);
    // Stored after the ticket was issued: read from storage, they count.
    const model = runnerModel(t);
    for (let k = 0; k < 6; k++)
      await model.send(
        Array.from({ length: 10 }, (_, j) => row(`${10 * k + j} ${"b".repeat(100 * KIB)}`)),
        k === 5,
      );
    await forget(t.runId);
    const largest = Math.max(...(await storedChunks(t)).map((chunk) => chunk.bytes));
    const socket = await openBudgeted(t, ticket);
    await readToClose(t, socket);
    expect(endOf(socket)).toEqual({ t: "end", reason: "budget" });
    expect(socket.code).toBe(4429);
    const read = chargedTo(socket.id);
    expect(read.bytes).toBeLessThanOrEqual(budget.readBytes);
    expect(read.bytes + largest).toBeGreaterThan(budget.readBytes);
    const next = received(socket).length;
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThan(60);
    await expectStored(t, socket);
    const again = await budgetedTicket(t);
    expect(again.budget.readBytes).toBeGreaterThan(budget.readBytes);
    const resumed = await openBudgeted(t, again.ticket, next);
    await readToClose(t, resumed);
    expect(endOf(resumed)).toEqual({ t: "end", log: "complete", durable: 60 });
    expect(resumed.code).toBe(1000);
    await expectStored(t, resumed, next);
    expect(chargedTo(resumed.id).bytes).toBeLessThanOrEqual(again.budget.readBytes);
  });

  it("end a socket out of read attempts with `budget`, each attempt charged before its read", async () => {
    const t = await withTask();
    const { ticket, budget } = await budgetedTicket(t);
    const model = runnerModel(t);
    // 50 rows a request: each is stored as a chunk of its own.
    const n = budget.getAttempts + 5;
    for (let k = 0; k < n; k++) await model.send(filler(50 * k, 50), k === n - 1);
    expect((await storedChunks(t)).length).toBe(n);
    await forget(t.runId);
    let gets = 0;
    viewerHooks.afterChunkGet = () => {
      gets++;
    };
    const socket = await openBudgeted(t, ticket);
    await readToClose(t, socket);
    expect(endOf(socket)).toEqual({ t: "end", reason: "budget" });
    expect(socket.code).toBe(4429);
    expect(chargedTo(socket.id).gets).toBe(budget.getAttempts);
    expect(gets).toBe(budget.getAttempts);
    expect(received(socket).length).toBe(50 * budget.getAttempts);
    await expectStored(t, socket);
  });

  for (const [label, rows, timeout] of [
    ["a stored 4 MiB row", ["x".repeat(4 * MIB - 64 * KIB), "after"], 30_000],
    [
      "the second of two 3 MiB rows in one 6 MiB chunk",
      ["\u0001".repeat(512 * KIB), "\u0002".repeat(512 * KIB), "after"],
      30_000,
    ],
    // Ingestion's longest row, every code unit escaped to six bytes: a 24 MiB chunk read back
    // about 26 times (alone on a laptop, measured 2026-11-22: 18 s, 28 s with coverage; past 30 s
    // on a loaded CI shard).
    [
      "a near-limit row of escaped characters",
      ["\u0001".repeat(4 * MIB - 64 * KIB), "after"],
      240_000,
    ],
  ] as const)
    it(`let one ticket's socket finish ${label}, acknowledged at the protocol's least`, {
      timeout,
    }, async () => {
      const t = await withTask();
      expect(
        await runnerModel(t).send(
          rows.map((c) => row(c)),
          true,
        ),
      ).toBe(rows.length);
      await forget(t.runId);
      const { ticket, stored, budget } = await budgetedTicket(t);
      expect(stored.chunks).toBe(1);
      const socket = await openBudgeted(t, ticket);
      await readAtCadence(t, socket);
      expect(endOf(socket)).toEqual({ t: "end", log: "complete", durable: rows.length });
      expect(socket.code).toBe(1000);
      await expectStored(t, socket);
      const read = chargedTo(socket.id);
      // Read again from the chunk's start for each window, within the reads the chunk was sized for.
      expect(read.gets).toBeGreaterThanOrEqual(
        Math.ceil(stored.bytes / LOG_VIEWER_POLICY.windowBytes),
      );
      expect(read.gets).toBeLessThanOrEqual(stored.reads);
      expect(read.gets).toBeLessThanOrEqual(budget.getAttempts);
      expect(read.bytes).toBeGreaterThan(stored.bytes);
      expect(read.bytes).toBeLessThanOrEqual(budget.readBytes);
    });

  it("charge a socket a check each time it is checked, ending it with `budget` once none are left", async () => {
    const t = await withTask();
    const model = runnerModel(t);
    for (let k = 0; k < 12; k++)
      await model.send(
        Array.from({ length: 20 }, (_, j) => row(`${20 * k + j} ${"q".repeat(10 * KIB)}`)),
      );
    await model.send([], true);
    await forget(t.runId);
    const { ticket, budget } = await budgetedTicket(t);
    expect(budget.checks).toBeGreaterThan(2);
    await inRun(t.runId, (r) => r.engine.exec("UPDATE ci_log_tickets SET read_checks = 2"));
    let checks = 0;
    viewerHooks.afterRecheck = () => {
      checks++;
    };
    // Its first check, then one more after 60 s, each paid for; the third is not.
    const socket = await openBudgeted(t, ticket);
    expect(checks).toBe(1);
    for (let k = 0; k < 2 && socket.code === null; k++) {
      await ackAll(t.runId, socket);
      await at(t.runId, now(t.runId) + LOG_VIEWER_POLICY.freshMs);
      await slice(t.runId);
    }
    expect(await socket.closed).toEqual({ code: 4429 });
    expect(endOf(socket)).toEqual({ t: "end", reason: "budget" });
    expect(checks).toBe(2);
    expect(received(socket).length).toBeLessThan(240);
  });

  it("check a socket reading back a finished log, its client pacing it, no more than its ticket paid for", async () => {
    const t = await withTask();
    const model = runnerModel(t);
    for (let k = 0; k < 12; k++)
      await model.send(
        Array.from({ length: 20 }, (_, j) => row(`${20 * k + j} ${"q".repeat(10 * KIB)}`)),
      );
    await model.send([], true);
    await forget(t.runId);
    const { ticket, stored, budget } = await budgetedTicket(t);
    expect(stored.activeMs).toBe(0);
    let checks = 0;
    viewerHooks.afterRecheck = () => {
      checks++;
    };
    const socket = await openBudgeted(t, ticket);
    // Each ack held until just before the window has waited 2 minutes: a check before each read.
    for (let k = 0; k < 100 && socket.code === null; k++) {
      await at(t.runId, now(t.runId) + LOG_VIEWER_POLICY.slowMs - 1);
      await slice(t.runId);
      if (socket.code === null) await ackAll(t.runId, socket);
      await slice(t.runId);
    }
    expect(endOf(socket)).toEqual({ t: "end", log: "complete", durable: 240 });
    expect(socket.code).toBe(1000);
    expect(checks).toBeGreaterThan(2);
    expect(checks).toBeLessThanOrEqual(budget.checks);
  });

  it("leave a socket on an unbudgeted ticket unbounded, counting what it reads", async () => {
    const t = await withTask();
    const model = runnerModel(t);
    for (let k = 0; k < 30; k++) await model.send(filler(50 * k, 50), k === 29);
    await forget(t.runId);
    const socket = await watch(t, t.f.owner.token, { checked: false });
    await readToClose(t, socket);
    expect(endOf(socket)).toEqual({ t: "end", log: "complete", durable: 1500 });
    const chunks = await storedChunks(t);
    expect(chargedTo(socket.id)).toEqual({
      gets: chunks.length,
      bytes: chunks.reduce((sum, chunk) => sum + chunk.bytes, 0),
    });
  });
});

// ------------------------------------------------------------------ the end

describe("the end", () => {
  it("keeps a completed task's viewer open until its late final rows commit", async () => {
    const t = await withTask();
    const model = runnerModel(t);
    const socket = await watch(t, t.f.owner.token);
    await model.send(filler(0, 10));
    await updateTask(t.runner, t.wire, Result.SUCCESS);
    await slice(t.runId);
    await settle(socket);
    expect(endOf(socket)).toBeUndefined();
    expect(socket.code).toBeNull();
    expect(await model.send(filler(10, 5), true)).toBe(15);
    await slice(t.runId);
    await settle(socket);
    expect(received(socket)).toHaveLength(15);
    expect(endOf(socket)).toEqual({ t: "end", log: "complete", durable: 15 });
    expect(await socket.closed).toEqual({ code: 1000 });
  });

  it("ends an idle incomplete viewer at the late deadline even when its log has no masks", async () => {
    const t = await withTask();
    const socket = await watch(t, t.f.owner.token);
    await updateTask(t.runner, t.wire, Result.SUCCESS);
    const ended = now(t.runId);
    await inRun(t.runId, (r) => r.engine.exec("DELETE FROM ci_log_masks WHERE task = ?", t.number));
    await slice(t.runId);
    expect(endOf(socket)).toBeUndefined();
    await at(t.runId, ended + LOG_LATE_MS - 1);
    await slice(t.runId);
    expect(endOf(socket)).toBeUndefined();
    await at(t.runId, ended + LOG_LATE_MS);
    await slice(t.runId);
    await settle(socket);
    expect(endOf(socket)).toEqual({ t: "end", log: "incomplete", durable: 0 });
    expect(await socket.closed).toEqual({ code: 1000 });
    expect(await slice(t.runId)).toBe(0);
    const refused = await runnerCall(
      "UpdateLog",
      encodeUpdateLogRequest({
        taskId: t.wire,
        index: 0,
        rows: [row("late after deadline")],
        noMore: true,
      }),
      { credentials: t.runner },
    );
    expect(refused.status).toBe(404);
    await refused.arrayBuffer();
    expect(await storedText(t.runId, t.number)).toEqual([]);
  });

  it("keeps an omitted log open after task completion and ends incomplete after its final flush", async () => {
    const t = await withTask();
    const socket = await watch(t, t.f.owner.token);
    expect(
      await ackOf(t.runner, { taskId: t.wire, index: 0, rows: [row("x".repeat(4 * MIB))] }),
    ).toBe(1);
    await updateTask(t.runner, t.wire, Result.SUCCESS);
    await slice(t.runId);
    await settle(socket);
    expect(endOf(socket)).toBeUndefined();
    expect(await ackOf(t.runner, { taskId: t.wire, index: 1, rows: [], noMore: true })).toBe(1);
    await slice(t.runId);
    await settle(socket);
    expect(endOf(socket)).toEqual({ t: "end", log: "incomplete", durable: 1 });
    expect(await socket.closed).toEqual({ code: 1000 });
  });

  it("ends a completed job without a task immediately", async () => {
    const f = await orgRepo();
    const runId = await started(f, workflow(job("a", ["if: false"])));
    const { jobId } = await jobNamed(runId, "a");
    const socket = await watch({ f, runId, jobId }, f.owner.token);
    await settle(socket);
    expect(endOf(socket)).toEqual({ t: "end", log: "complete", durable: 0 });
    expect(await socket.closed).toEqual({ code: 1000 });
  });

  it("wakes an idle viewer for an empty final flush whose end waits for a fresh check", async () => {
    const t = await withTask();
    const model = runnerModel(t);
    await model.send(filler(0, 50));
    const socket = await watch(t, t.f.owner.token);
    await ackAll(t.runId, socket);
    await slice(t.runId);
    await at(t.runId, now(t.runId) + LOG_VIEWER_POLICY.freshMs);
    expect(await model.send([], true)).toBe(50);
    await slice(t.runId);
    await settle(socket);
    expect(endOf(socket)).toEqual({ t: "end", log: "complete", durable: 50 });
    expect(await socket.closed).toEqual({ code: 1000 });
  });

  it("sends end complete once the final request commits, then closes 1000", async () => {
    const t = await withTask();
    const socket = await watch(t, t.f.owner.token);
    const model = runnerModel(t);
    await model.send(filler(0, 10));
    await model.send(filler(10, 5), true);
    await slice(t.runId);
    expect(await socket.closed).toEqual({ code: 1000 });
    expect(received(socket)).toHaveLength(15);
    expect(endOf(socket)).toEqual({ t: "end", log: "complete", durable: 15 });
  });

  it("ends a sentinel's log at its last line, though the ack is one past it", async () => {
    const t = await withTask();
    const model = runnerModel(t);
    await model.send(filler(0, 50));
    expect(await model.send([row("")], true)).toBe(51);
    const socket = await watch(t, t.f.owner.token);
    await slice(t.runId);
    expect(await socket.closed).toEqual({ code: 1000 });
    expect(received(socket)).toHaveLength(50);
    expect(endOf(socket)).toEqual({ t: "end", log: "complete", durable: 50 });
  });

  for (const lost of [false, true])
    it(`ends an incomplete log with live-only rows below durable${lost ? ", the cache lost first" : ""}`, async () => {
      const t = await withTask();
      const socket = await watch(t, t.f.owner.token);
      const model = runnerModel(t);
      await model.send(filler(0, 50));
      await model.send(filler(50, 5));
      await settle(socket);
      expect(received(socket)).toHaveLength(55);
      if (lost) await forget(t.runId);
      await runStub(t.runId).cancel(t.f.owner.principalId, "force");
      await drain(t.runId);
      expect(endOf(socket)).toBeUndefined();
      await at(t.runId, now(t.runId) + LOG_LATE_MS);
      await drain(t.runId);
      expect(await socket.closed).toEqual({ code: 1000 });
      expect(endOf(socket)).toEqual({ t: "end", log: "incomplete", durable: 50 });
    });

  for (const lost of [false, true])
    it(`finishes a row cut mid-part before the end${lost ? ", or names it unfinished once its cache is lost" : ""}`, async () => {
      const t = await withTask();
      const socket = await watch(t, t.f.owner.token);
      const model = runnerModel(t);
      // A 300 KiB row in a hold pass: settled, live only, sent in parts. The clock passes
      // the socket's check after its first part.
      let parts = 0;
      viewerHooks.beforeSend = (id) => {
        if (id === socket.id && parts++ === 1)
          void at(t.runId, now(t.runId) + LOG_VIEWER_POLICY.freshMs);
      };
      await model.send([row("r".repeat(300 * KIB))]);
      expect(model.ack).toBe(0);
      await settle(socket);
      // `at` runs in the object: by the time it lands, at most a part or two went.
      const before = socket.frames.length;
      expect(before).toBeGreaterThan(0);
      expect(socket.frames.every((f) => f.t === "part")).toBe(true);
      expect((socket.frames.at(-1) as { end: boolean }).end).toBe(false);
      delete viewerHooks.beforeSend;
      if (lost) await forget(t.runId);
      await runStub(t.runId).cancel(t.f.owner.principalId, "force");
      await drain(t.runId);
      expect(endOf(socket)).toBeUndefined();
      await at(t.runId, now(t.runId) + LOG_LATE_MS);
      await drain(t.runId);
      expect(await socket.closed).toEqual({ code: 1000 });
      if (lost) {
        expect(endOf(socket)).toEqual({ t: "end", log: "incomplete", durable: 0, unfinished: 0 });
      } else {
        expect(received(socket).map((l) => l.c)).toEqual(["r".repeat(300 * KIB)]);
        expect(endOf(socket)).toEqual({ t: "end", log: "incomplete", durable: 0 });
      }
    });

  it("closes every socket 4404 when the run is erased, and issues no more tickets", async () => {
    const t = await withTask();
    const socket = await watch(t, t.f.owner.token);
    await ticketOf(t, t.f.owner.token);
    await runStub(t.runId).erase(t.f.repo.id);
    expect(await socket.closed).toEqual({ code: 4404 });
    expect(await inRun(t.runId, (r) => r.engine.rows("SELECT 1 FROM ci_log_tickets").length)).toBe(
      0,
    );
    expect(await ticketCall(t, t.f.owner.token)).toMatchObject({
      status: 404,
      body: { code: "run_not_found" },
    });
  });
});

// ------------------------------------------------------------------ client messages

describe("client messages", () => {
  it("answer ping with pong without the object handling a message", async () => {
    const t = await withTask();
    const socket = await watch(t, t.f.owner.token);
    const pong = new Promise<string>((resolve) =>
      socket.ws.addEventListener("message", (e) => resolve(String(e.data))),
    );
    socket.ws.send("ping");
    expect(await pong).toBe("pong");
    expect(messages.get(t.runId) ?? 0).toBe(0);
  });

  it("close 1008 on anything but an ack, and on a message over 1 KiB", async () => {
    const t = await withTask();
    const a = await watch(t, t.f.owner.token);
    await say(t.runId, a, { t: "renew" });
    expect(await a.closed).toEqual({ code: 1008 });
    const b = await watch(t, t.f.owner.token);
    await say(t.runId, b, { t: "ack", i: 0, o: 0, pad: "x".repeat(KIB) });
    expect(await b.closed).toEqual({ code: 1008 });
  });

  it("count acks that do not move forward, closing 1008 past 20 a minute", async () => {
    const t = await withTask();
    const socket = await watch(t, t.f.owner.token);
    for (let i = 0; i < LOG_VIEWER_POLICY.controlsPerMinute; i++)
      await say(t.runId, socket, { t: "ack", i: 0, o: 0 });
    expect(socket.code).toBeNull();
    await say(t.runId, socket, { t: "ack", i: 5, o: 0 });
    expect(await socket.closed).toEqual({ code: 1008 });
  });
});

// ------------------------------------------------------------------ the settled cache

describe("the settled cache", () => {
  it("is kept only for jobs watched, within 4 MiB, and dropped past it", async () => {
    const t = await withTask();
    const model = runnerModel(t);
    await model.send(filler(0, 5));
    expect(await inRun(t.runId, (r) => r.viewers.cacheBytes())).toBe(0);
    const socket = await watch(t, t.f.owner.token);
    await model.send(filler(5, 5));
    expect(await inRun(t.runId, (r) => r.viewers.cacheBytes())).toBeGreaterThan(0);
    await settle(socket);
    expect(received(socket)).toHaveLength(10);
    // Stored rows past the bound (as UTF-16 in memory): not kept.
    await model.send([row("q".repeat(2 * MIB + 64))]);
    expect(await inRun(t.runId, (r) => r.viewers.cacheBytes())).toBe(0);
    expect(model.ack).toBe(11);
    // The rest of the row from storage, a window (1 MiB) at a time.
    for (let i = 0; i < 10 && received(socket).length < 11; i++) {
      await slice(t.runId);
      await ackAll(t.runId, socket);
    }
    await settle(socket);
    expect(received(socket)).toHaveLength(11);
    socket.ws.close(1000);
    await socket.closed;
  });

  it("keeps an attachment of the largest state within the 16 KiB a socket may hold", async () => {
    const t = await withTask();
    await watch(t, t.f.owner.token);
    const [attached] = await attachments(t.runId);
    const worst = {
      ...(attached as ViewerAttachment),
      dependencies: Array.from({ length: 5 }, () => `principal:${"p".repeat(60)}:999999`),
      out: Array.from({ length: LOG_VIEWER_POLICY.windowFrames * 3 }, () => 2 ** 31 - 1),
    };
    expect(new TextEncoder().encode(JSON.stringify(worst)).length).toBeLessThan(16 * KIB);
  });
});

// ------------------------------------------------------------------ the cursor, whatever the interleaving

describe("a socket's cursor", () => {
  it("receives each index from its start once, in order, byte-identical to storage, under any interleaving", async () => {
    const t0 = await withTask();
    let round = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.record({
              op: fc.constant("log" as const),
              n: fc.integer({ min: 0, max: 30 }),
              kind: fc.integer({ min: 0, max: 5 }),
            }),
            fc.record({
              op: fc.constant("slice" as const),
              during: fc.integer({ min: -1, max: 12 }),
            }),
            fc.record({ op: fc.constant("ack" as const) }),
            fc.record({ op: fc.constant("forget" as const) }),
            fc.record({ op: fc.constant("clock" as const) }),
            fc.record({ op: fc.constant("join" as const) }),
          ),
          { minLength: 4, maxLength: 24 },
        ),
        async (ops) => {
          // A new run each time, on the same organization and runner.
          const runId = round++ === 0 ? t0.runId : await started(t0.f, one);
          const t: Task =
            runId === t0.runId
              ? t0
              : await (async () => {
                  const task = (await fetchTask(t0.runner, 0)).task;
                  if (!task) throw new Error("no task");
                  const number = (await taskRow(task.id))?.task as number;
                  const { jobId } = await jobNamed(runId, "a");
                  return { ...t0, runId, wire: task.id, number, jobId, token: jobTokenOf(task) };
                })();
          const model = runnerModel(t);
          const sockets: { c: Client; from: number }[] = [
            { c: await watch(t, t.f.owner.token), from: 0 },
          ];
          const secret = `added-${uniqueId("s")}`;
          const content = (i: number, kind: number): string[] => {
            switch (kind) {
              case 0:
                return [`${i} ${t.token} tail`];
              case 1:
                return [`${t.token.slice(0, 12)}`, `${t.token.slice(12)} after`];
              case 2:
                return [`::add-mask::${secret}`];
              case 3:
                return [`a ${secret.slice(0, 9)}`, `${secret.slice(9)} b`];
              case 4:
                return [btoa(t.token)];
              default:
                return [`plain ${i}`];
            }
          };
          const more = (n: number, kind: number): LogRow[] => {
            const rows: LogRow[] = [];
            let i = model.rows.length;
            while (rows.length < n) {
              for (const c of content(i, rows.length % 3 === 0 ? kind : 5))
                rows.push(row(c, 1_700_000_000_000 + i++));
            }
            return rows;
          };
          for (const step of ops) {
            switch (step.op) {
              case "log":
                await model.send(more(step.n, step.kind));
                break;
              case "slice": {
                if (step.during < 0) {
                  await slice(runId);
                  break;
                }
                const held = hold(runId);
                let first = true;
                viewerHooks.afterChunkGet = async () => {
                  if (first) {
                    first = false;
                    await held.hold();
                  }
                };
                const running = slice(runId);
                try {
                  await held.reached(running);
                  await model.send(more(step.during, 5));
                } finally {
                  held.release();
                  await running;
                  delete viewerHooks.afterChunkGet;
                }
                break;
              }
              case "ack":
                for (const s of sockets) await ackAll(runId, s.c);
                break;
              case "forget":
                await forget(runId);
                break;
              case "clock":
                for (const s of sockets) await ackAll(runId, s.c);
                await at(runId, now(runId) + LOG_VIEWER_POLICY.freshMs + 1);
                break;
              case "join":
                if (sockets.length < 3) {
                  const from = Math.floor(model.ack / 2);
                  sockets.push({ c: await watch(t, t.f.owner.token, { from }), from });
                }
                break;
            }
          }
          await model.send(more(1, 5), true);
          for (let i = 0; i < 400 && sockets.some((s) => s.c.code === null); i++) {
            await slice(runId);
            for (const s of sockets) if (s.c.code === null) await ackAll(runId, s.c);
          }
          const stored = await storedText(runId, t.number);
          expect(stored).toHaveLength(model.rows.length);
          for (const s of sockets) {
            expect(s.c.code).toBe(1000);
            const lines = received(s.c, s.from);
            expect(lines.map((l) => JSON.stringify(l))).toEqual(stored.slice(s.from));
            expect(endOf(s.c)).toEqual({ t: "end", log: "complete", durable: stored.length });
          }
        },
      ),
      { numRuns: 8, endOnFailure: true },
    );
  });
});

// ------------------------------------------------------------------ review regressions

describe("access decided fresh, not from the repository's cached snapshot", () => {
  /** Ages the repository's ACL snapshot past 60 s (a read still takes it for 5 minutes). */
  const ageSnapshot = (repoId: string) =>
    runInDurableObject(env.REPO.getByName(repoId), (_, state) => {
      state.storage.sql.exec("UPDATE acl_snapshot SET pulled_at = ?", Date.now() - 61_000);
    });

  it("closes 4403, sending nothing, once a reader's grant is gone though its invalidation never arrived", async () => {
    const t = await withTask();
    const reader = await user();
    await json(
      api("PUT", `${t.f.path}/collaborators/${reader.handle}`, t.f.owner.token, {
        permission: "pull",
      }),
    );
    const socket = await watch(t, reader.token);
    // The source of truth changes; the repository is not told.
    const removed = await env.ORG.getByName(t.f.org.id).removeCollaborator(
      { principalId: t.f.owner.principalId },
      t.f.repo.id,
      reader.principalId,
    );
    expect(removed.ok).toBe(true);
    await ageSnapshot(t.f.repo.id);
    await at(t.runId, now(t.runId) + LOG_VIEWER_POLICY.freshMs + 1_000);
    await runnerModel(t).send(filler(0, 50));
    await slice(t.runId);
    expect(await socket.closed).toEqual({ code: 4403 });
    expect(sent.get(socket.id) ?? 0).toBe(0);
  });

  it("closes an agent's socket 4403 once its owner's grant is gone, though its invalidation never arrived", async () => {
    const t = await withTask();
    const alice = await user();
    await json(
      api("PUT", `${t.f.path}/collaborators/${alice.handle}`, t.f.owner.token, {
        permission: "pull",
      }),
    );
    const agent = await agentFor(alice, ["actions:read"]);
    const grant = await runInDurableObject(env.ORG.getByName(t.f.org.id), (_: OrgDO, state) => {
      const sql = state.storage.sql;
      sql.exec(
        "INSERT INTO members (principal_id, handle, role, added_at) VALUES (?, ?, 'member', 0)",
        agent.id,
        agent.handle,
      );
      sql.exec(
        "INSERT INTO collaborators (repo_id, principal_id, handle, role, added_at) VALUES (?, ?, ?, 'read', 0)",
        t.f.repo.id,
        agent.id,
        agent.handle,
      );
      return sql
        .exec<{ epoch: number; version: number }>(
          `UPDATE org_meta SET acl_version = acl_version + 1
           RETURNING epoch_gen AS epoch, acl_version AS version`,
        )
        .one();
    });
    await env.REPO.getByName(t.f.repo.id).invalidateAcl(t.f.org.id, grant.epoch, grant.version);
    const socket = await watch(t, agent.own);
    const removed = await env.ORG.getByName(t.f.org.id).removeCollaborator(
      { principalId: t.f.owner.principalId },
      t.f.repo.id,
      alice.principalId,
    );
    expect(removed.ok).toBe(true);
    await ageSnapshot(t.f.repo.id);
    await at(t.runId, now(t.runId) + LOG_VIEWER_POLICY.freshMs + 1_000);
    await runnerModel(t).send(filler(0, 50));
    await slice(t.runId);
    expect(await socket.closed).toEqual({ code: 4403 });
    expect(sent.get(socket.id) ?? 0).toBe(0);
  });
});

describe("a socket's first check", () => {
  it("is the object's own: a token revoked after the Worker's check gets no row, and 4401", async () => {
    const t = await withTask();
    const minted = await json<{ id: string; token: string }>(
      api("POST", "/user/tokens", t.f.owner.token, { scopes: ["actions:read"] }),
    );
    const ticket = await ticketOf(t, minted.body.token);
    // The Worker has read and authorized the credential; it is revoked, and the upgrade takes 29 s
    // more to reach the run's object.
    const delayed = {
      ...env,
      RUN: {
        getByName(id: string) {
          const stub = env.RUN.getByName(id);
          return {
            fetch: async (request: Request) => {
              await env.DIRECTORY.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ?")
                .bind(Date.now(), minted.body.id)
                .run();
              await at(t.runId, now(t.runId) + 29_000);
              return stub.fetch(request);
            },
          };
        },
      },
    };
    const ctx = createExecutionContext();
    const response = await createApp().fetch(
      new Request(
        `${ORIGIN}/api${livePath(t.f.path, t.runId, t.jobId)}?ticket=${encodeURIComponent(ticket)}`,
        {
          headers: {
            Upgrade: "websocket",
            Authorization: `Bearer ${minted.body.token}`,
            "CF-Connecting-IP": address(),
          },
        },
      ),
      delayed as unknown as Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(101);
    const socket = await client(response, ticket);
    await at(t.runId, now(t.runId) + 59_000);
    await runnerModel(t).send(filler(0, 50));
    expect(sent.get(socket.id) ?? 0).toBe(0);
    await slice(t.runId);
    expect(await socket.closed).toEqual({ code: 4401 });
    expect(sent.get(socket.id) ?? 0).toBe(0);
  });
});

describe("the cache when sockets go", () => {
  it("is not kept when publishing closed the job's last socket", async () => {
    const t = await withTask();
    const socket = await watch(t, t.f.owner.token);
    await slice(t.runId);
    await at(t.runId, now(t.runId) + LOG_VIEWER_POLICY.lifeMs);
    await runnerModel(t).send([row("q".repeat(1900 * KIB))]);
    expect(await socket.closed).toEqual({ code: 1001 });
    expect(await attachments(t.runId)).toHaveLength(0);
    expect(await inRun(t.runId, (r) => r.viewers.cacheBytes())).toBe(0);
    expect(await inRun(t.runId, (r) => r.memory.stats().reservedBytes)).toBe(0);
  });

  it("is released when a send fails, and the socket is gone", async () => {
    const t = await withTask();
    const socket = await watch(t, t.f.owner.token);
    await slice(t.runId);
    viewerHooks.sending = (id) => {
      if (id === socket.id) throw new Error("the connection broke");
    };
    await runnerModel(t).send(filler(0, 5));
    expect(await attachments(t.runId)).toHaveLength(0);
    expect(await inRun(t.runId, (r) => r.viewers.cacheBytes())).toBe(0);
    expect(await inRun(t.runId, (r) => r.memory.stats().reservedBytes)).toBe(0);
  });
});
