// Masks sealed at rest, and delivered secrets masked in a task's log. Every
// mask row (job tokens, `::add-mask::` values, delivered secrets) is sealed
// under the CI master key, bound to a random id, and opened for each request
// that masks rows. Secrets get their own budget. An omitted row's gap is
// computed from stored crossing lengths, so masks added while its chunk is
// written count. A log request reserves its body's work and a fixed mask
// headroom at once. Interleavings are driven by hooks, never by time.
import {
  createExecutionContext,
  evictDurableObject,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  buildVariants,
  checkSecretMasks,
  type LogMask,
  MASK_SECRET_MAX_VARIANT_BYTES,
  maskCrossLength,
  maskRows,
  maskVariantBytes,
  type StoredLogLine,
} from "@fyrden/domain/ci";
import { uniqueId } from "@fyrden/testing";
import { registerSecretValue } from "@fyrden/testing/log-capture";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { ciSecretKeys, openMask } from "../src/ci/envelope.js";
import { type MaskKind, maskAdditionalData } from "../src/do/run/logs.js";
import { viewerHooks } from "../src/do/run/viewers.js";
import { ticketHash } from "../src/do/user/live.js";
import { dispatchHooks } from "../src/runner/dispatch.js";
import type { LogRow } from "../src/runner/proto/messages.js";
import { api, json } from "./helpers/api.js";
import { insertPlainMask, openedMasksOf, storedMasksOf } from "./helpers/log-masks.js";
import { decodeUpdateLogResponse, encodeUpdateLogRequest } from "./helpers/runner-proto.js";
import {
  type Credentials,
  fetchTask,
  jobTokenOf,
  jobTokensOf,
  ON,
  orgRepo,
  pendingOf,
  proto,
  registerRunner,
  repoTokenCounts,
  runnerCall,
  taskRow,
  tasksOfRun,
  tasksVersionOf,
  updateTask,
  updateTaskRaw,
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
import { logs } from "./setup/log-capture.js";

const ORIGIN = "https://fyrden.test";
const KIB = 1024;
const MIB = 1024 * KIB;
const one = workflow(job("a"));

// ------------------------------------------------------------------ generated values

/** A value made up to be masked, registered: no log line may hold it. */
const fresh = (label: string): string =>
  registerSecretValue(`${label}-${crypto.randomUUID()}-${crypto.randomUUID()}`);

afterEach(() => {
  for (const key of Object.keys(viewerHooks)) delete viewerHooks[key as keyof typeof viewerHooks];
  installCounters();
});

// ------------------------------------------------------------------ runs, tasks and log rows

/** A run of `source` in a new organization, with a runner holding its first task. */
async function withTask(source = one) {
  const f = await orgRepo();
  const runId = await started(f, source);
  const runner = await registerRunner(f.org.login, f.owner);
  const task = (await fetchTask(runner, 0)).task;
  if (!task) throw new Error("no task");
  const number = (await taskRow(task.id))?.task;
  if (typeof number !== "number") throw new Error("the task was not recorded");
  const token = jobTokenOf(task);
  registerSecretValue(token);
  return { f, runId, runner, wire: task.id, number, token };
}

type Task = Awaited<ReturnType<typeof withTask>>;

const row = (content: string): LogRow => ({ content });
const filler = (from: number, n: number): LogRow[] =>
  Array.from({ length: n }, (_, k) => row(`line ${from + k}`));

type LogRequest = { taskId: number; index: number; rows?: LogRow[]; noMore?: boolean };

const sendLog = (runner: Credentials, request: LogRequest) =>
  runnerCall("UpdateLog", encodeUpdateLogRequest(request), { credentials: runner });

async function ackOf(runner: Credentials, request: LogRequest): Promise<number> {
  return decodeUpdateLogResponse(await proto(await sendLog(runner, request))).ackIndex;
}

/** The runner as it behaves: it keeps every row past its ack and resends them with each call. */
function runnerModel(t: Pick<Task, "runner" | "wire">) {
  const rows: LogRow[] = [];
  let ack = 0;
  return {
    get ack() {
      return ack;
    },
    async send(more: LogRow[] = [], noMore = false) {
      rows.push(...more);
      ack = await ackOf(t.runner, { taskId: t.wire, index: ack, rows: rows.slice(ack), noMore });
      return ack;
    },
  };
}

/** The stored lines' text, from every chunk the manifest names, contiguous from 0. */
async function stored(runId: string, task: number): Promise<string[]> {
  const chunks = await inRun(runId, (r) =>
    r.engine.rows<{ start_index: number; end_index: number; r2_key: string }>(
      "SELECT start_index, end_index, r2_key FROM ci_log_chunks WHERE task = ? ORDER BY start_index",
      task,
    ),
  );
  const lines: StoredLogLine[] = [];
  let next = 0;
  for (const chunk of chunks) {
    expect(chunk.start_index).toBe(next);
    const object = await env.CI.get(chunk.r2_key);
    if (!object) throw new Error(`the manifest names ${chunk.r2_key}, which is not stored`);
    for (const text of (await object.text()).split("\n"))
      if (text !== "") lines.push(JSON.parse(text) as StoredLogLine);
    next = chunk.end_index;
  }
  expect(lines.map((l) => l.i)).toEqual(Array.from({ length: lines.length }, (_, i) => i));
  return lines.map((l) => ("c" in l ? l.c : ""));
}

/** Every R2 object written for the task, as text (named by the manifest or not). */
async function everyObject(runId: string, task: number): Promise<string> {
  const listed = await env.CI.list({ prefix: `runs/${runId}/` });
  const texts: string[] = [];
  for (const o of listed.objects)
    if (o.key.split("/")[4] === String(task))
      texts.push((await (await env.CI.get(o.key))?.text()) ?? "");
  return texts.join("\n");
}

/** No form of `value` the masker covers appears in `text`. */
function expectNoForm(text: string, value: string) {
  for (const variant of buildVariants(value)) expect(text).not.toContain(variant.text);
}

const maskRowsOf = storedMasksOf;

/** The task's masks as their values open under the deployment's keys, in order. */
const opened = async (runId: string, task: number) =>
  (await openedMasksOf(runId, task)).map((m) => ({
    kind: m.kind,
    from: m.from_index,
    value: m.value,
  }));

const addSecrets = (runId: string, task: number, values: readonly string[]) =>
  inRun(runId, (r) =>
    r.addSecretMasks(
      task,
      values.map((value, k) => ({ name: `SECRET_${k}`, value })),
    ),
  );

const gapOf = (runId: string, task: number) =>
  inRun(
    runId,
    (r) =>
      r.engine.rows<{ gap_remaining: number }>(
        "SELECT gap_remaining FROM ci_logs WHERE task = ?",
        task,
      )[0]?.gap_remaining,
  );

/** A reset: the next request finds a new instance, with nothing in memory. */
async function reset(runId: string) {
  await evictDurableObject(runStub(runId));
  await at(runId, now(runId));
}

/** The run object's variables, which the test may change for a while. */
type MutableEnv = Record<string, unknown>;
async function withVars<R>(
  runId: string,
  vars: Record<string, string | undefined>,
  fn: () => Promise<R>,
) {
  const saved: Record<string, PropertyDescriptor | undefined> = {};
  await inRun(runId, (r) => {
    const e = (r as unknown as { env: MutableEnv }).env;
    for (const [name, value] of Object.entries(vars)) {
      saved[name] = Object.getOwnPropertyDescriptor(e, name);
      Object.defineProperty(e, name, { configurable: true, writable: true, value });
    }
  });
  try {
    return await fn();
  } finally {
    await inRun(runId, (r) => {
      const e = (r as unknown as { env: MutableEnv }).env;
      for (const [name, descriptor] of Object.entries(saved)) {
        if (descriptor) Object.defineProperty(e, name, descriptor);
        else delete e[name];
      }
    });
  }
}

/**
 * A point a hook in the run's object waits at until released. The test learns it was reached by
 * round trips to the object, not by the hook resolving a promise of the test's: a test resumed
 * from inside the object would go on in the object's I/O context, which a reset ends.
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
    /** Waits (bounded round trips) until the hook is reached; fails if `request` settles first. */
    reached: async (request: Promise<unknown>) => {
      let settled = false;
      void request.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      for (let i = 0; i < 500 && !reached && !settled; i++)
        await runInDurableObject(runStub(runId), () => {});
      if (!reached) throw new Error("The request settled before its hook.");
    },
  };
}

