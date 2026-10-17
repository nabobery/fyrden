import {
  type JobHandler,
  type RepoGitStorage,
  type SliceResult,
  schedulePackRetire,
} from "@fyrden/adapters-cloudflare/git";
import type { Logger } from "@fyrden/adapters-cloudflare/obs";
import { decodeJson, encodeJson } from "../git/maintenance/storage.js";
import { learnClaimSeq, recordRelease } from "./claim-releases.js";
import { heldPacks, registeredPacks } from "./member.js";

/*
 * A restored repository claiming its fork networks' packs again. A
 * point-in-time restore brings back rows whose claims the repository gave
 * up after the restore point, their releases told already or still on
 * their way. In the transaction that takes the new restore generation, the
 * `network_reclaim` job is queued (from the start, should a restore find
 * it under way); it runs on the object's next alarm and, network by
 * network, asks the network to claim every pack the rows hold. The network
 * claims them at a sequence newer than any of those releases' bounds, so
 * none of them removes these claims, and the repository learns it (see
 * claim-releases.ts). A network that cannot be reached is asked again
 * later, from where the job was, until it answers.
 */

/** The reclaim job is one per repository, keyed by this id. */
export const NETWORK_RECLAIM_JOB = "network-reclaim";

/** Networks (a call to each) one slice of the job asks at most. Proposed. */
const NETWORKS_PER_SLICE = 10;

/** When a network that could not be asked is asked again: doubling per failure, at most an hour. */
const RETRY_MS = 30_000;
const RETRY_MAX_MS = 60 * 60_000;

/** The networks asked so far (ids in order) and the failures since the last answer. */
interface ReclaimCursor {
  readonly after: string;
  readonly failures: number;
}

/** What a restored repository asks of a fork network's object (its stub, or a stand-in in tests). */
export interface ReclaimNetwork {
  claim(input: {
    networkId: string;
    repoId: string;
    packIds: readonly string[];
  }): Promise<{ ok: true; gone: string[]; seq: number } | { ok: false; error: string }>;
}

export interface ReclaimDeps {
  readonly git: RepoGitStorage;
  readonly network: (networkId: string) => ReclaimNetwork;
  readonly repoId: () => string;
  readonly log: () => Logger;
}

/** In the transaction taking a new restore generation: the packs are claimed again, from the start. */
export function reclaimAfterRestore(git: RepoGitStorage): void {
  git.jobs.restart("network_reclaim", NETWORK_RECLAIM_JOB);
}

/**
 * The job: in each network (in id order) the registry stores packs under,
 * claims every pack its rows hold, at most `NETWORKS_PER_SLICE` networks a
 * slice. A row its retire job dropped while the claim was on its way had
 * its release bounded before the sequence the network answers: it is
 * released again, bounded by it. Packs the network has deleted or is
 * deleting are logged: their bytes are gone.
 */
export function networkReclaimHandler(deps: ReclaimDeps): JobHandler {
  return {
    runSlice: async (job): Promise<SliceResult> => {
      const { git, network, repoId, log } = deps;
      let cursor = decodeJson<ReclaimCursor>(job.cursor) ?? { after: "", failures: 0 };
      const networks = git.context.storage.sql
        .exec<{ network_id: string }>(
          `SELECT DISTINCT network_id FROM packs WHERE network_id > ? ORDER BY network_id LIMIT ?`,
          cursor.after,
          NETWORKS_PER_SLICE + 1,
        )
        .toArray()
        .map((r) => r.network_id);
      for (const networkId of networks.slice(0, NETWORKS_PER_SLICE)) {
        const packIds = heldPacks(git, networkId).map((r) => r.pack_id);
        if (packIds.length > 0) {
          git.context.metrics.count("do.request", { class: "NetworkDO", method: "claim" });
          let answer: Awaited<ReturnType<ReclaimNetwork["claim"]>>;
          try {
            answer = await network(networkId).claim({ networkId, repoId: repoId(), packIds });
          } catch (error) {
            answer = { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
          if (!answer.ok) {
            log().warn("claiming a restored repository's packs again failed", {
              networkId,
              error: answer.error,
            });
            const failures = cursor.failures + 1;
            return {
              done: false,
              cursor: encodeJson({ ...cursor, failures }),
              runAfterMs: Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (failures - 1)),
            };
          }
          const { seq, gone } = answer;
          git.context.storage.transactionSync(() => {
            learnClaimSeq(git, networkId, seq);
            const kept = new Set(registeredPacks(git, packIds));
            const dropped = packIds.filter((packId) => !kept.has(packId));
            for (const packId of dropped) recordRelease(git, { packId, networkId });
            // Told on the retire job's next pass.
            if (dropped.length > 0) schedulePackRetire(git.jobs, git.context.now());
          });
          if (gone.length > 0)
            log().error("a restored repository names packs its network has deleted", {
              networkId,
              packs: gone,
            });
        }
        cursor = { after: networkId, failures: 0 };
      }
      return networks.length > NETWORKS_PER_SLICE
        ? { done: false, cursor: encodeJson(cursor), runAfterMs: 0 }
        : { done: true };
    },
  };
}
