import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import type { OrgDO } from "../../src/do/OrgDO.js";
import type { RunDO } from "../../src/do/RunDO.js";
import { DELIVERY_RECOVERY_MS } from "../../src/do/run/dispatch.js";
import { RUN_JOB } from "../../src/do/run/engine.js";
import { logs } from "../setup/log-capture.js";
import { putSecret, secretValue } from "./ci-secrets.js";
import {
  type gate,
  jobTokensOf,
  type OrgFixture,
  type RegisteredRunner,
  tasksOfRun,
} from "./runners.js";
import { advance, at, expr, inRun, job, jobNamed, now, runStub, workflow } from "./runs.js";

export type Hooks = RunDO["hooks"];

export const reading = (...more: string[]) =>
  workflow(job("a", ["env:", `  V: ${expr("secrets.A")}`, ...more]));

export const account = (f: OrgFixture) => env.ORG.getByName(f.org.id);
export const jobA = (runId: string) => jobNamed(runId, "a");

export async function setSecret(f: OrgFixture, value = secretValue()) {
  expect((await putSecret(f.owner, f.path, "A", value)).status).toBeLessThan(300);
  return value;
}

/** Makes the stored secret fail to open, as a ciphertext that does not authenticate. */
export async function breakSecret(f: OrgFixture) {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(12))));
  await runInDurableObject(account(f), (_: OrgDO, state) => {
    state.storage.sql.exec("UPDATE ci_secrets SET nonce = ? WHERE name = 'A'", nonce);
  });
}

export const hooked = (runId: string, hooks: Hooks) =>
  inRun(runId, (r) => {
    r.hooks = hooks;
  });

export const unjittered = (runId: string) =>
  inRun(runId, (r) => {
    r.jitter = () => 0;
  });

/** A reset: the next request finds a new instance, with nothing in memory. */
export async function reset(runId: string) {
  await evictDurableObject(runStub(runId));
  await at(runId, now(runId));
}

export type Failure = { wire_id: number; job_id: number; task: number; error: string };
export const failuresOf = (runId: string) =>
  inRun(runId, (r) =>
    r.engine.rows<Failure>(
      "SELECT wire_id, job_id, task, error FROM ci_delivery_failures ORDER BY wire_id",
    ),
  );
export const recoveryJob = (runId: string) => inRun(runId, (r) => r.jobs.get(RUN_JOB.delivery));

export const deliveries = async (f: OrgFixture) =>
  (
    await env.DIRECTORY.prepare(
      "SELECT details FROM audit_log WHERE target_id = ? AND action = 'ci.secrets.deliver'",
    )
      .bind(f.org.id)
      .all<{ details: string }>()
  ).results.map((r) => JSON.parse(r.details) as { task_id: number });

export const reservationOf = async (runId: string) => {
  const { jobId } = await jobA(runId);
  return inRun(
    runId,
    (r) =>
      r.engine.rows<{ state: string; started_at: number | null }>(
        "SELECT state, started_at FROM ci_reservations WHERE job_id = ?",
        jobId,
      )[0],
  );
};

export const minutesOf = (f: OrgFixture, runId: string) =>
  runInDurableObject(account(f), (_: OrgDO, state) =>
    state.storage.sql
      .exec<{ used: number; state: string }>(
        "SELECT used, state FROM ci_minutes WHERE key LIKE ?",
        `${runId}/%`,
      )
      .toArray(),
  );

export const credentialOf = (runner: RegisteredRunner) =>
  env.DIRECTORY.prepare(
    "SELECT expires_at, task_assigned_at, task_confirmed_at FROM ci_runners WHERE id = ?",
  )
    .bind(runner.id)
    .first<{
      expires_at: number | null;
      task_assigned_at: number | null;
      task_confirmed_at: number | null;
    }>();
/** Of an ephemeral runner given nothing: neither stamped nor ended. */
export const UNSPENT = { expires_at: null, task_assigned_at: null, task_confirmed_at: null };

export const outcomesOf = (wireId: number) =>
  logs
    .entries()
    .filter((e) => e.msg === "failed delivery" && e.taskId === wireId)
    .map((e) => e.outcome);

/** Nothing of the run's secrets left: no token was minted and no delivery audited. */
export async function nothingDelivered(f: OrgFixture, runId: string) {
  for (const t of await tasksOfRun(runId)) expect(await jobTokensOf(t.id)).toEqual([]);
  expect(await deliveries(f)).toEqual([]);
}

export const down = () => {
  throw new Error("the directory write failed");
};
/** Waits for `held` to be reached, failing at once when `request` settles first. */
export async function reached(held: ReturnType<typeof gate>, request: Promise<unknown>) {
  await Promise.race([
    held.started,
    request.then(() => {
      throw new Error("the request settled before its gate");
    }),
  ]);
}

export const later = (runId: string) => advance(runId, DELIVERY_RECOVERY_MS);
