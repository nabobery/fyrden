import type { WorkersPlan } from "./wire.js";

/**
 * The deployment's Workers plan, from the `FYRDEN_PLAN` variable that
 * `fyrden deploy --plan free|paid` sets. Anything else (a local
 * `wrangler dev`, a hand-made deploy) is treated as Free, whose response
 * shape works on both plans.
 */
export function workersPlan(env: object): WorkersPlan {
  return (env as { FYRDEN_PLAN?: unknown }).FYRDEN_PLAN === "paid" ? "paid" : "free";
}
