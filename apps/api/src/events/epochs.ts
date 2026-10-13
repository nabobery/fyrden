import type { Metrics } from "@fyrden/adapters-cloudflare/obs";

/**
 * Allocates a source's next restore generation (1 for a new source) from
 * the directory. The counter lives in D1 because D1 is never restored
 * together with a Durable Object: a restored object always gets a higher
 * generation than any it had before, so consumers can tell its events from
 * the history it replaced.
 */
export async function allocateEpoch(
  db: D1Database,
  sourceId: string,
  metrics?: Metrics,
): Promise<number> {
  metrics?.count("d1.query", { db: "directory", op: "epoch_allocate" });
  const row = await db
    .prepare(
      `INSERT INTO source_epochs (source_id, epoch_gen) VALUES (?, 1)
       ON CONFLICT (source_id) DO UPDATE SET epoch_gen = epoch_gen + 1
       RETURNING epoch_gen`,
    )
    .bind(sourceId)
    .first<{ epoch_gen: number }>();
  if (!row) throw new Error(`allocating an epoch for ${sourceId} returned nothing`);
  return row.epoch_gen;
}
