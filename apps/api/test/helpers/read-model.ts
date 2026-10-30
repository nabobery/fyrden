import { env } from "cloudflare:workers";
import { ReadModelWriter, writerDatabase } from "../../src/read-model/executor.js";
import { pauseReadModel, resumeReadModel } from "../../src/read-model/maintenance.js";

/**
 * Sets the shard's barriers running again after a test moved them, through
 * the controller (the read model's barrier never goes back a generation):
 * every lease dropped, the directory's protocol as migrated, a pause
 * finished and resumed.
 */
export async function runningAgain(
  env: Pick<Env, "DIRECTORY" | "ORG_READ">,
  shard = "default",
): Promise<void> {
  await env.DIRECTORY.batch([
    env.DIRECTORY.prepare("DELETE FROM read_model_writers WHERE shard = ?").bind(shard),
    env.DIRECTORY.prepare(
      `UPDATE read_model_barriers SET protocol_version = 2,
         phase = CASE phase WHEN 'recovering' THEN 'paused' ELSE phase END
       WHERE shard = ?`,
    ).bind(shard),
  ]);
  const barriers = await Promise.all([
    env.DIRECTORY.prepare("SELECT phase, generation FROM read_model_barriers WHERE shard = ?")
      .bind(shard)
      .first<{ phase: string; generation: number }>(),
    env.ORG_READ.prepare("SELECT phase, generation FROM read_model_barrier WHERE id = 1").first<{
      phase: string;
      generation: number;
    }>(),
  ]);
  const [directory, local] = barriers;
  if (
    directory?.phase === "running" &&
    local?.phase === "running" &&
    directory.generation === local.generation
  )
    return;
  for (let step = 0; step < 3; step++)
    if ((await pauseReadModel(env, shard)).phase === "paused") break;
  await resumeReadModel(env, shard);
}

/**
 * Leaves the barriers as an interrupted step would: the read model's set by
 * a maintenance writer (the directory's moved to its generation for it, not
 * running), then the directory's as given. The read model's generation
 * never goes down.
 */
export async function leftAs(
  env: Pick<Env, "DIRECTORY" | "ORG_READ">,
  directory: { phase: string; generation: number },
  local: { phase: string; generation: number },
): Promise<void> {
  const set = (barrier: { phase: string; generation: number }) =>
    env.DIRECTORY.prepare(
      "UPDATE read_model_barriers SET phase = ?, generation = ? WHERE shard = 'default'",
    )
      .bind(barrier.phase, barrier.generation)
      .run();
  await set({ phase: "paused", generation: local.generation });
  const writer = new ReadModelWriter(env, "default", Date.now, {
    maintenance: { generation: local.generation },
  });
  await writer.write([
    env.ORG_READ.prepare(
      "UPDATE read_model_barrier SET phase = ?, generation = ? WHERE id = 1",
    ).bind(local.phase, local.generation),
  ]);
  await set(directory);
}

/**
 * `db` (the read model's binding, or a test's proxy of it) as production
 * code gets it: its writes through the executor, each batch under a lease
 * of its own and sent through `db` itself; its reads as they are.
 */
export function admitted(db: D1Database = env.ORG_READ): D1Database {
  return writerDatabase(
    db,
    new ReadModelWriter({ DIRECTORY: env.DIRECTORY, ORG_READ: db }, "default", Date.now, {
      leasePerWrite: true,
    }),
  );
}