// ------------------------------------------------------------------ a live viewer

const sent = new Map<string, number>();
function installCounters() {
  viewerHooks.afterSend = (socket) => sent.set(socket, (sent.get(socket) ?? 0) + 1);
}
installCounters();

async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await createApp().fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

interface Client {
  id: string;
  frames: { t: string; rows?: { i: number; c: string }[] }[];
  texts: string[];
  code: number | null;
}

const waiters: (() => void)[] = [];

/** A socket the run's owner opened on job `a`'s log. */
async function watch(t: Task): Promise<Client> {
  const { jobId } = await jobNamed(t.runId, "a");
  const path = `${t.f.path}/actions/runs/${t.runId}/jobs/${jobId}/logs/live`;
  const issued = await json<{ ticket: string }>(api("POST", path, t.f.owner.token));
  expect(issued.status).toBe(200);
  const ticket = issued.body.ticket;
  const n = Number.parseInt(uniqueId("").replace(/\D/g, "").slice(-6) || "1", 10);
  const response = await call(
    new Request(`${ORIGIN}/api${path}?ticket=${encodeURIComponent(ticket)}`, {
      headers: {
        Upgrade: "websocket",
        "CF-Connecting-IP": `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`,
        Authorization: `Bearer ${t.f.owner.token}`,
      },
    }),
  );
  expect(response.status).toBe(101);
  const ws = response.webSocket;
  if (!ws) throw new Error("no socket");
  ws.accept();
  const c: Client = {
    id: (await ticketHash(ticket)).slice(0, 16),
    frames: [],
    texts: [],
    code: null,
  };
  ws.addEventListener("message", (event) => {
    const text = String(event.data);
    if (text === "pong") return;
    c.texts.push(text);
    c.frames.push(JSON.parse(text) as Client["frames"][number]);
    for (const w of waiters.splice(0)) w();
  });
  ws.addEventListener("close", (event) => {
    c.code = event.code;
    for (const w of waiters.splice(0)) w();
  });
  // The object's own first check of the socket comes before any row.
  await drain(t.runId);
  return c;
}

/** Waits (on message events, never a timer) until `c` received every frame its socket was sent. */
async function settle(c: Client): Promise<void> {
  while (c.frames.length < (sent.get(c.id) ?? 0) && c.code === null)
    await new Promise<void>((resolve) => waiters.push(resolve));
}

const received = (c: Client) => c.frames.flatMap((f) => (f.t === "rows" ? (f.rows ?? []) : []));

// ------------------------------------------------------------------ tests

