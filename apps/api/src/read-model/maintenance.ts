import { rawReadModel } from "../events/read-model.js";

/*
 * The read model's maintenance (a restore's or an export's): the deployment
 * variable that keeps ordinary work from starting (`FYRDEN_READ_MODEL_MAINTENANCE`:
 * writes through the API refused, queue messages put back for later, crons
 * and maintenance jobs that write the read model skipped), and the barrier's
 * steps. A pause moves the shard's barrier in the directory from running to
 * pausing at the next generation (no lease is taken or renewed from then
 * on), then the read model's own barrier (no batch of an older generation is
 * admitted from then on), and is done (paused) once no lease of an older
 * generation is still live. Each step returns where it got to: a caller
 * runs it again rather than waiting in one invocation. Resuming sets the
 * read model's barrier running first, then the directory's (a generation
 * never goes down).
 */

/** Whether the deployment holds the read model's ordinary work back. */
export function readModelMaintenance(env: object): boolean {
  return (
    (env as { FYRDEN_READ_MODEL_MAINTENANCE?: unknown }).FYRDEN_READ_MODEL_MAINTENANCE === "on"
  );
}

/**
 * How long a queue message waits before it is tried again during
 * maintenance (Proposed: each wait costs the message's queue operations
 * again, so not every few seconds).
 */
export const MAINTENANCE_RESEND_DELAY_SECONDS = 300;

/** How long a job that maintenance held back waits before it looks again (Proposed). */
export const MAINTENANCE_RETRY_MS = 300_000;

/**
 * Puts every message of `batch` back on its queue for later (a new message,
 * so the wait spends none of its attempts), acknowledging each only once it
 * is sent; one that cannot be sent is retried.
 */
export async function putBack(batch: MessageBatch, queue: Queue): Promise<void> {
  for (const message of batch.messages) {
    try {
      // As it was sent (JSON, as every producer sends); a body JSON cannot carry, by structured
      // clone (larger, so not for the others).
      await queue.send(message.body, {
        contentType: jsonable(message.body) ? "json" : "v8",
        delaySeconds: MAINTENANCE_RESEND_DELAY_SECONDS,
      });
      message.ack();
    } catch {
      message.retry({ delaySeconds: MAINTENANCE_RESEND_DELAY_SECONDS });
    }
  }
}

function jsonable(body: unknown): boolean {
  try {
    return JSON.stringify(body) !== undefined;
  } catch {
    return false;
  }
}

export type BarrierPhase = "running" | "pausing" | "paused" | "recovering";

export interface PauseProgress {
  readonly phase: BarrierPhase;
  readonly generation: number;
  /** Leases of older generations still live, and the latest of their deadlines. */
  readonly live: number;
  readonly until: number | null;
}

const NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";

interface Barrier {
  readonly phase: BarrierPhase;
  readonly generation: number;
}

async function directoryBarrier(env: Pick<Env, "DIRECTORY">, shard: string): Promise<Barrier> {
  const row = await env.DIRECTORY.prepare(
    "SELECT phase, generation FROM read_model_barriers WHERE shard = ?",
  )
    .bind(shard)
    .first<Barrier>();
  if (!row) throw new Error(`the read model's shard ${shard} has no barrier`);
  return row;
}

async function localBarrier(env: Pick<Env, "ORG_READ">, shard: string): Promise<Barrier> {
  const row = await rawReadModel(env, shard)
    .prepare("SELECT phase, generation FROM read_model_barrier WHERE id = 1")
    .first<Barrier>();
  if (!row) throw new Error("the read model has no barrier");
  return row;
}

/** Hooks between a step's look at the barriers and its last change of them. For tests. */
export const barrierHooks: {
  beforeChange?: (step: "pause" | "resume") => Promise<void>;
} = {};

/**
 * Where a pause stands, as the barriers say now (another step may have
 * moved them meanwhile): paused only once both are, at one generation.
 */
async function standing(
  env: Pick<Env, "DIRECTORY" | "ORG_READ">,
  shard: string,
  older: { live: number; until: number | null },
): Promise<PauseProgress> {
  const directory = await directoryBarrier(env, shard);
  const local = await localBarrier(env, shard);
  const paused =
    directory.phase === "paused" &&
    local.phase === "paused" &&
    local.generation === directory.generation;
  return {
    phase: directory.phase === "paused" && !paused ? "pausing" : directory.phase,
    generation: directory.generation,
    ...older,
  };
}

/**
 * One step of pausing the shard's writers (see above); paused once no
 * older lease is live. Refuses while the barrier is recovering. Each change
 * is made only from the state it was decided on, so a resume that comes
 * between is not undone (the step then says running); a step finishes what
 * an interrupted one left: a pause half made is completed at its
 * generation, a resume half made is fenced off by the next one.
 */
