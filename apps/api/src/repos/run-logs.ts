import type { Input, issueJobLogTicket, Output } from "@fyrden/api-contract";
import { ciEnv } from "../ci/budget.js";
import { type LogViewerAdmission, logViewerAdmissionFor } from "../ci/viewer-admission.js";
import { LOG_VIEWER_POLICY, type StoreTicketAnswer } from "../do/run/viewers.js";
import { ticketHash } from "../do/user/live.js";
import { repoFor } from "../git/chunked/operations.js";
import { liveCredential } from "../live/credential.js";
import { randomSecret } from "../oauth/params.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { clock } from "../services.js";
import { runOf } from "./runs.js";

/*
 * The `actions.runs.jobs.live_ticket` operation: a single-use ticket to watch
 * a job's log over a WebSocket (`live/run-logs-route.ts`). The ticket is made
 * and hashed here; only its hash goes to the run's object, which keeps it for
 * the job, the credential and the repository it was issued through, and
 * answers the job's log as stored. The deployment's viewer admission then
 * decides on that stored ticket (on Free, a grant from the CI ledger); a
 * ticket it refuses is deleted before the refusal is answered, and was never
 * disclosed.
 */

export async function issueJobLogTicketOperation(
  ctx: OpContext,
  input: Input<typeof issueJobLogTicket>,
  admission: LogViewerAdmission = logViewerAdmissionFor(
    ciEnv(ctx.env),
    ctx.env.DIRECTORY,
    ctx.metrics,
    ctx.log,
  ),
): Promise<Output<typeof issueJobLogTicket>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "actions:read");
  const run = await runOf(ctx, entry, input.run_id).catch((error: unknown) => {
    if (error instanceof OperationError) throw error;
    ctx.log.error("live log run not reached", { error });
    throw new OperationError(
      503,
      "run_lookup_unavailable",
      "The run cannot be reached. Try again.",
    );
  });
  // A socket's upgrade carries no delegation chain or proof of a key: the caller's own only.
  if (ctx.auth.grantId !== null || ctx.auth.dpopJkt !== null || ctx.auth.requiresDpop)
    throw new OperationError(
      403,
      "delegated_listing",
      "Watch job logs live with the principal's own credentials.",
    );
  ctx.metrics.count("d1.query", { db: "directory", op: "live_credential" });
  const credential = await liveCredential(ctx.env.DIRECTORY, ctx.auth.id, clock());
  if (!credential)
    throw new OperationError(401, "invalid_token", "The token is invalid, expired or revoked.");
  const ticket = randomSecret(32);
  const hash = await ticketHash(ticket);
  ctx.metrics.count("do.request", { class: "RunDO", method: "storeLogTicket" });
  // Its window is timed on this clock from before it is stored, never on the run's: never more
  // than is left.
  const storing = clock();
  let stored: StoreTicketAnswer;
  try {
    stored = await ctx.env.RUN.getByName(input.run_id).storeLogTicket({
      hash,
      repoId: entry.id,
      jobId: input.job_id,
      credentialId: credential.id,
      principalId: credential.principalId,
      budget: admission.budget,
    });
  } catch (error) {
    ctx.log.error("live log ticket not stored", { error });
    throw new OperationError(503, "run_unavailable", "The run cannot be reached. Try again.");
  }
  if (!stored.ok) {
    switch (stored.code) {
      case "run_not_found":
        throw new OperationError(404, "run_not_found", "The repository has no such run.");
      case "job_not_found":
        throw new OperationError(404, "job_not_found", "The run has no such job.");
      default:
        throw new OperationError(
          429,
          "too_many_tickets",
          `The run has ${LOG_VIEWER_POLICY.tickets} unredeemed tickets. Redeem one or wait for them to expire.`,
          undefined,
          undefined,
          Math.ceil(LOG_VIEWER_POLICY.ticketMs / 1000),
        );
    }
  }
  const admitted = await admission.onTicket({
    hash,
    runId: run.runId,
    accountId: entry.ownerId,
    expiresAt: stored.expiresAt,
    budget: stored.budget,
  });
  const drop = async () => {
    ctx.metrics.count("do.request", { class: "RunDO", method: "dropLogTicket" });
    // Never disclosed, it expires anyway: a failed delete only holds one of the run's tickets.
    await ctx.env.RUN.getByName(input.run_id)
      .dropLogTicket(hash)
      .catch((error: unknown) => ctx.log.warn("refused live log ticket not deleted", { error }));
  };
  if (admitted !== "ok") {
    await drop();
    throw new OperationError(
      admitted.status,
      admitted.code,
      admitted.message,
      undefined,
      undefined,
      admitted.retryAfter,
      admitted.retryAt,
    );
  }
  const expiresIn = Math.floor((LOG_VIEWER_POLICY.ticketMs - (clock() - storing)) / 1000);
  if (expiresIn < 1) {
    ctx.log.warn("live log ticket not answered: its admission took its redemption window");
    await drop();
    throw new OperationError(
      503,
      "log_viewers_unavailable",
      "Log viewers cannot be admitted right now. Try again.",
    );
  }
  const path = `/api/repos/${entry.ownerHandle}/${entry.name}/actions/runs/${run.runId}/jobs/${input.job_id}/logs/live`;
  return {
    ticket,
    expires_in: expiresIn,
    url: `${ctx.requestOrigin.replace(/^http/, "ws")}${path}?ticket=${encodeURIComponent(ticket)}`,
  };
}