describe("mask rows at rest", () => {
  it("are sealed, every kind, with no value in any column, and open to what was registered", async () => {
    const t = await withTask();
    const secret = fresh("secret");
    const added = fresh("added");
    expect(await addSecrets(t.runId, t.number, [secret])).toEqual({ ok: true });
    const model = runnerModel(t);
    expect(await model.send([row(`::add-mask::${added}`), ...filler(1, 49)])).toBe(50);

    const rows = await maskRowsOf(t.runId, t.number);
    expect(rows.map((m) => m.kind)).toEqual(["job_token", "secret", "add_mask"]);
    const text = JSON.stringify(rows);
    for (const value of [t.token, secret, added]) {
      expectNoForm(text, value);
      expect(text).not.toContain(value.slice(0, 16));
    }
    for (const m of rows) {
      expect(m.key_id).toMatch(/^[0-9a-f]{16}$/);
      expect(m.mask_id).toMatch(/^[0-9a-f]{32}$/);
      expect(m.value).toMatch(/^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
    }
    expect(new Set(rows.map((m) => m.mask_id)).size).toBe(3);
    expect(rows.map((m) => m.cross_len)).toEqual([t.token, secret, added].map(maskCrossLength));
    expect(await opened(t.runId, t.number)).toEqual([
      { kind: "job_token", from: 0, value: t.token },
      { kind: "secret", from: 0, value: secret },
      { kind: "add_mask", from: 0, value: added },
    ]);
  });

  it("do not open with data after their ciphertext", async () => {
    const t = await withTask();
    await inRun(t.runId, (r) =>
      r.engine.exec(
        "UPDATE ci_log_masks SET value = value || '.AAAA' WHERE task = ? AND seq = 0",
        t.number,
      ),
    );
    expect((await openedMasksOf(t.runId, t.number))[0]?.value).toBeUndefined();
  });

  it("are bound to their place: a row's value moved to another row, task or kind does not open", async () => {
    const t = await withTask();
    const secret = fresh("secret");
    await addSecrets(t.runId, t.number, [secret]);
    const [token, sealed] = await maskRowsOf(t.runId, t.number);
    if (!token || !sealed) throw new Error("no mask rows");
    const keys = await ciSecretKeys(env);
    const [nonce = "", ciphertext = ""] = sealed.value.split(".");
    const open = (task: number, maskId: string, kind: MaskKind) =>
      openMask(keys, maskAdditionalData(t.runId, task, maskId, kind), {
        masterKeyId: sealed.key_id as string,
        nonce,
        ciphertext,
      });
    expect(await open(t.number, sealed.mask_id, "secret")).toBe(secret);
    expect(await open(t.number, token.mask_id, "secret")).toBeUndefined();
    expect(await open(t.number + 1, sealed.mask_id, "secret")).toBeUndefined();
    expect(await open(t.number, sealed.mask_id, "add_mask")).toBeUndefined();
  });

  it("moved to another run's task of the same number does not open there", async () => {
    const t = await withTask();
    const other = await withTask();
    expect(other.number).toBe(t.number);
    const secret = fresh("secret");
    await addSecrets(t.runId, t.number, [secret]);
    const sealed = (await maskRowsOf(t.runId, t.number)).find((m) => m.kind === "secret");
    if (!sealed) throw new Error("no secret row");
    await inRun(other.runId, (r) =>
      r.engine.exec(
        `INSERT INTO ci_log_masks (task, seq, kind, from_index, mask_id, cross_len, key_id, value)
         VALUES (?, (SELECT MAX(seq) + 1 FROM ci_log_masks WHERE task = ?), 'secret', 0, ?, ?, ?, ?)`,
        other.number,
        other.number,
        sealed.mask_id,
        sealed.cross_len,
        sealed.key_id,
        sealed.value,
      ),
    );
    expect((await opened(other.runId, other.number)).map((m) => m.value)).toEqual([
      other.token,
      undefined,
    ]);
    // Its log takes no rows while one of its masks does not open.
    const model = runnerModel(other);
    expect(await model.send(filler(0, 50))).toBe(0);
    expect(await everyObject(other.runId, other.number)).toBe("");
  });

  it("whose key is gone from the keyring leave the ack, R2 and a live viewer untouched", async () => {
    const t = await withTask();
    const secret = fresh("secret");
    expect(await addSecrets(t.runId, t.number, [secret])).toEqual({ ok: true });
    const socket = await watch(t);
    const model = runnerModel(t);
    const another = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    await withVars(
      t.runId,
      {
        CI_SECRETS_KEY: another,
        CI_SECRETS_KEY_NEXT: undefined,
        CI_SECRETS_KEYS_RETIRED: undefined,
      },
      async () => {
        // A few rows are held, settled rows of them would go live; many are stored at once.
        expect(await model.send([row(`s ${secret}`), row(`t ${t.token}`)])).toBe(0);
        expect(await model.send(filler(2, 48))).toBe(0);
        expect(await model.send([], true)).toBe(0);
      },
    );
    expect(await everyObject(t.runId, t.number)).toBe("");
    expect(await inRun(t.runId, (r) => r.engine.rows("SELECT * FROM ci_log_chunks"))).toEqual([]);
    await drain(t.runId);
    await settle(socket);
    expect(received(socket)).toEqual([]);
    expect(logs.lines.some((l) => l.includes("log masks do not open"))).toBe(true);
    // The key back, the same rows store masked.
    expect(await model.send([], true)).toBe(50);
    expect((await stored(t.runId, t.number)).slice(0, 2)).toEqual(["s ***", "t ***"]);
  });

  it("whose key is gone leave a watched job's cached settled rows in place", async () => {
    const t = await withTask();
    await watch(t);
    const model = runnerModel(t);
    // Too few rows to store: the settled ones go live and are kept for the job.
    expect(await model.send([row("a"), row("b")])).toBe(0);
    const cached = await inRun(t.runId, (r) => r.viewers.cacheBytes());
    expect(cached).toBeGreaterThan(0);
    const another = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    await withVars(
      t.runId,
      {
        CI_SECRETS_KEY: another,
        CI_SECRETS_KEY_NEXT: undefined,
        CI_SECRETS_KEYS_RETIRED: undefined,
      },
      async () => {
        expect(await model.send([row("c")])).toBe(0);
      },
    );
    expect(logs.lines.some((l) => l.includes("log masks do not open"))).toBe(true);
    expect(await inRun(t.runId, (r) => r.viewers.cacheBytes())).toBe(cached);
  });
  it("copied plain from v6 (no key id) are still read", async () => {
    const t = await withTask();
    const value = fresh("legacy");
    await inRun(t.runId, (r) => insertPlainMask(r, t.number, "add_mask", 0, value));
    const model = runnerModel(t);
    expect(await model.send([row(`old ${value}`), row(`token ${t.token}`), ...filler(2, 48)])).toBe(
      50,
    );
    expect((await stored(t.runId, t.number)).slice(0, 2)).toEqual(["old ***", "token ***"]);
  });
});

describe("two mask writers that read the same count", () => {
  /** Holds every mask write before its transaction until both writers are there, then lets both go. */
  async function gateBoth(runId: string) {
    let arrived = 0;
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    await inRun(runId, (r) => {
      r.hooks = {
        beforeMaskCommit: async () => {
          arrived++;
          await released;
        },
      };
    });
    return {
      release,
      get arrived() {
        return arrived;
      },
      /** Bounded round trips to the object until both writers wait; fails if either settled. */
      both: async (writes: Promise<unknown>[]) => {
        let settled = 0;
        const count = () => {
          settled++;
        };
        // Both outcomes handled, so a rejected write leaves no unhandled promise behind.
        for (const write of writes) write.then(count, count);
        for (let i = 0; i < 500 && arrived < 2 && settled === 0; i++)
          await runInDurableObject(runStub(runId), () => {});
        if (arrived < 2) throw new Error("a writer settled before its hook");
      },
    };
  }

  it("commit one after the other: the second retries, and each value is stored once", async () => {
    const t = await withTask();
    const [x, y, z] = [fresh("x"), fresh("y"), fresh("z")];
    const gate = await gateBoth(t.runId);
    const writes = [addSecrets(t.runId, t.number, [x, y]), addSecrets(t.runId, t.number, [y, z])];
    try {
      await gate.both(writes);
      gate.release();
      expect(await Promise.all(writes)).toEqual([{ ok: true }, { ok: true }]);
    } finally {
      gate.release();
      await Promise.allSettled(writes);
      await inRun(t.runId, (r) => {
        r.hooks = {};
      });
    }
    // The loser read the count again, sealed only what was new, and committed.
    expect(gate.arrived).toBe(3);
    const values = (await opened(t.runId, t.number)).map((m) => m.value);
    expect(values.slice(0, 1)).toEqual([t.token]);
    expect([...values.slice(1)].sort()).toEqual([x, y, z].sort());
  });

  it("past the budget together: the one that retries is refused, and the cap holds", async () => {
    const t = await withTask();
    // Each about 150 KiB of value text; two are over the 256 KiB budget.
    const big = (label: string) => `${fresh(label)}\n${"ab\n".repeat(50 * KIB)}`;
    const [a, b] = [big("a"), big("b")];
    const gate = await gateBoth(t.runId);
    const writes = [addSecrets(t.runId, t.number, [a]), addSecrets(t.runId, t.number, [b])];
    try {
      await gate.both(writes);
      gate.release();
      const answers = await Promise.all(writes);
      expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
      expect(answers.find((answer) => !answer.ok)).toMatchObject({
        ok: false,
        code: "secrets_unmaskable",
        limit: "bytes",
      });
    } finally {
      gate.release();
      await Promise.allSettled(writes);
      await inRun(t.runId, (r) => {
        r.hooks = {};
      });
    }
    const values = (await opened(t.runId, t.number)).map((m) => m.value);
    expect(values).toHaveLength(2);
    expect([a, b]).toContain(values[1]);
  });
});

describe("a mask appended during an UpdateLog's confirmation", () => {
  /** Adds `secret` once the request's task is confirmed, recording the pool's reserved bytes then. */
  async function addOnConfirm(t: Task, secret: string) {
    const seen: { atConfirm?: number; later?: number } = {};
    await inRun(t.runId, (r) => {
      r.hooks = {
        afterLogConfirm: async () => {
          seen.atConfirm = r.memory.stats().reservedBytes;
          expect(await r.addSecretMasks(t.number, [{ name: "LATE", value: secret }])).toEqual({
            ok: true,
          });
        },
        beforeLogStore: () => {
          seen.later = r.memory.stats().reservedBytes;
        },
      };
      viewerHooks.beforePublish = () => {
        seen.later ??= r.memory.stats().reservedBytes;
      };
    });
    return seen;
  }

  it("is opened within the request's reservation on the append path", async () => {
    const t = await withTask();
    const secret = fresh("secret");
    const seen = await addOnConfirm(t, secret);
    try {
      const model = runnerModel(t);
      expect(await model.send([row(`s ${secret}`), ...filler(1, 49)])).toBe(50);
    } finally {
      await inRun(t.runId, (r) => {
        r.hooks = {};
      });
    }
    expect(seen.atConfirm).toBeGreaterThanOrEqual(1024 * KIB);
    expect(seen.later).toBe(seen.atConfirm);
    expect((await stored(t.runId, t.number))[0]).toBe("s ***");
  });

  it("is opened within the request's reservation on the settled-viewer path", async () => {
    const t = await withTask();
    const secret = fresh("secret");
    const socket = await watch(t);
    const seen = await addOnConfirm(t, secret);
    try {
      const model = runnerModel(t);
      // Too few rows to store at once: the settled ones go live only.
      expect(await model.send([row(`s ${secret}`), row("next")])).toBe(0);
    } finally {
      await inRun(t.runId, (r) => {
        r.hooks = {};
      });
    }
    expect(seen.atConfirm).toBeGreaterThanOrEqual(1024 * KIB);
    expect(seen.later).toBe(seen.atConfirm);
    await drain(t.runId);
    await settle(socket);
    expect(received(socket).map((line) => line.c)).toEqual(["s ***", "next"]);
    expect(socket.texts.join("\n")).not.toContain(secret);
  });
});

describe("a delivered secret", () => {
  for (const between of ["nothing", "a reset"] as const) {
    it(`printed whole, base64 and split across two requests with ${between} between them is masked stored and live`, async () => {
      const t = await withTask();
      const secret = fresh("secret");
      expect(await addSecrets(t.runId, t.number, [secret])).toEqual({ ok: true });
      const socket = await watch(t);
      const model = runnerModel(t);
      // The split row is held (its partial match may still complete); the rows before it store.
      const first = [
        ...filler(0, 47),
        row(`whole ${secret} end`),
        row(btoa(`k=${secret}`)),
        row(`split ${secret.slice(0, 30)}`),
      ];
      expect(await model.send(first)).toBe(49);
      if (between === "a reset") await reset(t.runId);
      expect(await model.send([row(`${secret.slice(30)} tail`), ...filler(51, 49)])).toBe(100);
      const lines = await stored(t.runId, t.number);
      expect(lines.slice(47, 51)).toEqual([
        "whole *** end",
        expect.stringContaining("***"),
        "split ***",
        "*** tail",
      ]);
      const all = await everyObject(t.runId, t.number);
      expectNoForm(all, secret);
      expect(all).not.toContain(secret.slice(0, 30));
      expect(all).not.toContain(secret.slice(30));

      await drain(t.runId);
      await settle(socket);
      const live = received(socket);
      expect(live.length).toBeGreaterThanOrEqual(51);
      for (const line of live) expect(line.c).toBe(lines[line.i]);
      const frames = socket.texts.join("\n");
      expectNoForm(frames, secret);
      expect(frames).not.toContain(secret.slice(30));
    });
  }
});

describe("masks added while a flush writes its chunk", () => {
  it("a re-offer's token committed during the R2 write, and the flush's own value, both open after a reset", async () => {
    const { runId, runner, lost, number, version } = await lostAnswer();
    const first = jobTokenOf(lost);
    registerSecretValue(first);
    const added = fresh("added");
    const minted = hold(runId);
    const put = hold(runId);
    let second = "";
    await inRun(runId, (r) => {
      r.hooks = {
        afterMint: (token) => {
          second = token;
          return minted.hold();
        },
        afterLogPut: () => put.hold(),
      };
    });
    const pending: Promise<unknown>[] = [];
    try {
      // A re-offer minted before the log's first request confirms the task.
      const reoffer = fetchTask(runner, version);
      pending.push(reoffer);
      await minted.reached(reoffer);
      registerSecretValue(second);
      const storing = ackOf(runner, {
        taskId: lost.id,
        index: 0,
        rows: [row(`::add-mask::${added}`), ...filler(1, 49)],
      });
      pending.push(storing);
      await put.reached(storing);
      // While the chunk is written, the re-offer seals and commits its token (and then loses
      // to the confirmation: it is never handed out, but the runner might have it).
      minted.release();
      expect((await reoffer).task).toBeUndefined();
      put.release();
      expect(await storing).toBe(50);
      await inRun(runId, (r) => {
        r.hooks = {};
      });
      expect(await opened(runId, number)).toEqual([
        { kind: "job_token", from: 0, value: first },
        { kind: "job_token", from: 0, value: second },
        { kind: "add_mask", from: 0, value: added },
      ]);
      await reset(runId);
      const rows = [row(`a ${added}`), row(`b ${second}`), row(`c ${first}`), ...filler(53, 47)];
      expect(await ackOf(runner, { taskId: lost.id, index: 50, rows })).toBe(100);
      expect((await stored(runId, number)).slice(50, 53)).toEqual(["a ***", "b ***", "c ***"]);
    } finally {
      minted.release();
      put.release();
      await Promise.allSettled(pending);
      await inRun(runId, (r) => {
        r.hooks = {};
      });
    }
  });

  it("an omitted row counts a secret mask added during its R2 write, then a reset", async () => {
    const t = await withTask();
    const secret = fresh("secret".repeat(8));
    expect(maskCrossLength(secret)).toBeGreaterThan(maskCrossLength(t.token));
    await inRun(t.runId, (r) => {
      r.hooks = {
        afterLogPut: async () => {
          expect(await r.addSecretMasks(t.number, [{ name: "LATE", value: secret }])).toEqual({
            ok: true,
          });
        },
      };
    });
    try {
      expect(
        await ackOf(t.runner, { taskId: t.wire, index: 0, rows: [row("x".repeat(4 * MIB))] }),
      ).toBe(1);
    } finally {
      await inRun(t.runId, (r) => {
        r.hooks = {};
      });
    }
    expect(await gapOf(t.runId, t.number)).toBe(maskCrossLength(secret));
    await reset(t.runId);
    // The secret's tail, past what the token's gap alone would cover.
    const tail = secret.slice(1);
    expect(tail.length).toBeGreaterThan(maskCrossLength(t.token));
    expect(
      await ackOf(t.runner, {
        taskId: t.wire,
        index: 1,
        rows: [row(tail), ...filler(2, 49)],
      }),
    ).toBe(51);
    const lines = await stored(t.runId, t.number);
    expect(lines[1]).toBe("***");
    expect(await everyObject(t.runId, t.number)).not.toContain(tail.slice(-20));
  });
});

describe("the secret budget", () => {
  it("accumulates over re-offers, adding only new values, and refuses past it by name and size", async () => {
    const t = await withTask();
    const a = fresh("a");
    const b = fresh("b");
    expect(await addSecrets(t.runId, t.number, [a])).toEqual({ ok: true });
    expect(await addSecrets(t.runId, t.number, [a, b])).toEqual({ ok: true });
    expect((await opened(t.runId, t.number)).map((m) => m.value)).toEqual([t.token, a, b]);
    const big = "z".repeat(32 * KIB);
    const refused = await addSecrets(t.runId, t.number, [a, big]);
    expect(refused).toMatchObject({
      ok: false,
      code: "secrets_unmaskable",
      limit: "variants",
      secrets: [{ name: "SECRET_1", bytes: 32 * KIB }],
    });
    expect(JSON.stringify(refused)).not.toContain(a);
    expect(JSON.stringify(refused)).not.toContain("zzzz");
    expect((await opened(t.runId, t.number)).map((m) => m.value)).toEqual([t.token, a, b]);
  });

  it("counts values with no variant toward the plaintext budget, across re-offers", async () => {
    const t = await withTask();
    // Distinct whitespace around one char: masked by their trimmed lines, which are too short.
    const values = Array.from({ length: 5 }, (_, k) => `${" ".repeat(60 * KIB)}${k}`);
    expect(await addSecrets(t.runId, t.number, values.slice(0, 2))).toEqual({ ok: true });
    expect(await addSecrets(t.runId, t.number, values.slice(0, 4))).toEqual({ ok: true });
    const refused = await addSecrets(t.runId, t.number, values);
    expect(refused).toMatchObject({
      ok: false,
      code: "secrets_unmaskable",
      limit: "bytes",
      secrets: [{ name: "SECRET_4", bytes: 60 * KIB + 1, variantBytes: 0 }],
    });
    expect(await addSecrets(t.runId, t.number, [values[4] as string])).toMatchObject({
      ok: false,
      limit: "bytes",
    });
    expect((await maskRowsOf(t.runId, t.number)).map((m) => m.kind)).toEqual([
      "job_token",
      ...values.slice(0, 4).map(() => "secret"),
    ]);
  });

  it("gives a one-character value no slot", async () => {
    const t = await withTask();
    // "%" has a variant ("%25"), but one char is never masked.
    expect(await addSecrets(t.runId, t.number, ["%", "x"])).toEqual({ ok: true });
    expect((await maskRowsOf(t.runId, t.number)).map((m) => m.kind)).toEqual(["job_token"]);
  });

  it("is refused for a task of an untrusted run, which gets no secrets", async () => {
    const t = await withTask();
    await inRun(t.runId, (r) => r.engine.exec("UPDATE runs SET trust = 'untrusted'"));
    expect(await addSecrets(t.runId, t.number, [fresh("secret")])).toEqual({
      ok: false,
      code: "untrusted_run",
    });
    expect((await maskRowsOf(t.runId, t.number)).map((m) => m.kind)).toEqual(["job_token"]);
  });

  it("is refused for a task of an untrusted run whose log is finalized", async () => {
    const t = await withTask();
    await inRun(t.runId, (r) => r.engine.exec("UPDATE runs SET trust = 'untrusted'"));
    const model = runnerModel(t);
    expect(await model.send(filler(0, 3), true)).toBe(3);
    expect(
      await inRun(
        t.runId,
        (r) =>
          r.engine.rows<{ finalized: number }>(
            "SELECT finalized FROM ci_logs WHERE task = ?",
            t.number,
          )[0]?.finalized,
      ),
    ).toBe(1);
    expect(await addSecrets(t.runId, t.number, [fresh("secret")])).toEqual({
      ok: false,
      code: "untrusted_run",
    });
  });

  it("registers secrets reading the run's id and trust once, never its whole record", async () => {
    const t = await withTask();
    const queries = await recordQueries(t.runId, () =>
      addSecrets(
        t.runId,
        t.number,
        Array.from({ length: 5 }, () => fresh("secret")),
      ),
    );
    expect(queries.filter((q) => /\bFROM runs\b/.test(q))).toEqual([
      expect.stringMatching(/^SELECT run_id, trust FROM runs\b/),
    ]);
  });

  it("full, still lets an ::add-mask:: value register and mask", async () => {
    const t = await withTask();
    const secrets: string[] = [];
    for (;;) {
      const next = fresh("s");
      if (!(await addSecrets(t.runId, t.number, [next])).ok) break;
      secrets.push(next);
    }
    expect(secrets.length).toBeGreaterThan(8);
    const added = fresh("added");
    const model = runnerModel(t);
    expect(
      await model.send([row(`::add-mask::${added}`), row(`v ${added}`), ...filler(2, 48)]),
    ).toBe(50);
    expect((await stored(t.runId, t.number)).slice(0, 2)).toEqual(["::add-mask::***", "v ***"]);
    expect((await opened(t.runId, t.number)).at(-1)).toEqual({
      kind: "add_mask",
      from: 0,
      value: added,
    });
  });
});

describe("without a CI master key that seals", () => {
  /** The Worker's variables for a runner call, `CI_SECRETS_KEY` as given (empty: no key that seals). */
  const workerKey = (key: string): Partial<Env> => ({ ...ON, CI_SECRETS_KEY: key });

  for (const who of ["another runner", "the same runner"] as const)
    it(`a key gone after the poll's own check: a first offer mints no token, assigns nothing and releases its claim; ${who} at version 0 is given the job once the key is back`, async () => {
      const f = await orgRepo();
      const runner = await registerRunner(f.org.login, f.owner);
      const runId = await started(f, one);
      const tokensBefore = await repoTokens(f.repo.id);
      // The Worker's request sees the key; the run's object, asked after, does not.
      const seen = workerKey(env.CI_SECRETS_KEY);
      await withVars(runId, { CI_SECRETS_KEY: undefined }, async () => {
        expect((await fetchTask(runner, 0, { overrides: seen })).task).toBeUndefined();
      });
      const [refused, ...others] = await tasksOfRun(runId);
      if (!refused) throw new Error("the poll claimed nothing");
      expect(others).toEqual([]);
      expect(await jobTokensOf(refused.id)).toEqual([]);
      expect(refused.task).toBeNull();
      // Given up, not held for its lease: the job is free for the next poll at once.
      expect(refused.superseded_at).not.toBeNull();
      expect((await pendingOf(runId)).map((p) => [p.claimed_by, p.claim_until])).toEqual([
        [null, null],
      ]);
      expect(await repoTokens(f.repo.id)).toBe(tokensBefore);
      expect(await inRun(runId, (r) => r.engine.rows("SELECT * FROM ci_log_masks"))).toEqual([]);
      expect(
        await inRun(runId, (r) =>
          r.engine.rows<{ task: number | null }>("SELECT task FROM run_instances"),
        ),
      ).toEqual([{ task: null }]);
      expect(logs.lines.some((l) => l.includes("no CI master key"))).toBe(true);
      // The key back (the clock never moves, so no lease has lapsed), a poll at version 0 is
      // given the job.
      const next = who === "another runner" ? await registerRunner(f.org.login, f.owner) : runner;
      const task = (await fetchTask(next, 0)).task;
      if (!task) throw new Error("no task once the key is back");
      registerSecretValue(jobTokenOf(task));
      expect(task.id).not.toBe(refused.id);
      expect((await taskRow(task.id))?.run_id).toBe(runId);
    });

  it("polls of two runners claim nothing, write nothing and leave the version; with the key back a poll gets the job", async () => {
    const f = await orgRepo();
    const runners = [
      await registerRunner(f.org.login, f.owner),
      await registerRunner(f.org.login, f.owner),
    ];
    const runId = await started(f, one);
    const pending = await pendingOf(runId);
    expect(pending.length).toBe(1);
    const version = await tasksVersionOf(f.org.id);
    expect(version).toBeGreaterThan(0);
    const tokensBefore = await repoTokens(f.repo.id);
    const keyless = workerKey("");
    const asked = runners.map(() => 0);
    await withVars(runId, { CI_SECRETS_KEY: undefined }, async () => {
      for (let poll = 0; poll < 3; poll++)
        for (const [k, runner] of runners.entries()) {
          const answer = await fetchTask(runner, asked[k] as number, { overrides: keyless });
          expect(answer.task).toBeUndefined();
          // The caller's own version: it searches again once there is a key.
          expect(answer.tasksVersion).toBe(asked[k]);
          asked[k] = answer.tasksVersion;
        }
    });
    expect(await tasksOfRun(runId)).toEqual([]);
    expect(await pendingOf(runId)).toEqual(pending);
    expect(await tasksVersionOf(f.org.id)).toBe(version);
    expect(await repoTokens(f.repo.id)).toBe(tokensBefore);
    expect(
      logs.lines.some((l) => l.includes("no task searched for: there is no CI master key")),
    ).toBe(true);
    const [first] = runners;
    if (!first) throw new Error("no runner");
    const task = (await fetchTask(first, asked[0] as number)).task;
    if (!task) throw new Error("no task once the key is back");
    registerSecretValue(jobTokenOf(task));
    expect((await taskRow(task.id))?.run_id).toBe(runId);
  });

  it("a keyless poll that cannot search leaves another runner's lapsed claim and the version alone", async () => {
    const f = await orgRepo();
    // An ephemeral runner that took and confirmed its one task: its polls never search.
    const ephemeral = await registerRunner(f.org.login, f.owner, { ephemeral: true });
    await started(f, one);
    const taken = (await fetchTask(ephemeral, 0)).task;
    if (!taken) throw new Error("no task");
    registerSecretValue(jobTokenOf(taken));
    await updateTask(ephemeral, taken.id);
    // Another runner's claim of a second run's job, whose Worker died: the claim lapses.
    const runId = await started(f, one);
    const other = await registerRunner(f.org.login, f.owner);
    dispatchHooks.afterClaim = () => {
      throw new Error("the Worker died");
    };
    try {
      expect((await runnerCall("FetchTask", new Uint8Array(), { credentials: other })).status).toBe(
        500,
      );
    } finally {
      delete dispatchHooks.afterClaim;
    }
    await env.DIRECTORY.prepare("UPDATE ci_pending_jobs SET claim_until = 0 WHERE run_id = ?")
      .bind(runId)
      .run();
    const pending = await pendingOf(runId);
    expect(pending[0]?.claimed_by).toBe(other.id);
    const version = await tasksVersionOf(f.org.id);
    await withVars(runId, { CI_SECRETS_KEY: undefined }, async () => {
      expect((await fetchTask(ephemeral, 0, { overrides: workerKey("") })).task).toBeUndefined();
    });
    expect(await pendingOf(runId)).toEqual(pending);
    expect(await tasksVersionOf(f.org.id)).toBe(version);
    // The key back, an eligible runner gets the job.
    const task = (await fetchTask(other, 0)).task;
    if (!task) throw new Error("no task once the key is back");
    registerSecretValue(jobTokenOf(task));
    expect((await taskRow(task.id))?.run_id).toBe(runId);
  });

  for (const gone of ["before the poll's own check", "after the poll's own check"] as const)
    it(`a re-offer while the first answer is in flight keeps the task the runner holds: key gone ${gone}`, async () => {
      const { runId, runner, lost, number, version } = await lostAnswer();
      const first = jobTokenOf(lost);
      registerSecretValue(first);
      const seen = workerKey(gone === "after the poll's own check" ? env.CI_SECRETS_KEY : "");
      await withVars(runId, { CI_SECRETS_KEY: undefined }, async () => {
        expect((await fetchTask(runner, version, { overrides: seen })).task).toBeUndefined();
      });
      expect((await taskRow(lost.id))?.superseded_at).toBeNull();
      expect((await jobTokensOf(lost.id)).map((t) => t.revoked_at)).toEqual([null]);
      // The key back, the runner goes on with the task it was given first.
      expect((await updateTaskRaw(runner, lost.id)).status).toBe(200);
      const model = runnerModel({ runner, wire: lost.id });
      expect(await model.send([row(`t ${first}`), ...filler(1, 49)])).toBe(50);
      expect((await stored(runId, number))[0]).toBe("t ***");
    });

  it("a key gone between the check and the seal revokes the new token and keeps the task offered", async () => {
    const { runId, runner, lost, number, version } = await lostAnswer();
    const first = jobTokenOf(lost);
    registerSecretValue(first);
    await withVars(runId, { CI_SECRETS_KEY: env.CI_SECRETS_KEY }, async () => {
      await inRun(runId, (r) => {
        r.hooks = {
          afterMint: (token) => {
            registerSecretValue(token);
          },
          beforeTokenMask: () => {
            (r as unknown as { env: MutableEnv }).env.CI_SECRETS_KEY = undefined;
          },
        };
      });
      try {
        expect((await fetchTask(runner, version)).task).toBeUndefined();
      } finally {
        await inRun(runId, (r) => {
          r.hooks = {};
        });
      }
    });
    expect((await taskRow(lost.id))?.superseded_at).toBeNull();
    const tokens = await jobTokensOf(lost.id);
    expect(tokens.length).toBe(2);
    expect(tokens[0]?.revoked_at).toBeNull();
    expect(tokens[1]?.revoked_at).not.toBeNull();
    expect((await updateTaskRaw(runner, lost.id)).status).toBe(200);
    const model = runnerModel({ runner, wire: lost.id });
    expect(await model.send([row(`t ${first}`), ...filler(1, 49)])).toBe(50);
    expect((await stored(runId, number))[0]).toBe("t ***");
  });

  it("rows registering a value are not stored until one does; the stored masks still open", async () => {
    const t = await withTask();
    const added = fresh("added");
    const model = runnerModel(t);
    const rows = [row(`::add-mask::${added}`), row(`v ${added} ${t.token}`), ...filler(2, 48)];
    // The current key misconfigured, the one the token is sealed under kept as retired.
    await withVars(
      t.runId,
      { CI_SECRETS_KEY: "", CI_SECRETS_KEYS_RETIRED: env.CI_SECRETS_KEY },
      async () => {
        expect(await model.send(rows)).toBe(0);
        expect(await model.send()).toBe(0);
      },
    );
    expect(await everyObject(t.runId, t.number)).toBe("");
    expect(await model.send()).toBe(50);
    expect((await stored(t.runId, t.number)).slice(0, 2)).toEqual(["::add-mask::***", "v *** ***"]);
  });

  it("a secret is refused before anything is stored", async () => {
    const t = await withTask();
    const secret = fresh("secret");
    await withVars(t.runId, { CI_SECRETS_KEY: undefined }, async () => {
      expect(await addSecrets(t.runId, t.number, [secret])).toEqual({
        ok: false,
        code: "ci_key_unavailable",
      });
    });
    expect((await maskRowsOf(t.runId, t.number)).map((m) => m.kind)).toEqual(["job_token"]);
  });
});

describe("with a current CI master key, but the task's stored masks sealed under one gone", () => {
  /** A key that seals, other than the one the task's masks were sealed under. */
  const otherKey = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  const rotated = () => ({
    CI_SECRETS_KEY: otherKey(),
    CI_SECRETS_KEY_NEXT: undefined,
    CI_SECRETS_KEYS_RETIRED: undefined,
  });

  it("keys rotated after the check, before the mask: the new token is revoked, the offer and its token kept, and another queued job given in the same poll", async () => {
    const { f, runId, runner, lost, version } = await lostAnswer();
    const first = jobTokenOf(lost);
    registerSecretValue(first);
    const otherRun = await started(f, one);
    let task: Awaited<ReturnType<typeof fetchTask>>["task"];
    const keys = rotated();
    await withVars(runId, { ...keys, CI_SECRETS_KEY: env.CI_SECRETS_KEY }, async () => {
      await inRun(runId, (r) => {
        r.hooks = {
          afterMint: (token) => {
            registerSecretValue(token);
          },
          beforeTokenMask: () => {
            (r as unknown as { env: MutableEnv }).env.CI_SECRETS_KEY = keys.CI_SECRETS_KEY;
          },
        };
      });
      try {
        task = (await fetchTask(runner, version)).task;
      } finally {
        await inRun(runId, (r) => {
          r.hooks = {};
        });
      }
    });
    if (!task) throw new Error("no other job was offered");
    registerSecretValue(jobTokenOf(task));
    expect((await taskRow(task.id))?.run_id).toBe(otherRun);
    // The offer stands, its first token valid; only the token minted for the refusal is revoked.
    const offer = await taskRow(lost.id);
    expect(offer?.superseded_at).toBeNull();
    expect(offer?.ended_at).toBeNull();
    const tokens = await jobTokensOf(lost.id);
    expect(tokens.length).toBe(2);
    expect(tokens[0]?.revoked_at).toBeNull();
    expect(tokens[1]?.revoked_at).not.toBeNull();
    expect(logs.lines.some((l) => l.includes("no CI master key"))).toBe(false);
    expect(
      logs.lines.some((l) => l.includes("masks do not open") && l.includes(String(lost.id))),
    ).toBe(true);
  });

  it("re-offered again on later polls, mints no token, and the runner is given other work each time", async () => {
    const { f, runId, runner, lost, version } = await lostAnswer();
    registerSecretValue(jobTokenOf(lost));
    const others = [await started(f, one), await started(f, one), await started(f, one)];
    const tokensBefore = await repoTokenCounts(f.repo.id);
    const given: string[] = [];
    await withVars(runId, rotated(), async () => {
      await inRun(runId, (r) => {
        r.hooks = {
          afterMint: (token) => {
            registerSecretValue(token);
          },
        };
      });
      try {
        for (let poll = 0; poll < others.length; poll++) {
          // Repeating the lost answer's version re-offers the unreadable offer each time: the
          // task given before is confirmed, so it is no longer a live offer.
          const task = (await fetchTask(runner, version)).task;
          if (!task) throw new Error(`no other job on poll ${poll}`);
          registerSecretValue(jobTokenOf(task));
          given.push((await taskRow(task.id))?.run_id as string);
          await updateTask(runner, task.id);
        }
      } finally {
        await inRun(runId, (r) => {
          r.hooks = {};
        });
      }
    });
    expect(given.sort()).toEqual([...others].sort());
    // One token for each other task and none for the re-offers: nothing minted, nothing revoked.
    expect(await repoTokenCounts(f.repo.id)).toEqual({
      minted: tokensBefore.minted + others.length,
      revoked: tokensBefore.revoked,
    });
    const offer = await taskRow(lost.id);
    expect(offer?.superseded_at).toBeNull();
    expect(offer?.ended_at).toBeNull();
    expect((await jobTokensOf(lost.id)).map((t) => t.revoked_at)).toEqual([null]);
    expect(
      logs.lines.filter((l) => l.includes("masks do not open") && l.includes(String(lost.id)))
        .length,
    ).toBeGreaterThanOrEqual(others.length);
  });

  it("re-offered with no other job to give, keeps the runner's version, so the offer is made again once its masks open", async () => {
    const { runId, runner, lost, version } = await lostAnswer();
    registerSecretValue(jobTokenOf(lost));
    const refused = await withVars(runId, rotated(), () => fetchTask(runner, version));
    expect(refused.task).toBeUndefined();
    expect(refused.tasksVersion).toBe(version);
    await inRun(runId, (r) => {
      r.hooks = {
        afterMint: (token) => {
          registerSecretValue(token);
        },
      };
    });
    try {
      const again = (await fetchTask(runner, refused.tasksVersion)).task;
      expect(again?.id).toBe(lost.id);
    } finally {
      await inRun(runId, (r) => {
        r.hooks = {};
      });
    }
  });

  it("a secret is refused as unreadable, not as a missing key, and nothing is added", async () => {
    const t = await withTask();
    expect(await addSecrets(t.runId, t.number, [fresh("secret")])).toEqual({ ok: true });
    await withVars(t.runId, rotated(), async () => {
      expect(await addSecrets(t.runId, t.number, [fresh("secret")])).toEqual({
        ok: false,
        code: "masks_unreadable",
      });
    });
    expect((await maskRowsOf(t.runId, t.number)).map((m) => m.kind)).toEqual([
      "job_token",
      "secret",
    ]);
  });
});

describe("admission with mask headroom", () => {
  /** Rows making a body of more than 4 MiB, the first printing `secret`. */
  const large = (secret: string, mib: number) => {
    const piece = "y".repeat(64 * KIB);
    const count = Math.ceil((mib * MIB) / piece.length) + 1;
    return [row(`s ${secret}`), ...Array.from({ length: count }, (_, k) => row(`${k} ${piece}`))];
  };

  it("refuses for memory without reading the run's whole record", async () => {
    const t = await withTask();
    await inRun(t.runId, (r) => {
      const taken = r.memory.tryReserve(r.memory.stats().totalBytes - 1);
      if (!taken) throw new Error("the pool is taken");
      held.set(t.runId, taken);
    });
    try {
      const queries = await recordQueries(t.runId, async () => {
        expect(await ackOf(t.runner, { taskId: t.wire, index: 0, rows: filler(0, 50) })).toBe(0);
      });
      expect(logs.lines.some((l) => l.includes("not admitted"))).toBe(true);
      expect(queries.filter((q) => /\bFROM runs\b/.test(q))).toEqual([
        expect.stringMatching(/^SELECT run_id, trust FROM runs\b/),
      ]);
    } finally {
      await inRun(t.runId, () => {
        held.get(t.runId)?.release();
        held.delete(t.runId);
      });
    }
  });

  it("a 4 MiB body on a task with secret masks is admitted after resends, and its ack advances", async () => {
    const t = await withTask();
    const secret = fresh("secret");
    await addSecrets(t.runId, t.number, [secret]);
    const rows = large(secret, 4);
    // Another holder of a little of the pool: a full-size request needs every byte of it.
    await inRun(t.runId, (r) => {
      const taken = r.memory.tryReserve(1);
      if (!taken) throw new Error("the pool is taken");
      held.set(t.runId, taken);
    });
    expect(await inRun(t.runId, (r) => r.memory.stats().totalBytes)).toBe(17 * MIB);
    expect(await ackOf(t.runner, { taskId: t.wire, index: 0, rows })).toBe(0);
    expect(await ackOf(t.runner, { taskId: t.wire, index: 0, rows })).toBe(0);
    expect(logs.lines.some((l) => l.includes("not admitted"))).toBe(true);
    await inRun(t.runId, () => {
      held.get(t.runId)?.release();
      held.delete(t.runId);
    });
    const ack = await ackOf(t.runner, { taskId: t.wire, index: 0, rows });
    expect(ack).toBeGreaterThan(1);
    expect((await stored(t.runId, t.number))[0]).toBe("s ***");
    expect(await inRun(t.runId, (r) => r.memory.stats().reservedBytes)).toBe(0);
  });

  it("four large requests of different tasks with masks never wait on each other", async () => {
    const source = workflow(["a", "b", "c", "d"].map((id) => job(id)).join("\n"));
    const f = await orgRepo();
    const runId = await started(f, source);
    const tasks: {
      runner: Credentials;
      wire: number;
      number: number;
      secret: string;
      rows: LogRow[];
    }[] = [];
    for (let k = 0; k < 4; k++) {
      const runner = await registerRunner(f.org.login, f.owner);
      const task = (await fetchTask(runner, 0)).task;
      if (!task) throw new Error(`no task ${k}`);
      registerSecretValue(jobTokenOf(task));
      await updateTask(runner, task.id);
      const number = (await taskRow(task.id))?.task as number;
      const secret = fresh(`secret${k}`);
      expect(await addSecrets(runId, number, [secret])).toEqual({ ok: true });
      tasks.push({ runner, wire: task.id, number, secret, rows: large(secret, 3) });
    }
    const send = (task: (typeof tasks)[number]) =>
      ackOf(task.runner, { taskId: task.wire, index: 0, rows: task.rows });
    const store = hold(runId);
    let stores = 0;
    await inRun(runId, (r) => {
      r.hooks = { beforeLogStore: () => (stores++ === 0 ? store.hold() : undefined) };
    });
    const pending: Promise<unknown>[] = [];
    try {
      const [head, ...rest] = tasks;
      if (!head) throw new Error("no tasks");
      const first = send(head);
      pending.push(first);
      await store.reached(first);
      // The first holds most of the pool: each other is answered at once, unadmitted.
      for (const task of rest) expect(await send(task)).toBe(0);
      store.release();
      expect(await first).toBeGreaterThan(1);
      // All at once: whichever is admitted stores, the others are answered; each resends.
      const acks = new Map<number, number>();
      for (let round = 0; round < rest.length && acks.size < rest.length; round++) {
        const answers = await Promise.all(rest.map((task, k) => acks.get(k) ?? send(task)));
        answers.forEach((ack, k) => {
          if (ack > 0) acks.set(k, ack);
        });
      }
      expect(acks.size).toBe(rest.length);
    } finally {
      store.release();
      await Promise.allSettled(pending);
      await inRun(runId, (r) => {
        r.hooks = {};
      });
    }
    for (const task of tasks) expect((await stored(runId, task.number))[0]).toBe("s ***");
    expect(await inRun(runId, (r) => r.memory.stats().reservedBytes)).toBe(0);
  });
});

/** Reservations a test holds in a run object's pool, by run. */
const held = new Map<string, { release(): void }>();

const repoTokens = async (repoId: string) => (await repoTokenCounts(repoId)).minted;

/** A version the organization's runners were told of, with nothing pending: a poll at it may be a lost answer's repeat. */
async function primed(f: Awaited<ReturnType<typeof orgRepo>>): Promise<number> {
  const runId = await started(f, one);
  await runStub(runId).cancel(f.owner.principalId, "graceful");
  await drain(runId);
  expect(await pendingOf(runId)).toEqual([]);
  const version = await tasksVersionOf(f.org.id);
  expect(version).toBeGreaterThan(0);
  return version;
}

/** A run whose first task's answer was lost: the runner holds its task, and repeating `version` re-offers it. */
async function lostAnswer() {
  const f = await orgRepo();
  const runner = await registerRunner(f.org.login, f.owner);
  const version = await primed(f);
  const runId = await started(f, one);
  const lost = (await fetchTask(runner, version)).task;
  if (!lost) throw new Error("no task");
  const number = (await taskRow(lost.id))?.task as number;
  return { f, runId, runner, lost, number, version };
}

/** The SQL the run's object runs through its engine while `fn` runs, whitespace collapsed. */
async function recordQueries(runId: string, fn: () => Promise<unknown>): Promise<string[]> {
  const queries: string[] = [];
  await inRun(runId, (r) => {
    const engine = r.engine as unknown as { rows: (q: string, ...b: unknown[]) => unknown[] };
    const rows = engine.rows.bind(engine);
    engine.rows = (q, ...b) => {
      queries.push(q.replace(/\s+/g, " ").trim());
      return rows(q, ...b);
    };
  });
  try {
    await fn();
  } finally {
    await inRun(runId, (r) => {
      delete (r.engine as unknown as { rows?: unknown }).rows;
    });
  }
  return queries;
}

/*
 * What the masker costs in workerd at a job's full secret allowance (32 KiB of
 * masked forms), beside a job with no secret: the time to mask 100 rows of 200
 * characters, which is what each log request does with its rows, and the heap
 * the process reports around it. It asserts nothing about time, so it runs
 * only on request:
 *
 *   FYRDEN_BENCH=1 pnpm --filter @fyrden/api exec vitest run test/ci.secrets.masking.test.ts -t "masker bench" --silent=false
 */
const benchLines: string[] = [];
afterAll(() => {
  // After the log capture has given console back.
  for (const line of benchLines) console.log(line);
});

describe.runIf((env as { FYRDEN_BENCH?: string }).FYRDEN_BENCH)("masker bench", () => {
  it("prints the time and heap of masking 100 rows at the secret allowance", async () => {
    // biome-ignore lint/style/noRestrictedGlobals: a benchmark run on request; it asserts nothing on time.
    const clock = () => performance.now();
    // workerd's `process.memoryUsage` may be a stub that answers 0: then it is not reported.
    const heap = () => {
      const used = (
        globalThis as { process?: { memoryUsage?: () => { heapUsed: number } } }
      ).process?.memoryUsage?.().heapUsed;
      return used ? used : undefined;
    };
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const random = (n: number) =>
      Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => alphabet[b % 62]).join("");
    // 1 KiB secrets, as many as the allowance takes.
    const secrets: string[] = [];
    for (;;) {
      const next = random(1024);
      const check = checkSecretMasks(secrets, [{ name: "S", value: next }]);
      if (!check.ok) break;
      secrets.push(next);
    }
    const variantBytes = secrets.reduce((n, s) => n + maskVariantBytes(s), 0);
    const rows = Array.from({ length: 100 }, () => random(200));
    // A job token and a few `::add-mask::` values, as any job has.
    const base: LogMask[] = [
      { value: `fyrden_job_${random(40)}`, fromIndex: 0, reserved: true },
      ...Array.from({ length: 4 }, () => ({ value: random(32), fromIndex: 0 })),
    ];
    const withSecrets: LogMask[] = [
      ...base,
      ...secrets.map((value) => ({ value, fromIndex: 0, secret: true })),
    ];
    // A Workers clock may advance only across I/O, so each batch ends with one, timed alone too.
    const io = () => fetch("data:,");
    const runs = 50;
    const measure = async (masks: LogMask[]) => {
      maskRows(masks, null, rows, { start: 0, reserve: { values: 8, bytes: 1024 } });
      let start = clock();
      await io();
      const ioTime = clock() - start;
      const before = heap();
      let high = before ?? 0;
      start = clock();
      for (let i = 0; i < runs; i++) {
        maskRows(masks, null, rows, { start: 0, reserve: { values: 8, bytes: 1024 } });
        high = Math.max(high, heap() ?? 0);
      }
      await io();
      const ms = (clock() - start - ioTime) / runs;
      return { ms, heap: before === undefined ? undefined : (high - before) / 1024 / 1024 };
    };
    const none = await measure(base);
    const full = await measure(withSecrets);
    const mib = (v: number | undefined) =>
      v === undefined ? "not reported" : `${v.toFixed(2)} MiB above the start`;
    benchLines.push(
      `masker, 100 rows of 200 chars, mean of ${runs}: no secrets ${none.ms.toFixed(3)} ms (heap ${mib(none.heap)}); ` +
        `${secrets.length} secrets, ${variantBytes} bytes of masked forms ${full.ms.toFixed(3)} ms (heap ${mib(full.heap)})`,
    );
    expect(variantBytes).toBeLessThanOrEqual(MASK_SECRET_MAX_VARIANT_BYTES);
  });
});
