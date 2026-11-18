import { createMetrics } from "@fyrden/adapters-cloudflare/obs";
import type { Hono } from "hono";
import type { AppEnv } from "../app.js";
import { LOG_VIEWER_HEADER, type ViewerAdmission } from "../do/run/viewers.js";
import { ticketHash } from "../do/user/live.js";
import { resolveRepo } from "../repos/directory.js";
import { clock } from "../services.js";
import { freshlyAllowed, liveCredential } from "./credential.js";
import { presented } from "./routes.js";

/*
 * `GET /api/repos/{owner}/{repo}/actions/runs/{run_id}/jobs/{job_id}/logs/live`
 * upgraded to a WebSocket on the run's object, with a ticket from
 * `actions.runs.jobs.live_ticket` (the same path's `POST`). Outside the
 * operation registry, as live hints' upgrade is: a browser's WebSocket
 * proves its session with its cookie and this deployment's `Origin`, a
 * client with a token presents it in `Authorization`. The credential is read
 * again on the directory's primary and its access decided fresh (the
 * repository resolved on the primary, the roles read from its account's
 * object, an agent's owner's included); the run's object then checks that
 * the run is that repository's and spends the ticket only if it is this
 * credential's, for this job. The object checks the credential and access
 * again itself before it sends the socket anything.
 */

const RUN_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const INDEX = /^(0|[1-9][0-9]{0,9})$/;
const MAX_INDEX = 2 ** 31 - 1;

/** Mounts the upgrade (before the REST routes, whose `POST` on the path issues the ticket). */
export function mountRunLogs(app: Hono<AppEnv>): void {
  app.get("/api/repos/:owner/:repo/actions/runs/:run_id/jobs/:job_id/logs/live", async (c) => {
    if (c.req.header("Upgrade") !== "websocket")
      return c.text("Open this with a WebSocket upgrade.", 426, { Upgrade: "websocket" });
    const { owner, repo } = c.req.param();
    const runId = c.req.param("run_id");
    const jobText = c.req.param("job_id");
    const ticket = c.req.query("ticket") ?? "";
    const fromText = c.req.query("from") ?? "0";
    // Nothing is looked up for a request that cannot hold a ticket or a position.
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(ticket)) return c.text("No ticket.", 400);
    if (!INDEX.test(fromText) || Number(fromText) > MAX_INDEX)
      return c.text("`from` must be a row index.", 400);
    if (!RUN_ID.test(runId) || !INDEX.test(jobText) || Number(jobText) > MAX_INDEX)
      return c.text("No such job.", 404);
    const client = c.req.header("CF-Connecting-IP") ?? "unknown";
    if (!(await c.env.RATE_LIMIT_AUTH.limit({ key: client })).success)
      return c.text("Too many requests.", 429, { "Retry-After": "60" });
    const credentialId = await presented(c);
    if (!credentialId) return c.text("Not signed in as the ticket's credential.", 401);
    const metrics = c.get("metrics") ?? createMetrics(c.env.METRICS);
    metrics.count("d1.query", { db: "directory", op: "live_credential" });
    const credential = await liveCredential(c.env.DIRECTORY, credentialId, clock());
    if (!credential) return c.text("The credential no longer holds.", 401);
    const notFound = () => c.text(`No repository ${owner}/${repo} was found.`, 404);
    const entry = await resolveRepo(c.env, owner, repo, { consistency: "primary", metrics });
    if (!entry) return notFound();
    const allowed = await freshlyAllowed(c.env, metrics, credential, entry, "actions:read");
    if (allowed === "unknown")
      return c.text("Access cannot be checked right now. Try again.", 503, { "Retry-After": "5" });
    if (!allowed) return notFound();
    const admission: ViewerAdmission = {
      repoId: entry.id,
      jobId: Number(jobText),
      hash: await ticketHash(ticket),
      from: Number(fromText),
      credentialId: credential.id,
      principalId: credential.principalId,
      principalType: credential.principalType,
      dependencies: credential.dependencies,
    };
    // A request of its own: nothing the client sent reaches the object, its copy of the header
    // included.
    const forwarded = new Request("https://run.internal/logs/live", {
      headers: { Upgrade: "websocket", [LOG_VIEWER_HEADER]: JSON.stringify(admission) },
    });
    metrics.count("do.request", { class: "RunDO", method: "fetch" });
    try {
      return await c.env.RUN.getByName(runId).fetch(forwarded);
    } catch (error) {
      c.get("log")?.error("live log socket not opened", { error });
      return c.text("The run cannot be reached. Try again.", 503, { "Retry-After": "5" });
    }
  });
}
