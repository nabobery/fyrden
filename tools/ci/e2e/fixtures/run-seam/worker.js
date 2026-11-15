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
 * Every UpdateLog a runner sent through this Worker, in arrival order: the
 * request body and the API's status and response body. In memory: wrangler
 * dev keeps this Worker's one isolate for the session, which covers a run.
 */
const recorded = [];

/** Forwards an UpdateLog to the API unchanged and answers with its response unchanged, recording both. */
async function recordUpdateLog(request, env) {
  const body = await request.arrayBuffer();
  const entry = { request: base64(body), status: null, response: null };
  recorded.push(entry);
  const res = await env.API.fetch(new Request(request, { body }));
  const answer = await res.arrayBuffer();
  entry.status = res.status;
  entry.response = base64(answer);
  return new Response(answer, res);
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
