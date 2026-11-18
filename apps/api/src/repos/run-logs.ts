import type { Input, issueJobLogTicket, Output } from "@fyrden/api-contract";
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
 * the job, the credential and the repository it was issued through.
 */

/** Why a viewer is not admitted: what the operation answers. */
export interface LogViewerRefusal {
  readonly status: 429 | 503;
  readonly code: string;
  readonly message: string;
  readonly retryAfter?: number;
}

/**
 * Where a deployment's metering of log viewers will plug in (sockets cost
 * reads, rechecks and alarms on Free): asked before each ticket is issued.
 * Admits everyone for now.
 */
export interface LogViewerAdmission {
  onTicket(
    principal: { readonly id: string; readonly type: "user" | "agent" },
    run: { readonly runId: string; readonly repoId: string },
    jobId: number,
  ): Promise<"ok" | LogViewerRefusal>;
}

export const admitEveryViewer: LogViewerAdmission = { onTicket: async () => "ok" };

export async function issueJobLogTicketOperation(
  ctx: OpContext,
  input: Input<typeof issueJobLogTicket>,
  admission: LogViewerAdmission = admitEveryViewer,
): Promise<Output<typeof issueJobLogTicket>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "actions:read");
  const run = await runOf(ctx, entry, input.run_id);
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
  const admitted = await admission.onTicket(
    { id: credential.principalId, type: credential.principalType },
    { runId: run.runId, repoId: entry.id },
    input.job_id,
  );
  if (admitted !== "ok")
    throw new OperationError(
      admitted.status,
      admitted.code,
      admitted.message,
      undefined,
      undefined,
      admitted.retryAfter,
    );
  const ticket = randomSecret(32);
  const hash = await ticketHash(ticket);
  ctx.metrics.count("do.request", { class: "RunDO", method: "storeLogTicket" });
  let stored: StoreTicketAnswer;
  try {
    stored = await ctx.env.RUN.getByName(input.run_id).storeLogTicket({
      hash,
      repoId: entry.id,
      jobId: input.job_id,
      credentialId: credential.id,
      principalId: credential.principalId,
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
  const path = `/api/repos/${entry.ownerHandle}/${entry.name}/actions/runs/${run.runId}/jobs/${input.job_id}/logs/live`;
  return {
    ticket,
    expires_in: Math.floor(LOG_VIEWER_POLICY.ticketMs / 1000),
    url: `${ctx.requestOrigin.replace(/^http/, "ws")}${path}?ticket=${encodeURIComponent(ticket)}`,
  };
}
