import type { Metrics } from "@fyrden/adapters-cloudflare/obs";

/*
 * Handles a deletion released are held for 90 days (`handle_reservations`):
 * every statement that gives a principal a handle is conditioned on
 * `handleFree`, so a held handle is taken by no one until its reservation
 * ends, and is free from then on.
 */

/** How long a released handle stays held. */
export const HANDLE_HOLD_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * An SQL condition: no unexpired reservation holds the handle bound at
 * `handle` (compared ignoring case) at the time bound at `now`.
 */
export function handleFree(handle: string, now: string): string {
  return `NOT EXISTS (SELECT 1 FROM handle_reservations WHERE handle = ${handle} AND until > ${now})`;
}

/** How a deleted principal (or one being deleted) is shown, as GitHub shows one. */
export const GHOST_LOGIN = "ghost";

/**
 * An SQL expression of a `principals` row (aliased `p`): its handle as
 * shown, `ghost` for a principal being deleted or deleted (its handle is
 * released, and held for someone else).
 */
export const SHOWN_HANDLE = `CASE WHEN p.lifecycle IN ('deleting', 'deleted') THEN '${GHOST_LOGIN}' ELSE p.handle END`;

/** Principals one directory query reads (D1 binds at most 100 parameters). */
const GHOST_BATCH = 90;

/**
 * Of `ids`, those being deleted or deleted, from the directory's primary:
 * a listing that keeps copies of handles (members, collaborators) shows
 * them as `ghost`, their handles released.
 */
export async function ghostsAmong(
  env: Env,
  ids: readonly string[],
  metrics?: Metrics,
): Promise<Set<string>> {
  const ghosts = new Set<string>();
  const unique = [...new Set(ids)];
  const db = env.DIRECTORY.withSession("first-primary");
  for (let at = 0; at < unique.length; at += GHOST_BATCH) {
    const batch = unique.slice(at, at + GHOST_BATCH);
    metrics?.count("d1.query", { db: "directory", op: "ghosts" });
    const { results } = await db
      .prepare(
        `SELECT id FROM principals WHERE id IN (${batch.map(() => "?").join(", ")})
           AND lifecycle IN ('deleting', 'deleted')`,
      )
      .bind(...batch)
      .all<{ id: string }>();
    for (const row of results) ghosts.add(row.id);
  }
  return ghosts;
}
