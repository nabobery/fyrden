import { d1StatementsRun } from "@fyrden/adapters-cloudflare/obs";

/*
 * D1 allows a Workers Free invocation 50 queries (Paid: 1,000), counted
 * apart from its internal calls (https://developers.cloudflare.com/d1/platform/limits/).
 * Work that may run many directory queries starts only when the invocation
 * has room for all of them, by the tally of every statement it ran
 * (`countedD1`), and ends its invocation once done. Measured on Free
 * (2026-10-17), D1 refused only past the shared 1,000 internal calls, not
 * at 50; Fyrden keeps to the documented 50.
 */

/** D1 queries one invocation may run (Free's). */
export const D1_QUERIES_PER_INVOCATION = 50;

/** Whether the invocation the caller runs in has room for `need` more D1 queries. */
export function d1Room(need: number): boolean {
  return d1StatementsRun() + need <= D1_QUERIES_PER_INVOCATION;
}
