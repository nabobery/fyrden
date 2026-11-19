// Whether a CI job token may still be used: only while the task it was minted
// for is live, as the task's run says on every request, so the token stops
// in the same transaction that completes its task.

import type { Metrics } from "@fyrden/adapters-cloudflare/obs";

/** A job token's live task: its run's repository and checkout commit. */
export interface LiveJobTask {
  readonly repoId: string;
  readonly sha: string;
}

/**
 * The live task of job token `tokenId` (in progress or cancelling), as its
 * run reads it; `ended` when it is not live, or the token maps to no
 * assigned task (fail closed); `unavailable` when the run could not answer.
 */
export async function jobTokenTask(
  env: Env,
  tokenId: string,
  metrics?: Metrics,
): Promise<LiveJobTask | "ended" | "unavailable"> {
  metrics?.count("d1.query", { db: "directory", op: "ci_job_token_task" });
  try {
    const row = await env.DIRECTORY.withSession("first-primary")
      .prepare(
        `SELECT t.run_id, t.job_id, t.task FROM ci_job_tokens j JOIN ci_tasks t ON t.id = j.task_id
         WHERE j.token_id = ?`,
      )
      .bind(tokenId)
      .first<{ run_id: string; job_id: number; task: number | null }>();
    if (!row || row.task === null) return "ended";
    metrics?.count("do.request", { class: "RunDO", method: "liveTaskCheckout" });
    const live = await env.RUN.getByName(row.run_id).liveTaskCheckout({
      jobId: row.job_id,
      task: row.task,
    });
    return live ? { repoId: live.repoId, sha: live.sha } : "ended";
  } catch {
    return "unavailable";
  }
}
