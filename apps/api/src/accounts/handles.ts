/*
 * Handles a deletion released are held for 90 days (`handle_reservations`):
 * every statement that gives a principal a handle is conditioned on
 * `handleFree`, so a held handle is taken by no one until its reservation
 * ends, and is free from then on.
 */

/**
 * An SQL condition: no unexpired reservation holds the handle bound at
 * `handle` (compared ignoring case) at the time bound at `now`.
 */
export function handleFree(handle: string, now: string): string {
  return `NOT EXISTS (SELECT 1 FROM handle_reservations WHERE handle = ${handle} AND until > ${now})`;
}
