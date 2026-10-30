import { rawReadModel } from "../events/read-model.js";
import { ReadModelRefused, ReadModelWriter } from "./executor.js";

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
 * never goes down). The read model's barrier is changed only as a
 * maintenance writer of the executor, at the generation the directory's
 * barrier holds (not running), which the step decided on.
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

/**
 * Makes `change` (of the read model's barrier, on its raw database) as a
 * maintenance writer at the directory's `generation`: false when refused
 * (the directory's barrier is no longer at it, not running: another step
 * moved it).
 */
async function admitted(
  env: Pick<Env, "DIRECTORY" | "ORG_READ">,
  shard: string,
  generation: number,
  change: (org: D1Database) => D1PreparedStatement,
): Promise<boolean> {
  const writer = new ReadModelWriter(env, shard, Date.now, { maintenance: { generation } });
  try {
    await writer.write([change(rawReadModel(env, shard))], { observe: false });
    return true;
  } catch (error) {
    if (error instanceof ReadModelRefused) return false;
    throw error;
  } finally {
    await writer.release();
  }
}

/**
 * Moves the directory's barrier (not running, as `from`) past a read model
 * barrier ahead of it (restored, or a resume half made: running at its
 * generation), pausing at the generation after: a maintenance writer can
 * then bring the read model's to it. Nothing when the read model's is not
 * ahead, or `from` no longer holds.
 */
async function overtake(
  env: Pick<Env, "DIRECTORY">,
  shard: string,
  from: Barrier,
  local: Barrier,
): Promise<void> {
  if (
    local.generation < from.generation ||
    (local.generation === from.generation && local.phase !== "running")
  )
    return;
  await env.DIRECTORY.prepare(
    `UPDATE read_model_barriers SET phase = 'pausing', generation = ?4, since = ${NOW}
     WHERE shard = ?1 AND phase = ?2 AND generation = ?3 AND phase <> 'running'`,
  )
    .bind(shard, from.phase, from.generation, local.generation + 1)
    .run();
}

/** Hooks between a step's look at the barriers and its last change of them. For tests. */
export const barrierHooks: {
  /** After a pause's first change (the directory's barrier pausing), before it looks again. */
  afterPausing?: () => Promise<void>;
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
  let local = await localBarrier(env, shard);
  // Past the read model's generation too, should it be ahead.
  await env.DIRECTORY.prepare(
    `UPDATE read_model_barriers SET phase = 'pausing', generation = max(generation, ?2) + 1,
       since = ${NOW}
     WHERE shard = ?1 AND phase = 'running'`,
  )
    .bind(shard, local.generation)
    .run();
  await barrierHooks.afterPausing?.();
  let directory = await directoryBarrier(env, shard);
  if (directory.phase === "recovering") throw new Error("the read model's barrier is recovering");
  // A resume came between: it stands, and the step says so.
  if (directory.phase === "running") return standing(env, shard, { live: 0, until: null });
  local = await localBarrier(env, shard);
  // A resume that reopened the read model's barrier but not yet the directory's (or a read model
  // ahead of it): a new generation past it.
  await overtake(env, shard, directory, local);
  directory = await directoryBarrier(env, shard);
  const { generation } = directory;
  // The read model's own, from an older generation to this one: no older batch is admitted. (A
  // step that moved the directory's meanwhile is seen below.)
  if (local.generation < generation && directory.phase !== "running")
    await admitted(env, shard, generation, (org) =>
      org
        .prepare(
          "UPDATE read_model_barrier SET phase = 'pausing', generation = ?1 WHERE id = 1 AND generation < ?1",
        )
        .bind(generation),
    );
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
  directory = await directoryBarrier(env, shard);
  if (directory.phase === "paused" && directory.generation === generation)
    await admitted(env, shard, generation, (org) =>
      org
        .prepare(
          "UPDATE read_model_barrier SET phase = 'paused' WHERE id = 1 AND phase = 'pausing' AND generation = ?",
        )
        .bind(generation),
    );
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
  let barrier = await directoryBarrier(env, shard);
  if (barrier.phase === "running" || barrier.phase === "recovering") return barrier;
  const local = await localBarrier(env, shard);
  if (local.generation > barrier.generation) {
    // A read model ahead of the directory (restored): the directory's barrier moves up to it
    // first (still not running), so a maintenance writer can write at it.
    await env.DIRECTORY.prepare(
      `UPDATE read_model_barriers SET generation = ?4, since = ${NOW}
       WHERE shard = ?1 AND phase = ?2 AND generation = ?3`,
    )
      .bind(shard, barrier.phase, barrier.generation, local.generation)
      .run();
    barrier = await directoryBarrier(env, shard);
    if (barrier.phase === "running" || barrier.generation !== local.generation) return barrier;
  }
  const { generation } = barrier;
  await barrierHooks.beforeChange?.("resume");
  await admitted(env, shard, generation, (org) =>
    org
      .prepare(
        `UPDATE read_model_barrier SET phase = 'running', generation = ?3
         WHERE id = 1 AND phase = ?1 AND generation = ?2`,
      )
      .bind(local.phase, local.generation, generation),
  );
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

/** The barriers, admission and leases as the status operation reports them (null: a row missing). */
export interface ReadModelState {
  readonly directory:
    | (Barrier & { readonly executorVersion: number; readonly floor: string | null })
    | null;
  readonly local: (Barrier & { readonly protocolVersion: number }) | null;
  readonly admission: {
    readonly open: boolean;
    readonly stray: number;
    readonly sequence: number;
  } | null;
  readonly writers: {
    readonly live: number;
    readonly expired: number;
    readonly earliest: number | null;
  };
}

/** The shard's barriers, admission and leases: a few singleton reads and the shard's leases. */
export async function readModelState(
  env: Pick<Env, "DIRECTORY" | "ORG_READ">,
  shard: string,
): Promise<ReadModelState> {
  const [barrier, writers] = await env.DIRECTORY.batch([
    env.DIRECTORY.prepare(
      `SELECT phase, generation, executor_version AS executorVersion,
         read_model_protocol_since AS floor FROM read_model_barriers WHERE shard = ?`,
    ).bind(shard),
    env.DIRECTORY.prepare(
      `SELECT count(*) FILTER (WHERE until > ${NOW}) AS live,
         count(*) FILTER (WHERE until <= ${NOW}) AS expired,
         min(until) FILTER (WHERE until > ${NOW}) AS earliest
       FROM read_model_writers WHERE shard = ?`,
    ).bind(shard),
  ]);
  const org = rawReadModel(env, shard);
  const [local, admission] = await org.batch([
    org.prepare(
      "SELECT phase, generation, protocol_version AS protocolVersion FROM read_model_barrier WHERE id = 1",
    ),
    org.prepare("SELECT open, stray, seq AS sequence FROM read_model_write WHERE id = 1"),
  ]);
  const counted = writers?.results[0] as
    | { live: number; expired: number; earliest: number | null }
    | undefined;
  const written = admission?.results[0] as
    | { open: number; stray: number; sequence: number }
    | undefined;
  return {
    directory: (barrier?.results[0] as ReadModelState["directory"] | undefined) ?? null,
    local: (local?.results[0] as ReadModelState["local"] | undefined) ?? null,
    admission: written ? { ...written, open: written.open === 1 } : null,
    writers: {
      live: counted?.live ?? 0,
      expired: counted?.expired ?? 0,
      earliest: counted?.earliest ?? null,
    },
  };
}
