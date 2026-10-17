import { env } from "cloudflare:workers";
import { sweepEffects } from "../../src/effects/dispatcher.js";

/**
 * Settles every effect other tests left due by `at` (the journal is shared
 * by every test file): with no sinks they fail at once, without side
 * effects, so a sweep after it meets only the effects the caller makes.
 */
export async function settleOthersDue(at: number): Promise<void> {
  for (let round = 0; round < 100; round++) {
    const due = await env.ORG_READ.prepare(
      `SELECT count(*) AS n FROM effects WHERE state = 'pending' AND next_attempt_at <= ?1
         AND (lease_until IS NULL OR lease_until <= ?1)`,
    )
      .bind(at)
      .first<{ n: number }>();
    if (!due?.n) return;
    await sweepEffects({ db: env.ORG_READ, env, sinks: [], now: () => at });
  }
  throw new Error("effects other tests left due did not settle");
}
