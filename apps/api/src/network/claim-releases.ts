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
 * share claims the head's packs for the base) and after a restore.
 *
 * The network answers claim sequences that only grow, across a
 * point-in-time recovery of its object too (they follow its clock, see
 * `CLAIM_SEQS_PER_MS`), and the repository keeps the latest it has learnt
 * of each network (`networks.claim_seq`). A release is recorded in the
 * transaction that deletes the pack's row, bounded by that latest sequence
 * (`up_to`), so by one the network answered before the release was
 * recorded, and the network drops the claim only if it was made at the
 * bound or before. Releases do land late: calls through different stubs
 * arrive in no set order
 * (https://developers.cloudflare.com/durable-objects/api/stub/, verified),
 * a replaced instance may still be sending one after its successor told
 * the same release (https://developers.cloudflare.com/durable-objects/platform/known-issues/#global-uniqueness,
 * verified), and one that failed for the caller may still have reached the
 * network.
 *
 * None of them removes a claim a row relies on. While a row stays, the
 * repository records no release of it; a row comes (back) after the
 * repository released the pack in only two ways, and either way its claim
 * is made at a sequence the network answered after every such release was
 * recorded, so newer than their bounds:
 * - adopted after a share: the share's sequence is answered after the
 *   share was sent. A release recorded after it was sent may bound it, so
 *   the same transaction counts the release (`networks.released`): an
 *   import adopts the packs it shared only while the count is the one it
 *   read as it sent the share, and shares them again otherwise (see
 *   `releasesSoFar`).
 * - restored with the repository: a point-in-time restore brings back rows
 *   whose releases were recorded, and maybe told, after the restore point.
 *   Taking the new restore generation queues a job that claims every pack
 *   the rows hold again (reclaim.ts), at a sequence answered after the
 *   restore. Until it has run (normally on the next alarm; a network it
 *   cannot reach is asked again later) such a row may have no claim: the
 *   retention keeps its bytes for 30 days from its condemnation, which came
 *   after the restore point.
 * The network's questions of a member also claim a pack its view holds,
 * should its claim be gone (lost with a recovery of the network's object,
 * or a restored member not claimed again yet): a collection's (what its
 * view holds) and a deletion's (refused, as its view holds the pack). They
 * do so at a sequence answered before the question and learnt by the
 * member as it reads its rows, so a release recorded after that read
 * covers the claim, and one recorded before it bounds the claim of a row
 * that came back since only as above. (A member restored while a question
 * to it is on its way may answer with an older sequence: the reclaim job,
 * queued after the restore, covers that.) The other claims are made at
 * sequence 0, leaving one made already as it is, and no release by their
 * claimant can name the pack yet: a fork's (a new repository), the
 * writer's of a pack the network learns of only now (the retire job
 * releases only packs the network knows), a view compaction's of the pack
 * it wrote.
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
    recordRelease(this.deps.git, pack);
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

/**
 * In the transaction that deletes the repository's row of `pack` (or finds
 * it gone): records the release of its claim on it, bounded by the latest
 * claim sequence learnt of its network, and counts it (see `releasesSoFar`).
 */
export function recordRelease(
  git: RepoGitStorage,
  pack: { readonly packId: string; readonly networkId: string },
): void {
  const { context } = git;
  // Bounded by the latest sequence learnt; one recorded already and not told yet takes it.
  context.storage.sql.exec(
    `INSERT INTO claim_releases (pack_id, network_id, up_to)
     VALUES (?1, ?2, coalesce((SELECT claim_seq FROM networks WHERE network_id = ?2), 0))
     ON CONFLICT (pack_id) DO UPDATE SET up_to = max(up_to, excluded.up_to)`,
    pack.packId,
    pack.networkId,
  );
  context.storage.sql.exec(
    `INSERT INTO networks (network_id, recorded_at, released) VALUES (?, ?, 1)
     ON CONFLICT (network_id) DO UPDATE SET released = released + 1`,
    pack.networkId,
    context.now(),
  );
}

/**
 * How many claims the repository has given up in `networkId` so far: an
 * import reads it as it sends its share, and shares again when it differs
 * by adoption.
 */
export function releasesSoFar(git: RepoGitStorage, networkId: string): number {
  return (
    git.context.storage.sql
      .exec<{ released: number }>("SELECT released FROM networks WHERE network_id = ?", networkId)
      .toArray()[0]?.released ?? 0
  );
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