export async function pauseReadModel(
  env: Pick<Env, "DIRECTORY" | "ORG_READ">,
  shard: string,
): Promise<PauseProgress> {
  const pausing = (from: BarrierPhase) =>
    env.DIRECTORY.prepare(
      `UPDATE read_model_barriers SET phase = 'pausing', generation = generation + 1, since = ${NOW}
       WHERE shard = ? AND phase = ?`,
    )
      .bind(shard, from)
      .run();
  await pausing("running");
  let { phase, generation } = await directoryBarrier(env, shard);
  if (phase !== "pausing" && phase !== "paused")
    throw new Error(`the read model's barrier is ${phase}`);
  const local = await localBarrier(env, shard);
  if (phase === "paused" && local.phase === "running" && local.generation === generation) {
    // A resume reopened the read model's barrier but not yet the directory's: a new generation.
    await pausing("paused");
    ({ phase, generation } = await directoryBarrier(env, shard));
  }
  // The read model's own, from an older generation to this one: no older batch is admitted.
  await rawReadModel(env, shard)
    .prepare(
      "UPDATE read_model_barrier SET phase = 'pausing', generation = ?1 WHERE id = 1 AND generation < ?1",
    )
    .bind(generation)
    .run();
  const counted = await env.DIRECTORY.prepare(
    `SELECT count(*) AS live, max(until) AS until FROM read_model_writers
     WHERE shard = ? AND generation < ? AND until > ${NOW}`,
  )
    .bind(shard, generation)
    .first<{ live: number; until: number | null }>();
  const older = { live: counted?.live ?? 0, until: counted?.until ?? null };
  if (older.live > 0) return standing(env, shard, older);
  await barrierHooks.beforeChange?.("pause");
  // Paused: the directory's barrier first (still pausing at this generation), then the read
  // model's, as long as the directory's is paused at it (also finishing a pause interrupted
  // between the two).
  await env.DIRECTORY.prepare(
    `UPDATE read_model_barriers SET phase = 'paused', since = ${NOW}
     WHERE shard = ? AND phase = 'pausing' AND generation = ?`,
  )
    .bind(shard, generation)
    .run();
  const directory = await directoryBarrier(env, shard);
  if (directory.phase === "paused" && directory.generation === generation)
    await rawReadModel(env, shard)
      .prepare(
        "UPDATE read_model_barrier SET phase = 'paused' WHERE id = 1 AND phase = 'pausing' AND generation = ?",
      )
      .bind(generation)
      .run();
  return standing(env, shard, older);
}

/**
 * Lets the shard's writers write again: the read model's barrier running
 * at the latest generation either holds, then (only once it is) the
 * directory's at the same one, from when on leases are taken. Each change
 * is made only from the state it was decided on, so a newer pause that
 * comes between stands; a resume interrupted between the two is finished.
 * Nothing while it is running already or recovering.
 */
export async function resumeReadModel(
  env: Pick<Env, "DIRECTORY" | "ORG_READ">,
  shard: string,
): Promise<Barrier> {
  const barrier = await directoryBarrier(env, shard);
  if (barrier.phase === "running" || barrier.phase === "recovering") return barrier;
  const local = await localBarrier(env, shard);
  const generation = Math.max(barrier.generation, local.generation);
  await barrierHooks.beforeChange?.("resume");
  await rawReadModel(env, shard)
    .prepare(
      `UPDATE read_model_barrier SET phase = 'running', generation = ?3
       WHERE id = 1 AND phase = ?1 AND generation = ?2`,
    )
    .bind(local.phase, local.generation, generation)
    .run();
  // A pause between the look and the change keeps the read model's barrier: so does the directory's.
  const now = await localBarrier(env, shard);
  if (now.phase === "running" && now.generation === generation)
    await env.DIRECTORY.prepare(
      `UPDATE read_model_barriers SET phase = 'running', generation = ?4, since = ${NOW}
       WHERE shard = ?1 AND phase = ?2 AND generation = ?3`,
    )
      .bind(shard, barrier.phase, barrier.generation, generation)
      .run();
  return directoryBarrier(env, shard);
}

/** Expired leases removed a run at most (Proposed). */
export const LEASE_REAP_LIMIT = 500;

/**
 * Removes leases whose deadline passed (their release was lost), oldest
 * first, up to `LEASE_REAP_LIMIT`; how many. A pause never waits for these
 * (it counts only live ones).
 */
export async function reapExpiredLeases(env: Pick<Env, "DIRECTORY">): Promise<number> {
  const { meta } = await env.DIRECTORY.prepare(
    `DELETE FROM read_model_writers WHERE lease_id IN (
       SELECT lease_id FROM read_model_writers WHERE until <= ${NOW} ORDER BY until LIMIT ?)`,
  )
    .bind(LEASE_REAP_LIMIT)
    .run();
  return meta.changes ?? 0;
}
