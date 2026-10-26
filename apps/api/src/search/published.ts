import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { createLogger } from "@fyrden/adapters-cloudflare/obs";
import { readModelFor } from "../events/read-model.js";
import { UNLISTED_GRACE_MS } from "../queues/events-consumer.js";
import { clock } from "../services.js";
import { spentStatement } from "./admission.js";
import { REQUEST_ROWS, repairStatement, searchIndexing } from "./repairs.js";

/**
 * After a repository is published in the directory: when that came long
 * after its storage was made (half the consumer's grace for events of a
 * repository not yet listed, past which they are dropped), and search
 * indexing is on, asks for its reconciliation, since the events it made
 * meanwhile may never be projected. Never throws (the repository is
 * published either way): a failure is logged.
 */
export async function afterPublication(
  env: Env,
  repo: { readonly id: string; readonly shard: string; readonly storageAt: number },
  metrics?: Metrics,
): Promise<void> {
  if (clock() - repo.storageAt < UNLISTED_GRACE_MS / 2) return;
  try {
    metrics?.count("d1.query", { db: "directory", op: "search_indexing" });
    if (!(await searchIndexing(env))) return;
    const db = readModelFor(env, repo.shard);
    metrics?.count("d1.query", { db: "org", op: "search_published" }, 2);
    await db.batch([
      repairStatement(db, repo.id, "published_late", clock()),
      spentStatement(db, { rows: REQUEST_ROWS, reads: 0 }),
    ]);
  } catch (error) {
    createLogger({ op: "search.published" }).warn(
      "asking a late repository's reconciliation failed",
      {
        error,
        repoId: repo.id,
      },
    );
  }
}
