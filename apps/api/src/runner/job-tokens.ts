// Whether a CI job token may still be used: only while the task it was minted
// for is live, as the task's run says on every request, so the token stops
// in the same transaction that completes its task.

import type { Metrics } from "@fyrden/adapters-cloudflare/obs";

/**
 * `live` while job token `tokenId`'s task is in progress or cancelling;
 * `ended` when it is not, or the token maps to no assigned task (fail
 * closed); `unavailable` when the run could not answer.
 */
export async function jobTokenTask(
  env: Env,
  tokenId: string,
  metrics?: Metrics,
): Promise<"live" | "ended" | "unavailable"> {
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
    metrics?.count("do.request", { class: "RunDO", method: "taskLive" });
    const live = await env.RUN.getByName(row.run_id).taskLive({
      jobId: row.job_id,
      task: row.task,
    });
    return live ? "live" : "ended";
  } catch {
    return "unavailable";
  }
}
