import type {
  NetworkPackRef,
  NetworkRetire,
  ReleaseDelivery,
  RepoGitStorage,
} from "@fyrden/adapters-cloudflare/git";
import type { Logger } from "@fyrden/adapters-cloudflare/obs";

/*
 * A repository's claims on its fork network's packs, given up as its retire
 * job drops their rows, and made again by its pull requests' imports (a
 * share claims the head's packs for the base).
 *
 * Each share answers the sequence the network made its claims at, newer
 * for every share, and the repository keeps the latest it has learnt of
 * each network (`networks.claim_seq`). A release is recorded in the
 * transaction that deletes the pack's row, bounded by that latest sequence
 * (`up_to`), and the network drops the claim only if it was made at the
 * bound or before. So a release that lands late never removes a claim made
 * by a share sent after it was recorded: that share's sequence is newer
 * than any the repository had learnt. Late is common enough: calls through
 * different stubs arrive in no set order
 * (https://developers.cloudflare.com/durable-objects/api/stub/, verified),
 * a replaced instance may still be sending one after its successor told
 * the same release (https://developers.cloudflare.com/durable-objects/platform/known-issues/#global-uniqueness,
 * verified), and one that failed for the caller may still have reached the
 * network. Claims made otherwise (a fork's, the writer's of its own packs,
 * a view compaction's of its output, a collection's of what a member
 * holds) are made at sequence 0 and leave one made already as it is: every
 * release covers them, and once its row of a pack is gone a repository
 * holds it again only through a share.
 *
 * A share sent before the release was recorded may have made its claims at
 * a sequence the bound covers: an import adopts a pack its base had a row
 * of when it shared it only while the row is there still, and shares it
 * again otherwise.
 *
 * A release is kept until the network has answered it: one the network
 * could not be told (the call failed, or the object was reset first) is
 * told on a later pass of the retire job, so no claim outlives its row for
 * long, even where no collection of the network runs (a network down to one
 * member). Telling one twice changes nothing.
 */

/** What the retire job asks of a fork network's object (its stub, or a stand-in in tests). */
export interface ReleaseNetwork {
  sharedPacks(packIds: readonly string[]): Promise<string[]>;
  releaseClaims(input: {
    networkId: string;
    repoId: string;
    releases: readonly { packId: string; upTo: number }[];
  }): Promise<void>;
}

export interface ClaimReleaseDeps {
  readonly network: (networkId: string) => ReleaseNetwork;
  readonly git: RepoGitStorage;
  readonly repoId: () => string;
  readonly log: () => Logger;
}

type Recorded = { pack_id: string; network_id: string; up_to: number };

export class ClaimReleases implements NetworkRetire {
  constructor(private readonly deps: ClaimReleaseDeps) {}

  async shared(packs: readonly NetworkPackRef[]): Promise<ReadonlySet<string>> {
    const out = new Set<string>();
    for (const [networkId, refs] of byNetwork(packs))
      for (const id of await this.deps.network(networkId).sharedPacks(refs.map((r) => r.packId)))
        out.add(id);
    return out;
  }

  release(pack: NetworkPackRef): void {
    const { context } = this.deps.git;
    // Bounded by the latest sequence learnt; one recorded already and not told yet takes it.
    context.storage.sql.exec(
      `INSERT INTO claim_releases (pack_id, network_id, up_to)
       VALUES (?1, ?2, coalesce((SELECT claim_seq FROM networks WHERE network_id = ?2), 0))
       ON CONFLICT (pack_id) DO UPDATE SET up_to = max(up_to, excluded.up_to)`,
      pack.packId,
      pack.networkId,
    );
  }

  async deliver(max: number): Promise<ReleaseDelivery> {
    const due = this.deps.git.context.storage.sql
      .exec<Recorded>(
        "SELECT pack_id, network_id, up_to FROM claim_releases ORDER BY pack_id LIMIT ?",
        max + 1,
      )
      .toArray();
    try {
      await this.#tell(due.slice(0, max));
    } catch (error) {
      this.deps.log().warn("telling the network of released claims failed", { error });
      return "failed";
    }
    return due.length > max ? "more" : "done";
  }

  /** Tells the network of `releases`, one call per network; each answered is forgotten. */
  async #tell(releases: readonly Recorded[]): Promise<void> {
    const { network, git, repoId } = this.deps;
    const refs = releases.map((r) => ({
      packId: r.pack_id,
      networkId: r.network_id,
      upTo: r.up_to,
    }));
    for (const [networkId, told] of byNetwork(refs)) {
      await network(networkId).releaseClaims({
        networkId,
        repoId: repoId(),
        releases: told.map(({ packId, upTo }) => ({ packId, upTo })),
      });
      // Unless recorded again meanwhile, with a later bound (its row came back and went again).
      for (const { packId, upTo } of told)
        git.context.storage.sql.exec(
          "DELETE FROM claim_releases WHERE pack_id = ? AND up_to <= ?",
          packId,
          upTo,
        );
    }
  }
}

/** Records that `networkId` answered a share of the repository's at claim sequence `seq`. */
export function learnClaimSeq(git: RepoGitStorage, networkId: string, seq: number): void {
  git.context.storage.sql.exec(
    `INSERT INTO networks (network_id, recorded_at, claim_seq) VALUES (?, ?, ?)
     ON CONFLICT (network_id) DO UPDATE SET claim_seq = max(claim_seq, excluded.claim_seq)`,
    networkId,
    git.context.now(),
    seq,
  );
}

function byNetwork<T extends { readonly networkId: string }>(
  packs: readonly T[],
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const pack of packs) out.set(pack.networkId, [...(out.get(pack.networkId) ?? []), pack]);
  return out;
}
