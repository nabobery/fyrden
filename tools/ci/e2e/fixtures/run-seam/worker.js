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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = /^\/__runs(?:\/([0-9A-Z]{26}))?\/([a-z]+)$/.exec(url.pathname);
    if (!match) return env.API.fetch(request);
    const [, runId, action] = match;
    const body = request.method === "POST" ? await request.json() : {};
    if (action === "start") {
      const spec = { runId: ulid(), ...body };
      return json({ runId: spec.runId, answer: await startRun(env, spec) });
    }
    if (!runId) return json({ error: "no run" }, 400);
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
