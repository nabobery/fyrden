import { d1StatementsRun } from "@fyrden/adapters-cloudflare/obs";

/*
 * Work that may run many directory queries starts only when the invocation
 * has room for all of them, by the tally of every statement it ran
 * (`countedD1`; a batch's statements each, though the platform counts a
 * batch once), and ends its invocation once done. The room is the
 * deployment's per-invocation budget (`internalCallLimit`): D1 queries
 * share it with R2 and Durable Object calls (measured on Workers Free,
 * 2026-10-10 to 2026-10-26; D1's limits page says 50 on Free, which did
 * not hold).
 */

/** Whether the invocation the caller runs in has room for `need` more D1 queries of `limit`. */
export function d1Room(need: number, limit: number): boolean {
  return d1StatementsRun() + need <= limit;
}
