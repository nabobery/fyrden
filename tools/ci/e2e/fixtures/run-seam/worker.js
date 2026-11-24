// See wrangler.jsonc. Routes under /__runs/ are this Worker's; the rest go to fyrden-api.
import { startRun } from "../../../../../apps/api/src/ci/runs.ts";
import { readPrefix } from "../../../../../apps/api/src/runner/connect.ts";
import {
  decodeUpdateLogRequest,
  decodeUpdateTaskRequest,
  encodeUpdateLogResponse,
} from "../../../../../apps/api/src/runner/proto/messages.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID: 48 bits of time, 80 random. */
function ulid() {
  let time = Date.now();
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[time % 32] + out;
    time = Math.floor(time / 32);
  }
  for (const byte of crypto.getRandomValues(new Uint8Array(16))) out += CROCKFORD[byte % 32];
  return out;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Every object under the run's log prefix, in key order, with its text. */
async function chunks(env, runId) {
  const out = [];
  let cursor;
  do {
    const page = await env.CI.list({ prefix: `runs/${runId}/`, cursor });
    for (const { key } of page.objects) {
      const object = await env.CI.get(key);
      out.push({ key, text: object ? await object.text() : null });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

const UPDATE_LOG = "/api/actions/runner.v1.RunnerService/UpdateLog";
const UPDATE_TASK = "/api/actions/runner.v1.RunnerService/UpdateTask";
let sealedLog;
function base64(buffer) {
  const bytes = new Uint8Array(buffer);
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/**
 * Every UpdateLog a runner sent through this Worker, in arrival order: at
 * most the first 4 MiB of the request body (`whole`: that is all of it), the
 * API's status and response body, and whether the API stopped reading the
 * body before its end (`cancelled`). In memory: wrangler dev keeps this
 * Worker's one isolate for the session, which covers a run.
 */
const recorded = [];
/** The API's UpdateLog prefix (`UPDATE_LOG_PREFIX_BYTES`): recording more would show nothing it reads. */
const RECORD_BYTES = 4 * 1024 * 1024;

/**
 * Forwards an UpdateLog to the API and answers with its response unchanged,
 * recording both. The body is passed on as a stream and pulled only as the
 * API reads it, and the API's cancel is passed back to the runner's request
 * body. This is not proof that the runner's connection sees what it would
 * without this Worker: the local runtime and the service binding may read
 * ahead of the API (not measured), and Cloudflare's edge is not involved.
 */
async function recordUpdateLog(request, env) {
  const entry = {
    request: null,
    whole: false,
    cancelled: false,
    status: null,
    response: null,
    error: null,
  };
  recorded.push(entry);
  const kept = [];
  let keptBytes = 0;
  let seen = 0;
  const reader = request.body?.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      const next = reader ? await reader.read() : { done: true };
      if (next.done) {
        entry.whole = seen <= RECORD_BYTES;
        controller.close();
        return;
      }
      const take = next.value.slice(0, RECORD_BYTES - keptBytes);
      if (take.length > 0) kept.push(take);
      keptBytes += take.length;
      seen += next.value.length;
      controller.enqueue(next.value);
    },
    cancel(reason) {
      entry.cancelled = true;
      return reader?.cancel(reason);
    },
  });
  try {
    const res = await env.API.fetch(new Request(request, { body }));
    const answer = await res.arrayBuffer();
    entry.status = res.status;
    entry.response = base64(answer);
    return new Response(answer, res);
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    const prefix = new Uint8Array(keptBytes);
    let at = 0;
    for (const chunk of kept) {
      prefix.set(chunk, at);
      at += chunk.length;
    }
    entry.request = base64(prefix);
  }
}

/** The sealed-log probe models a fixed ack only; it does not run the schema migration. */
async function sealedCall(request, env, method) {
  const control = sealedLog;
  const { bytes, truncated } = await readPrefix(request, RECORD_BYTES);
  if (truncated) throw new Error("the sealed-log probe exceeded its request bound");
  if (method === UPDATE_LOG) {
    const message = decodeUpdateLogRequest(bytes);
    if (message.taskId !== control.taskId)
      return recordUpdateLog(new Request(request, { body: bytes }), env);
    // Reporter serializes its calls. Its first index after sealing is the last ack it received.
    control.ackIndex ??= message.index;
    const answer = encodeUpdateLogResponse({ ackIndex: control.ackIndex });
    recorded.push({
      request: base64(bytes),
      whole: true,
      cancelled: false,
      status: 200,
      response: base64(answer),
      error: null,
      sealed: true,
    });
    return new Response(answer, { headers: { "Content-Type": "application/proto" } });
  }
  const message = decodeUpdateTaskRequest(bytes);
  const response = await env.API.fetch(new Request(request, { body: bytes }));
  if (message.state?.id === control.taskId && message.state.result !== 0) {
    if (control.results.length === 10) throw new Error("too many final task reports in the probe");
    control.results.push({ result: message.state.result, status: response.status });
  }
  return response;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/__runs/d1" && request.method === "POST") {
      const { sql, params } = await request.json();
      const result = await env.DIRECTORY.prepare(sql)
        .bind(...params)
        .all();
      return json({ results: result.results, changes: result.meta.changes });
    }
    if (
      sealedLog &&
      request.method === "POST" &&
      (url.pathname === UPDATE_LOG || url.pathname === UPDATE_TASK)
    )
      return sealedCall(request, env, url.pathname);
    if (url.pathname === UPDATE_LOG && request.method === "POST")
      return recordUpdateLog(request, env);
    // A schedule tick through `RepoDO.ciScheduleTick`, which no route of fyrden-api reaches:
    // body `{ repoId, at }`, `at` by default now and possibly later than the repository's
    // clock, to fire a tick the repository's alarm has not reached.
    if (url.pathname === "/__runs/schedule-tick" && request.method === "POST") {
      const { repoId, at } = await request.json();
      return json(await env.REPO.getByName(repoId).ciScheduleTick(at ?? Date.now()));
    }
    // Trigger-inbox read failures through `RepoDO.ciTriggerFaults`, which no route of fyrden-api
    // reaches: body `{ repoId, mode }`, mode `transient`, `fault` or null (cleared).
    if (url.pathname === "/__runs/trigger-faults" && request.method === "POST") {
      const { repoId, mode } = await request.json();
      return json(await env.REPO.getByName(repoId).ciTriggerFaults(mode ?? null));
    }
    // The trigger inbox decided now through `RepoDO.ciTriggersNow`, which no route of fyrden-api
    // reaches: body `{ repoId }`. Answers the inbox events and the schedule entries.
    if (url.pathname === "/__runs/triggers-now" && request.method === "POST") {
      const { repoId } = await request.json();
      return json(await env.REPO.getByName(repoId).ciTriggersNow());
    }
    // The run's reserve slice now, through `RunDO.ciReserveNow`, which no route of fyrden-api
    // reaches: body `{ runId }`. Asks a refused job again as its retry alarm would.
    if (url.pathname === "/__runs/reserve-now" && request.method === "POST") {
      const { runId } = await request.json();
      return json(await env.RUN.getByName(runId).ciReserveNow());
    }
    const match = /^\/__runs(?:\/([0-9A-Z]{26}))?\/([a-z]+)$/.exec(url.pathname);
    if (!match) return env.API.fetch(request);
    const [, runId, action] = match;
    if (action === "recorded" && !runId) return json(recorded);
    const body = request.method === "POST" ? await request.json() : {};
    if (action === "start") {
      // A same-repository run unless the body says otherwise.
      const spec = { runId: ulid(), trust: "trusted", fork: false, ...body };
      return json({ runId: spec.runId, answer: await startRun(env, spec) });
    }
    if (!runId) return json({ error: "no run" }, 400);
    if (action === "chunks") return json(await chunks(env, runId));
    if (action === "seal" && request.method === "POST") {
      if (!Number.isSafeInteger(body.taskId) || body.taskId <= 0 || sealedLog)
        return json({ error: "invalid sealed-log probe task" }, 400);
      sealedLog = { runId, taskId: body.taskId, ackIndex: undefined, results: [] };
      return json({ ok: true });
    }
    if (action === "sealstate") return json(sealedLog?.runId === runId ? sealedLog : null);
    if (action === "unseal" && request.method === "POST") {
      if (sealedLog?.runId === runId) sealedLog = undefined;
      return json({ ok: true });
    }
    const run = env.RUN.getByName(runId);
    switch (action) {
      case "queued":
        return json(await run.queued(100));
      // The run's weekly check (and a retirement it begins) as at `body.at`, through
      // `RunDO.ciReconcileAt`, which no route of fyrden-api reaches: a local check of retention.
      case "retire":
        if (!Number.isSafeInteger(body.at)) return json({ error: "at must be a time in ms" }, 400);
        return json(await run.ciReconcileAt(body.at));
      case "assign":
        return json(await run.assign(body.jobId, body.key));
      case "update":
        return json(await run.updateTask(body.task));
      case "complete":
        return json(
          await run.completeTask(body.task, {
            result: body.result,
            outputs: body.outputs ?? {},
            logComplete: body.logComplete ?? true,
          }),
        );
      default:
        return json({ error: `no action ${action}` }, 404);
    }
  },
};
