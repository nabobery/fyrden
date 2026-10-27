import { createLogger, type Metrics } from "@fyrden/adapters-cloudflare/obs";
import { reapEmails } from "../accounts/emails.js";
import { reapOAuth } from "../oauth/reaper.js";
import { pruneFailedEvents } from "../queues/events-dlq.js";
import { advanceDeletions } from "../repos/deletion.js";
import { settleStaleGenerations } from "../repos/generate.js";
import { advanceTransfers } from "../repos/transfer.js";
import { reapIdempotencyKeys } from "../rest/idempotency.js";
import { archiveDirectoryAudit } from "./directory-audit-archiver.js";
import { reapExpiredRepos } from "./expiry-reaper.js";

/** The one maintenance object's name (`MaintenanceDO`). */
export const MAINTENANCE_OBJECT = "instance";

/**
 * The five-minute maintenance: archives the directory's audit log, expires
 * repositories and settles abandoned generations (then advances deletions),
 * reaps idempotency keys, OAuth leftovers and failed envelopes kept their
 * time, and advances transfers. Each
 * task on its own: one failing does not stop the others, and the run then
 * throws. Run by `MaintenanceDO`, where it has a Durable Object's CPU.
 */
export async function runMaintenance(env: Env, metrics: Metrics): Promise<void> {
  const results = await Promise.allSettled([
    archiveDirectoryAudit({
      db: env.DIRECTORY,
      bucket: env.ASSETS,
      now: () => Date.now(),
      metrics,
    }),
    // Expired repositories and abandoned generations first, so their
    // deletions start in the same run; deletions advance even when those fail.
    (async () => {
      const started = await Promise.allSettled([
        reapExpiredRepos(env, { now: Date.now(), metrics }),
        settleStaleGenerations(env, { now: Date.now(), metrics }),
      ]);
      await advanceDeletions(env, { metrics });
      const failed = started.find((r) => r.status === "rejected");
      if (failed) throw failed.reason;
    })(),
    reapIdempotencyKeys(env, { now: Date.now(), metrics }),
    advanceTransfers(env, { metrics }),
    reapOAuth(env, { now: Date.now(), metrics }),
    reapEmails(env, { now: Date.now(), metrics }),
    pruneFailedEvents(env, { now: Date.now(), metrics }),
  ]);
  const failed = results.filter((r) => r.status === "rejected");
  for (const failure of failed)
    createLogger({ op: "cron" }).error("a scheduled task failed", { error: failure.reason });
  if (failed.length > 0) throw new Error(`${failed.length} scheduled task(s) failed`);
}
