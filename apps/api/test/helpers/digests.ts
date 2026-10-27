// Digests in tests: a repository whose pushed tier is full, with readers
// (and a stranger) watching past it; windows held on the test clock; and
// reads of the repository's digest state.

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { DomainEvent } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { expect, vi } from "vitest";
import type { RepoDO } from "../../src/do/RepoDO.js";
import { DIGEST_POLICY, windowOf } from "../../src/do/repo/digests.js";
import { WATCH_POLICY } from "../../src/do/repo/watching.js";
import { api, json, user, type Who } from "./api.js";

export const { windowMs, sealAfterMs } = DIGEST_POLICY;

export type Repo = { id: string; fullName: string };

export const stubOf = (repoId: string) => env.REPO.getByName(repoId);

/** A private repository of `owner`'s, which `readers` read (collaborators with `pull`). */
export async function repoOf(owner: Who, readers: readonly Who[]): Promise<Repo> {
  const made = await json<{ id: string; name: string }>(
    api("POST", "/user/repos", owner.token, { name: uniqueId("d") }),
  );
  expect(made.status).toBe(201);
  const fullName = `${owner.handle}/${made.body.name}`;
  for (const reader of readers)
    expect(
      (
        await api("PUT", `/repos/${fullName}/collaborators/${reader.handle}`, owner.token, {
          permission: "pull",
        })
      ).status,
    ).toBeLessThan(300);
  return { id: made.body.id, fullName };
}

/** The pushed tier's watchers (written as the repository would, for speed): first in its order. */
export const PUSHED = Array.from(
  { length: WATCH_POLICY.pushed },
  (_, i) => `usr_00${String(i).padStart(6, "0")}`,
);
/** A watcher past the pushed tier that does not read the repository (ordered after real users). */
export const STRANGER = "usr_02stranger";

/**
 * A repository with watch audiences on: the pushed tier filled, then
 * `readers` (who read it) and a stranger watching past it.
 */
export async function digestRepo(readerCount = 2) {
  const owner = await user();
  const readers: Who[] = [];
  for (let i = 0; i < readerCount; i++) readers.push(await user());
  const repo = await repoOf(owner, readers);
  await runInDurableObject(stubOf(repo.id), (instance: RepoDO, state) => {
    instance.watchAudiences = true;
    state.storage.transactionSync(() => {
      for (const id of PUSHED) instance.watching.set(id, id, "watching");
      instance.watching.set(STRANGER, STRANGER, "watching");
    });
  });
  for (const reader of readers)
    expect(
      (await api("PUT", `/repos/${repo.fullName}/subscription`, reader.token, { subscribed: true }))
        .status,
    ).toBe(200);
  return { owner, readers, repo };
}

export const open = async (who: Who, repo: Repo, title = "One") =>
  (
    await json<{ number: number }>(
      api("POST", `/repos/${repo.fullName}/issues`, who.token, { title }),
    )
  ).body.number;
export const comment = (who: Who, repo: Repo, number: number) =>
  api("POST", `/repos/${repo.fullName}/issues/${number}/comments`, who.token, { body: "more" });

export const rows = <T extends Record<string, SqlStorageValue>>(repoId: string, query: string) =>
  runInDurableObject(stubOf(repoId), (_: RepoDO, state) =>
    state.storage.sql
      .exec<T>(query)
      .toArray()
      .map((r) => ({ ...r })),
  );

export const threads = (repoId: string) =>
  rows<{ subject: string; number: number }>(
    repoId,
    "SELECT subject, number FROM digest_threads ORDER BY subject, number",
  );
export const windows = (repoId: string) =>
  rows<{ subject: string; threads: number; live: number; sealed: number }>(
    repoId,
    "SELECT subject, threads, live, sealed FROM digest_windows ORDER BY win, subject",
  );
export const credit = (repoId: string) =>
  rows<{ subject: string; units: number }>(
    repoId,
    "SELECT subject, units FROM digest_credit WHERE units > 0 ORDER BY subject",
  );
export const job = async (repoId: string, kind: string) =>
  (
    await rows<{ state: string; attempts: number; next_run_at: number }>(
      repoId,
      `SELECT state, attempts, next_run_at FROM jobs WHERE job_id = '${kind}'`,
    )
  )[0];

/** The repository's digest events since `from`. */
export const digestEvents = (repoId: string, from = 0) =>
  rows<{ event: string }>(
    repoId,
    `SELECT event FROM outbox WHERE source_seq > ${from} ORDER BY source_seq`,
  ).then((all) =>
    all
      .map((r) => JSON.parse(r.event) as DomainEvent)
      .filter((e) => e.type === "repository.digest"),
  );

/** Runs the repository's alarms until none is due now, at most `max`. */
export async function drain(repoId: string, max = 10) {
  for (let i = 0; i < max; i++) if (!(await runDurableObjectAlarm(stubOf(repoId)))) return;
}

/** Holds the clock a minute into the next window; the window. */
export function startWindow(): number {
  const window = windowOf(Date.now()) + 1;
  vi.setSystemTime(window * windowMs + 60_000);
  return window;
}

/** Moves the clock past the window's seal. */
export const pastSeal = (window: number) =>
  vi.setSystemTime((window + 1) * windowMs + sealAfterMs + 1);
