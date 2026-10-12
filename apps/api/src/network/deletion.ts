import { type JobHandler, packObjectKey, type SliceResult } from "@fyrden/adapters-cloudflare/git";
import type { NetworkRuntime } from "./runtime.js";

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
 *    so the pack is claimed again and the deletion dropped.
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
 */

export function deletionHandler(runtime: NetworkRuntime): JobHandler {
  return { runSlice: () => deletionSlice(runtime) };
}

async function deletionSlice(runtime: NetworkRuntime): Promise<SliceResult> {
  const { registry, env, hooks, policy, context } = runtime;
  const networkId = registry.networkId();
  if (!networkId) return { done: true };
  const deadline = context.now() + policy.sliceMs;
  for (const deletion of registry.deletions()) {
    if (context.now() >= deadline) return { done: false, cursor: null, runAfterMs: 0 };
    const { packId } = deletion;
    if (deletion.deletingSince !== null) {
      // Fenced by an earlier run that did not finish: finish it.
      await deleteBytes(runtime, networkId, packId);
      continue;
    }
    for (const repoId of deletion.acksPending) {
      if (!registry.member(repoId)) {
        registry.acknowledge(packId, repoId, 0);
        continue;
      }
      let answer: Awaited<
        ReturnType<DurableObjectStub<import("../do/RepoDO.js").RepoDO>["condemnShared"]>
      >;
      try {
        await hooks.beforeAck?.(repoId, [packId]);
        answer = await env.REPO.getByName(repoId).condemnShared([packId]);
      } catch (error) {
        runtime.log.warn("a member did not acknowledge a condemned pack", {
          repoId,
          packId,
          error,
        });
        continue;
      }
      if (!answer.ok) {
        // Still in that member's view: it claims the pack after all.
        registry.claim([repoId], [packId]);
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
    if (fenced) await deleteBytes(runtime, networkId, packId);
  }
  return next(runtime);
}

/** Phase 2 behind the fence: the R2 objects, then the row recording them deleted. */
async function deleteBytes(runtime: NetworkRuntime, networkId: string, packId: string) {
  const { env, hooks, registry, context } = runtime;
  await hooks.whileDeleting?.(packId);
  context.metrics.count("r2.class_a", { bucket: "fyrden-git", op: "delete" });
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
