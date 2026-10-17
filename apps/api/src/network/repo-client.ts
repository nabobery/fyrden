import type { NetworkPackRef, NetworkRetire } from "@fyrden/adapters-cloudflare/git";
import type { Metrics } from "@fyrden/adapters-cloudflare/obs";

/*
 * How a repository object reaches its fork network's object: for retiring
 * packs the network shares, for the orphan sweep's gate, and to report a
 * finished detach; and the network's other members, from the directory.
 */

function byNetwork(packs: readonly NetworkPackRef[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const pack of packs)
    out.set(pack.networkId, [...(out.get(pack.networkId) ?? []), pack.packId]);
  return out;
}

/** The retire job's network side: packs the network shares are released to it, never deleted here. */
export function networkRetire(env: Env, repoId: () => string): NetworkRetire {
  return {
    async shared(packs) {
      const out = new Set<string>();
      for (const [networkId, ids] of byNetwork(packs))
        for (const id of await env.NETWORK.getByName(networkId).sharedPacks(ids)) out.add(id);
      return out;
    },
    async release(packs) {
      for (const [networkId, packIds] of byNetwork(packs))
        await env.NETWORK.getByName(networkId).releaseClaims({
          networkId,
          repoId: repoId(),
          packIds,
        });
    },
  };
}

/** Whether `repoId` may sweep its network's pack prefix alone (the network object answers from its membership). */
export function soleNetworkMember(env: Env, networkId: string, repoId: string): Promise<boolean> {
  return env.NETWORK.getByName(networkId).isSoleMember(repoId);
}

/**
 * The ids of the other active repositories of `repoId`'s fork network (as
 * the directory has it now), after `after`, at most `limit`, in id order.
 */
export async function networkMembersAfter(
  env: Env,
  repoId: string,
  after: string,
  limit: number,
  metrics?: Metrics,
): Promise<string[]> {
  metrics?.count("d1.query", { db: "directory", op: "network_members" });
  const { results } = await env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT r.id FROM repos r JOIN repos me ON me.id = ?1
       WHERE r.network_id = me.network_id AND r.id <> ?1 AND r.state = 'active' AND r.id > ?2
       ORDER BY r.id LIMIT ?3`,
    )
    .bind(repoId, after, limit)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/** After a detach swapped: the old network records it, the new one takes it as root, the directory follows. */
export function detachNotifier(
  env: Env,
  repoId: () => string,
): (oldNetworkId: string, newNetworkId: string) => Promise<void> {
  return async (oldNetworkId, newNetworkId) => {
    const id = repoId();
    await env.NETWORK.getByName(newNetworkId).registerRoot({ networkId: newNetworkId, repoId: id });
    await env.NETWORK.getByName(oldNetworkId).completeDetach({
      networkId: oldNetworkId,
      repoId: id,
    });
    await env.DIRECTORY.prepare("UPDATE repos SET network_id = ?, updated_at = ? WHERE id = ?")
      .bind(newNetworkId, Date.now(), id)
      .run();
  };
}
