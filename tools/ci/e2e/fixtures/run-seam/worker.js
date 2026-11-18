// See wrangler.jsonc. Routes under /__runs/ are this Worker's; the rest go to fyrden-api.
import { startRun } from "../../../../../apps/api/src/ci/runs.ts";

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === UPDATE_LOG && request.method === "POST")
      return recordUpdateLog(request, env);
    const match = /^\/__runs(?:\/([0-9A-Z]{26}))?\/([a-z]+)$/.exec(url.pathname);
    if (!match) return env.API.fetch(request);
    const [, runId, action] = match;
    if (action === "recorded" && !runId) return json(recorded);
    const body = request.method === "POST" ? await request.json() : {};
    if (action === "start") {
      const spec = { runId: ulid(), ...body };
      return json({ runId: spec.runId, answer: await startRun(env, spec) });
    }
    if (!runId) return json({ error: "no run" }, 400);
    if (action === "chunks") return json(await chunks(env, runId));
    const run = env.RUN.getByName(runId);
    switch (action) {
      case "queued":
        return json(await run.queued(100));
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
