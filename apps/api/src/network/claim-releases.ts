import type {
  NetworkPackRef,
  NetworkRetire,
  ReleaseDelivery,
  RepoGitStorage,
} from "@fyrden/adapters-cloudflare/git";
import type { Logger } from "@fyrden/adapters-cloudflare/obs";
import { ImportBusy } from "./pull-import.js";

/*
 * A repository's claims on its fork network's packs, given up as its retire
 * job drops their rows, and told to the network in order with the claims it
 * makes again (a pull request's import shares packs).
 *
 * A release is recorded in the transaction that deletes the pack's row and
 * kept until the network has answered it: one the network could not be
 * told (the call failed, or the object was reset first) is told on a later
 * pass of the retire job, so no claim outlives its row for long, even where
 * no collection of the network runs (a network down to one member).
 *
 * Calls to the network through different stubs arrive in no set order
 * (https://developers.cloudflare.com/durable-objects/api/stub/, verified),
 * so a release on its way could land after a later claim of the same pack
 * and remove it. A claim is therefore refused while the release of one of
 * its packs is on its way (the import tries again later); it tells those
 * recorded first, and is sent in the same synchronous step that found none
 * left. A release recorded after that is of a row the claim's caller saw
 * (see `claimAgain`). Calls an earlier instance of the object made (reset
 * while one was on its way) are not tracked: the network is taken to have
 * answered or dropped those before the next instance's calls arrive.
 */

/** Pause points for tests. */
export interface ClaimReleaseHooks {
  /** Before releases of `packIds` are sent (they are on their way from here on). */
  beforeRelease?: (packIds: readonly string[]) => Promise<void> | void;
}

export interface ClaimReleaseDeps {
  readonly env: Env;
  readonly git: RepoGitStorage;
  readonly repoId: () => string;
  readonly log: () => Logger;
  readonly hooks: () => ClaimReleaseHooks;
}

/** A claim refused while the release of one of its packs is on its way: the import tries again later. */
export class ReleaseUnderWay extends ImportBusy {
  override name = "ReleaseUnderWay";

  constructor() {
    super("a release of the base's claim on a pack is on its way; try again shortly");
  }
}

type Recorded = { pack_id: string; network_id: string };

/** Rounds of releases a claim tells before it is refused for now (each a call per network). */
const MAX_ROUNDS = 3;

export class ClaimReleases implements NetworkRetire {
  /** Packs whose release is on its way to the network. */
  readonly #sending = new Set<string>();

  constructor(private readonly deps: ClaimReleaseDeps) {}

  async shared(packs: readonly NetworkPackRef[]): Promise<ReadonlySet<string>> {
    const out = new Set<string>();
    for (const [networkId, ids] of byNetwork(packs))
      for (const id of await this.deps.env.NETWORK.getByName(networkId).sharedPacks(ids))
        out.add(id);
    return out;
  }

  release(pack: NetworkPackRef): void {
    this.deps.git.context.storage.sql.exec(
      `INSERT INTO claim_releases (pack_id, network_id) VALUES (?, ?)
       ON CONFLICT (pack_id) DO NOTHING`,
      pack.packId,
      pack.networkId,
    );
  }

  async deliver(max: number): Promise<ReleaseDelivery> {
    const due = this.#recorded(null, max + 1);
    try {
      await this.#tell(due.slice(0, max));
    } catch (error) {
      this.deps.log().warn("telling the network of released claims failed", { error });
      return "failed";
    }
    // Others on their way (a claim tells them) are looked at again: that call may fail.
    return due.length > max || this.#sending.size > 0 ? "more" : "done";
  }

  /**
   * Runs `claim`, a call that claims `packIds` for this repository again,
   * once no release of them is recorded or on its way: refused
   * (`ReleaseUnderWay`) while one is on its way, else the recorded ones are
   * told first (failing, `claim` is not run). `claim` starts in the same
   * synchronous step that found none, so the rows it reads first are those
   * of packs whose claims stand: one whose row is gone has had its release
   * answered, and one whose row goes later is released after the claim
   * lands (the caller claims it again then). Each call made here counts
   * against `budget`.
   */
  async claimAgain<T>(
    packIds: readonly string[],
    budget: { used: number },
    claim: () => Promise<T>,
  ): Promise<T> {
    // A round after the first tells those recorded while the one before was on its way.
    for (let round = 0; ; round++) {
      if (packIds.some((id) => this.#sending.has(id))) throw new ReleaseUnderWay();
      const due = this.#recorded(packIds);
      if (due.length === 0) return claim();
      if (round === MAX_ROUNDS) throw new ReleaseUnderWay();
      budget.used += new Set(due.map((r) => r.network_id)).size;
      await this.#tell(due);
    }
  }

  /** Releases recorded and not on their way (of `packIds`, or any), in pack order, at most `limit`. */
  #recorded(packIds: readonly string[] | null, limit = Number.MAX_SAFE_INTEGER): Recorded[] {
    const only = packIds === null ? null : JSON.stringify(packIds);
    return this.deps.git.context.storage.sql
      .exec<Recorded>(
        `SELECT pack_id, network_id FROM claim_releases
         WHERE (? IS NULL OR pack_id IN (SELECT value FROM json_each(?)))
           AND pack_id NOT IN (SELECT value FROM json_each(?))
         ORDER BY pack_id LIMIT ?`,
        only,
        only,
        JSON.stringify([...this.#sending]),
        limit,
      )
      .toArray();
  }

  /** Tells the network of `releases`, one call per network; each answered is forgotten. */
  async #tell(releases: readonly Recorded[]): Promise<void> {
    if (releases.length === 0) return;
    const { env, git, repoId, hooks } = this.deps;
    const ids = releases.map((r) => r.pack_id);
    for (const id of ids) this.#sending.add(id);
    try {
      await hooks().beforeRelease?.(ids);
      const refs = releases.map((r) => ({ packId: r.pack_id, networkId: r.network_id }));
      for (const [networkId, packIds] of byNetwork(refs)) {
        await env.NETWORK.getByName(networkId).releaseClaims({
          networkId,
          repoId: repoId(),
          packIds,
        });
        git.context.storage.sql.exec(
          "DELETE FROM claim_releases WHERE pack_id IN (SELECT value FROM json_each(?))",
          JSON.stringify(packIds),
        );
      }
    } finally {
      for (const id of ids) this.#sending.delete(id);
    }
  }
}

function byNetwork(
  packs: readonly { readonly packId: string; readonly networkId: string }[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const pack of packs)
    out.set(pack.networkId, [...(out.get(pack.networkId) ?? []), pack.packId]);
  return out;
}
