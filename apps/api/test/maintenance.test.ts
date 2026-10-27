// The five-minute maintenance runs in a Durable Object of its own: a Free
// Worker's cron trigger gets 10 ms of CPU, a Durable Object's request 30 s.
import { createScheduledController, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import { MAINTENANCE_OBJECT } from "../src/cron/maintenance.js";
import worker from "../src/index.js";

const unreachable = () => {
  throw new Error("the cron trigger itself touched storage");
};

/**
 * `env` with the maintenance object's calls counted, and the directory and
 * the bucket out of the cron trigger's reach (the object has its own).
 */
function counting() {
  const runs: string[] = [];
  const traced = {
    ...env,
    DIRECTORY: new Proxy({}, { get: unreachable }),
    ASSETS: new Proxy({}, { get: unreachable }),
    MAINTENANCE: {
      getByName: (name: string) => {
        const stub = env.MAINTENANCE.getByName(name);
        return {
          run: () => {
            runs.push(`${name} run`);
            return stub.run();
          },
          repairSearch: () => {
            runs.push(`${name} repairSearch`);
            return stub.repairSearch();
          },
          recheckSuppressions: () => {
            runs.push(`${name} recheckSuppressions`);
            return stub.recheckSuppressions();
          },
        };
      },
    },
  } as unknown as Env;
  return { runs, traced };
}

const cron = (traced: Env, expression = "*/5 * * * *") =>
  worker.scheduled?.(createScheduledController({ cron: expression }), traced);

/** An idempotency key that expired: the maintenance reaps it. */
async function expiredKey() {
  const key = uniqueId("key");
  await env.DIRECTORY.prepare(
    `INSERT INTO idempotency_keys (token_id, key, claim_id, op_id, request_hash, state,
       started_at, expires_at)
     VALUES ('tok_test', ?, 'claim', 'op', 'hash', 'done', 1, 2)`,
  )
    .bind(key)
    .run();
  return async () =>
    (
      await env.DIRECTORY.prepare("SELECT count(*) AS n FROM idempotency_keys WHERE key = ?")
        .bind(key)
        .first<{ n: number }>()
    )?.n;
}

describe("the five-minute maintenance", () => {
  it("is run by the maintenance object, not by the cron trigger itself", async () => {
    const left = await expiredKey();
    const { runs, traced } = counting();
    await cron(traced);
    // The maintenance, and search repairs and suppression rechecks in requests of their own.
    expect(runs).toEqual([
      `${MAINTENANCE_OBJECT} run`,
      `${MAINTENANCE_OBJECT} repairSearch`,
      `${MAINTENANCE_OBJECT} recheckSuppressions`,
    ]);
    expect(await left()).toBe(0);
  });

  it("is not what the effects and deletions crons run", async () => {
    const { runs, traced } = counting();
    await cron({ ...traced, DIRECTORY: env.DIRECTORY }, "2-59/5 * * * *");
    await cron({ ...traced, DIRECTORY: env.DIRECTORY }, "4-59/5 * * * *");
    expect(runs).toEqual([]);
  });

  it("joins a run already under way rather than starting another", async () => {
    await runInDurableObject(env.MAINTENANCE.getByName(MAINTENANCE_OBJECT), async (object) => {
      const first = object.run();
      expect(object.run()).toBe(first);
      await first;
      const next = object.run();
      expect(next).not.toBe(first);
      await next;
    });
  });

  it("fails the cron trigger when a task fails, after the other tasks ran, and runs again after", async () => {
    // An audit row whose time no date can hold: archiving it throws.
    const bad = await env.DIRECTORY.prepare(
      "INSERT INTO audit_log (at, action) VALUES (-1e20, 'test.unarchivable') RETURNING seq",
    ).first<{ seq: number }>();
    const left = await expiredKey();
    const { traced } = counting();
    try {
      await runInDurableObject(env.MAINTENANCE.getByName(MAINTENANCE_OBJECT), async (object) => {
        const first = object.run();
        const joined = object.run();
        await expect(first).rejects.toThrow(/1 scheduled task\(s\) failed/);
        await expect(joined).rejects.toThrow(/1 scheduled task\(s\) failed/);
      });
      expect(await left()).toBe(0);
      await expect(cron(traced)).rejects.toThrow(/1 scheduled task\(s\) failed/);
    } finally {
      await env.DIRECTORY.prepare("DELETE FROM audit_log WHERE seq = ?").bind(bad?.seq).run();
    }
    await cron(traced);
  });
});
