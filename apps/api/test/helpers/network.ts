import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createDoMemoryBudget } from "@fyrden/adapters-cloudflare/git";
import { createLogger } from "@fyrden/adapters-cloudflare/obs";
import { uniqueId } from "@fyrden/testing";
import type { NetworkDO } from "../../src/do/NetworkDO.js";
import type { RepoDO } from "../../src/do/RepoDO.js";
import { deletionHandler } from "../../src/network/deletion.js";
import { type ForkOptions, forkRepository } from "../../src/network/fork.js";
import { networkGcHandler } from "../../src/network/gc.js";
import { NETWORK_DELETE_JOB_ID, NETWORK_GC_JOB_ID } from "../../src/network/runtime.js";
import { type RepoEntry, resolveRepo } from "../../src/repos/directory.js";
import { fetchBody, packObjects, parseFetchResponse, throughWorker } from "./fetch-repo.js";
import { basic, ORIGIN, type TestRepo } from "./git-http.js";
import { inRepo } from "./repo-git.js";

export type Owner = { principalId: string; token: string };
export const handleOf = (owner: Owner) => owner.principalId.toLowerCase().replace("_", "-");

type Outcome<R> = { ok: true; value: R } | { ok: false; message: string };

/** Runs `fn` inside the network object as one request, rethrowing its error here. */
export async function inNetwork<R>(
  networkId: string,
  fn: (network: NetworkDO) => R | Promise<R>,
): Promise<R> {
  const outcome = await runInDurableObject(
    env.NETWORK.getByName(networkId),
    async (network: NetworkDO): Promise<Outcome<R>> => {
      try {
        return { ok: true, value: await fn(network) };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
  );
  if (outcome.ok) return outcome.value;
  throw new Error(outcome.message);
}

/** The directory entry of a test repository. */
export async function entryOf(owner: Owner, repo: TestRepo): Promise<RepoEntry> {
  const entry = await resolveRepo(env, handleOf(owner), repo.name, { consistency: "primary" });
  if (!entry) throw new Error(`no directory row for ${repo.name}`);
  return entry;
}

/** Forks `parent` (owned by `parentOwner`) for `owner`, as the operation does after its access check. */
export async function fork(
  parentOwner: Owner,
  parent: TestRepo,
  owner: Owner,
  options: ForkOptions & { name?: string } = {},
) {
  const name = options.name ?? uniqueId("fork");
  const result = await forkRepository(
    env,
    {
      parent: await entryOf(parentOwner, parent),
      ownerId: owner.principalId,
      ownerHandle: handleOf(owner),
      name,
      maxRepos: Number.MAX_SAFE_INTEGER,
    },
    options,
  );
  if (!result.ok) throw new Error(`fork failed: ${result.code}: ${result.error}`);
  const repo: TestRepo = {
    id: result.repo.id,
    name,
    stub: env.REPO.getByName(result.repo.id) as DurableObjectStub<RepoDO>,
  };
  return { repo, result };
}

/** Clones `wants` from `repo` through the Worker; the objects of the pack, sorted hex (or the ERR text). */
export async function cloneObjects(
  owner: Owner,
  repo: TestRepo,
  wants: readonly string[],
  extra: readonly string[] = [],
): Promise<{ objects?: string[]; error?: string; acks?: readonly string[] }> {
  let out: { objects?: string[]; error?: string; acks?: readonly string[] } = {};
  const request = new Request(`${ORIGIN}/${handleOf(owner)}/${repo.name}.git/git-upload-pack`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-git-upload-pack-request",
      "Git-Protocol": "version=2",
      Authorization: basic(owner.token),
    },
    body: fetchBody([
      ...[...new Set(wants)].map((oid) => `want ${oid}`),
      "ofs-delta",
      "no-progress",
      ...extra,
    ]),
  });
  await throughWorker(request, { plan: undefined }, async (response) => {
    const parsed = parseFetchResponse(new Uint8Array(await response.arrayBuffer()));
    if (parsed.error) out = { error: parsed.error };
    else
      out = {
        ...(parsed.pack ? { objects: (await packObjects(parsed.pack)).oids } : {}),
        ...(parsed.acknowledgments ? { acks: parsed.acknowledgments } : {}),
      };
  });
  return out;
}

/** Runs a network job (queued first) slice by slice inside the network object until it is not due now. */
export async function runNetworkJob(
  networkId: string,
  job: "gc" | "delete",
  { max = 50 }: { max?: number } = {},
): Promise<string> {
  const jobId = job === "gc" ? NETWORK_GC_JOB_ID : NETWORK_DELETE_JOB_ID;
  let state = "queued";
  for (let i = 0; i < max && state === "queued"; i++) {
    state = await inNetwork(networkId, async (network) => {
      const current = network.jobs.get(jobId);
      if (!current || current.state === "done" || current.state === "failed")
        network.jobs.ensure(job === "gc" ? "network_gc" : "network_delete", jobId);
      const runtime = network.runtime;
      const handler = job === "gc" ? networkGcHandler(runtime) : deletionHandler(runtime);
      const ran = await network.jobs.runJob(jobId, handler, createDoMemory(), 0);
      if (ran.state === "busy") return "queued";
      const after = network.jobs.get(jobId);
      const due = network.context.storage.sql
        .exec<{ at: number }>("SELECT next_run_at AS at FROM jobs WHERE job_id = ?", jobId)
        .toArray()[0]?.at;
      if (after?.state === "queued" && (due ?? 0) > network.context.now()) return "scheduled";
      return after?.state ?? "missing";
    });
  }
  return state;
}

const createDoMemory = () => createDoMemoryBudget(16 * 1024 * 1024);

/** Runs the repository's due jobs (the alarm) until the detach job is finished. */
export async function runDetach(stub: DurableObjectStub<RepoDO>, max = 100): Promise<string> {
  for (let i = 0; i < max; i++) {
    const state = await inRepo(stub, async (repo) => {
      await repo.alarm();
      return repo.git.jobs.get("detach")?.state ?? "missing";
    });
    if (state !== "queued" && state !== "running") return state;
  }
  return "unfinished";
}

/** Moves the network object's clock forward by `ms` (relative to real time). */
export function advanceNetwork(networkId: string, ms: number): Promise<void> {
  return inNetwork(networkId, (network) => {
    const current = network.context.now() - Date.now();
    (network.context as { now: () => number }).now = () => Date.now() + current + ms;
  });
}

export const testLog = createLogger({ test: "network" });
