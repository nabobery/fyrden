import { type JobHandler, packObjectKey, type SliceResult } from "@fyrden/adapters-cloudflare/git";
import type { RepoDO } from "../do/RepoDO.js";
import { type NetworkRuntime, SliceCalls } from "./runtime.js";

/*
 * Two-phase deletion of shared packs, as the network
 * object's job. A shared pack no member claims is condemned (registry.ts);
 * then:
 *
 * 1. Every member is asked to acknowledge it: it condemns its own row, if it
 *    has one, so it grants no new lease, and reports when its leases on the
 *    pack end. A member that cannot be reached, or does not answer, stays
 *    pending and blocks the deletion; it is asked again later. A member
 *    whose view still holds the pack refuses: the claims were out of date,
 *    so the pack is claimed again (at a sequence the member learns as it
 *    refuses, see claim-releases.ts) and the deletion dropped.
 * 2. Once every member has acknowledged, every lease they reported has
 *    ended and the retention has passed, the claims are checked again (a
 *    restore may have claimed the pack meanwhile) and, in the same
 *    transaction, the deletion fence is set: from then on a claim is told
 *    the pack is gone and nothing reprieves it. Only then are the R2
 *    objects deleted, and the pack recorded as deleted.
 *
 * Every step is safe to redo: acknowledgements are idempotent, a fenced
 * deletion is finished by the next run whatever happened to this one (R2
 * deletes are idempotent), and the R2 delete comes before the row that
 * records it.
 *
 * A pass goes through the deletions in pack id order, and each one's
 * members in id order, asking each member once. A slice makes at most the
 * policy's `sliceCalls` calls and saves where it stopped, so a member that
 * did not answer is asked again next pass, not by the next slice.
 */

/** Where a pass stopped: at the deletion of `pack`, its members up to `asked` asked. */
interface DeletionCursor {
  readonly v: 1;
  readonly pack: string;
  readonly asked?: string;
}

const encode = (cursor: DeletionCursor) => new TextEncoder().encode(JSON.stringify(cursor));
function decode(bytes: Uint8Array | null): DeletionCursor | undefined {
  if (!bytes) return undefined;
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as DeletionCursor;
    return value.v === 1 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function deletionHandler(runtime: NetworkRuntime): JobHandler {
  return { runSlice: (job) => deletionSlice(runtime, decode(job.cursor)) };
}

async function deletionSlice(
  runtime: NetworkRuntime,
  saved: DeletionCursor | undefined,
): Promise<SliceResult> {
  const { registry, env, hooks, policy, context } = runtime;
  const networkId = registry.networkId();
  if (!networkId) return { done: true };
  const deadline = context.now() + policy.sliceMs;
  const calls = new SliceCalls(policy.sliceCalls, context.metrics);
  const deletions = registry
    .deletions()
    .filter((d) => !saved || d.packId >= saved.pack)
    .sort((a, b) => (a.packId < b.packId ? -1 : 1));
  for (const deletion of deletions) {
    const { packId } = deletion;
    let asked = saved?.pack === packId ? saved.asked : undefined;
    const paused = (): SliceResult => ({
      done: false,
      cursor: encode({ v: 1, pack: packId, ...(asked === undefined ? {} : { asked }) }),
      runAfterMs: 0,
    });
    if (context.now() >= deadline) return paused();
    if (deletion.deletingSince !== null) {
      // Fenced by an earlier run that did not finish: finish it.
      if (!calls.fits(1)) return paused();
      await deleteBytes(runtime, calls, networkId, packId);
      continue;
    }
    for (const repoId of [...deletion.acksPending].sort()) {
      if (asked !== undefined && repoId <= asked) continue;
      if (!registry.member(repoId)) {
        registry.acknowledge(packId, repoId, 0);
        asked = repoId;
        continue;
      }
      if (context.now() >= deadline || !calls.fits(1)) return paused();
      calls.count("do.request", { class: "RepoDO", method: "condemnShared" });
      let answer: Awaited<ReturnType<DurableObjectStub<RepoDO>["condemnShared"]>>;
      // A refusal's claim is made at this sequence, which the member learns as it refuses.
      const seq = registry.nextClaimSeq();
      try {
        await hooks.beforeAck?.(repoId, [packId]);
        answer = await env.REPO.getByName(repoId).condemnShared([packId], { networkId, seq });
      } catch (error) {
        runtime.log.warn("a member did not acknowledge a condemned pack", {
          repoId,
          packId,
          error,
        });
        asked = repoId;
        continue;
      }
      asked = repoId;
      if (!answer.ok) {
        // Still in that member's view: it claims the pack after all.
        registry.claimAt(repoId, [packId], seq);
        registry.reprieve(packId);
        count(runtime, "reprieved");
        break;
      }
      registry.acknowledge(packId, repoId, answer.leasesUntil);
    }
    const current = registry.deletion(packId);
    if (!current || current.acksPending.length > 0) continue;
    const now = context.now();
    if (now < current.notBefore || now < current.leasesUntil) continue;
    if (!calls.fits(1)) return paused();
    await hooks.beforeDelete?.(packId);
    // Checked again after the pause: a claim made meanwhile keeps the pack.
    // Otherwise the fence goes up in the same transaction, before any byte goes.
    const fenced = context.storage.transactionSync(() => {
      if (!registry.deletion(packId)) return false;
      if (registry.claimants(packId).length > 0) {
        registry.reprieve(packId);
        count(runtime, "reprieved");
        return false;
      }
      return registry.fence(packId);
    });
    if (fenced) await deleteBytes(runtime, calls, networkId, packId);
  }
  return next(runtime);
}

/** Phase 2 behind the fence: the R2 objects, then the row recording them deleted. */
async function deleteBytes(
  runtime: NetworkRuntime,
  calls: SliceCalls,
  networkId: string,
  packId: string,
) {
  const { env, hooks, registry } = runtime;
  await hooks.whileDeleting?.(packId);
  calls.count("r2.class_a", { bucket: "fyrden-git", op: "delete" });
  await env.GIT.delete([
    packObjectKey(networkId, packId, "pack"),
    packObjectKey(networkId, packId, "idx"),
  ]);
  registry.markDeleted(packId);
  count(runtime, "deleted");
}

/** When the next deletion step is due; done when nothing is condemned. */
function next(runtime: NetworkRuntime): SliceResult {
  const { registry, policy, context } = runtime;
  const now = context.now();
  const due = registry
    .deletions()
    .map((d) =>
      d.acksPending.length > 0 ? now + policy.ackRetryMs : Math.max(d.notBefore, d.leasesUntil),
    );
  if (due.length === 0) return { done: true };
  const at = Math.min(...due);
  return { done: false, cursor: null, runAfterMs: Math.max(at > now ? at - now : 0, 1_000) };
}

function count(runtime: NetworkRuntime, what: string): void {
  runtime.context.metrics.count("git.maintenance", { job: "network-delete", what }, 1);
}
