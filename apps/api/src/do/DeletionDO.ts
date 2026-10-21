import { DurableObject } from "cloudflare:workers";
import { runDeletionSlice } from "../accounts/deletion-runner.js";

/**
 * One user deletion's runner, by the user's id: it holds nothing but its
 * alarm, which runs the job a slice at a time (`runDeletionSlice`; the
 * job's state is in the directory) and sets itself for the job's next
 * run. A lost alarm is set again by the recovery cron (`rearmDeletions`).
 */
export class DeletionDO extends DurableObject<Env> {
  /** Sets the alarm for `at` (Unix ms), unless an earlier one is set. */
  async arm(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  override async alarm(): Promise<void> {
    const userId = this.ctx.id.name;
    if (userId === undefined) return;
    const { next } = await runDeletionSlice(this.env, userId);
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }
}
