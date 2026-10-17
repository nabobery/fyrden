import {
  createDoMemoryBudget,
  type GitStorageContext,
  isNetworkId,
  JobQueue,
} from "@fyrden/adapters-cloudflare/git";
import { createLogger, createMetrics, measureInvocation } from "@fyrden/adapters-cloudflare/obs";
import { createIdFactory, secureRandomBytes } from "@fyrden/domain";
import { deletionHandler } from "../network/deletion.js";
import { fenced, networkGcHandler, wakeGc } from "../network/gc.js";
import { type GcState, type Member, NetworkRegistry } from "../network/registry.js";
import {
  NETWORK_DEFAULTS,
  NETWORK_GC_JOB_ID,
  type NetworkHooks,
  type NetworkPolicy,
  type NetworkRuntime,
  scheduleDeletions,
  scheduleNetworkGc,
} from "../network/runtime.js";
import type { ForkExport, NetworkFailure, ViewPack } from "../network/types.js";
import { MigratingDO } from "./base/MigratingDO.js";
import { networkSchema } from "./schema/network.js";

/** Wall-clock budget for one alarm run of the network's jobs. Proposed. */
const ALARM_BUDGET_MS = 5_000;
/** The read lease a parent holds on its packs for a fork until the network records the claims. Proposed. */
const FORK_EXPORT_LEASE_MS = 10 * 60 * 1000;
/** Poll interval while fork creation waits for the collection's fence. */
const FENCE_POLL_MS = 50;

const allocateNetworkId = () => createIdFactory(Date.now, secureRandomBytes)("net");

export type BeginForkResult = { readonly ok: true; readonly export: ForkExport } | NetworkFailure;

/**
 * One fork network: its members, the packs they share and
 * which members claim them, the network collection with its fence against
 * fork creation and detach, and two-phase deletion of shared packs. Keyed
 * by the network id. It never serves reads or writes on the request path.
 */
export class NetworkDO extends MigratingDO {
  static readonly schema = networkSchema;

  /** Timings and budgets. Tests may replace them. */
  policy: NetworkPolicy = NETWORK_DEFAULTS;
  /** Pause points for tests. */
  hooks: NetworkHooks = {};

  readonly context: GitStorageContext;
  readonly registry: NetworkRegistry;
  readonly jobs: JobQueue;
  readonly #memory = createDoMemoryBudget(16 * 1024 * 1024);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.context = {
      storage: ctx.storage,
      now: () => Date.now(),
      metrics: createMetrics(env.METRICS),
      doClass: "NetworkDO",
    };
    this.registry = new NetworkRegistry(this.context);
    this.jobs = new JobQueue(this.context, (at) => {
      void ctx.storage.setAlarm(at);
    });
  }

  get runtime(): NetworkRuntime {
    return {
      env: this.env,
      context: this.context,
      registry: this.registry,
      jobs: this.jobs,
      policy: this.policy,
      hooks: this.hooks,
      log: createLogger({ do: "NetworkDO" }),
    };
  }

  #ensure(networkId: string): NetworkFailure | undefined {
    if (!isNetworkId(networkId)) return { ok: false, code: "not_found", error: "not a network id" };
    this.registry.ensure(networkId);
    return undefined;
  }

  /** Waits while a collection holds its fence; false when it still does after the policy's wait. */
  async #passFence(): Promise<boolean> {
    const deadline = this.context.now() + this.policy.fenceWaitMs;
    const runtime = this.runtime;
    while (fenced(runtime)) {
      if (this.context.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, FENCE_POLL_MS));
    }
    return true;
  }

  /**
   * Starts a fork of `parentRepoId`, behind
   * the collection's fence: the fork joins as `joining`; the parent exports
   * its branches, tags and live packs (read-leased for the fork); the packs
   * become shared, claimed by the parent and the fork. A network with no
   * members yet takes the parent as its root.
   */
  async beginFork(input: {
    networkId: string;
    parentRepoId: string;
    forkRepoId: string;
  }): Promise<BeginForkResult> {
    const bad = this.#ensure(input.networkId);
    if (bad) return bad;
    if (!(await this.#passFence()))
      return {
        ok: false,
        code: "network_busy",
        error: "The fork network is being collected; try again shortly.",
      };
    const { registry } = this;
    const joined = this.context.storage.transactionSync((): NetworkFailure | undefined => {
      if (registry.members().length === 0) registry.addMember(input.parentRepoId, null, "active");
      const parent = registry.member(input.parentRepoId);
      if (!parent)
        return { ok: false, code: "not_member", error: "The parent is not in this network." };
      if (parent.state !== "active")
        return {
          ok: false,
          code: "parent_detaching",
          error: "The parent is leaving its fork network.",
        };
      if (registry.member(input.forkRepoId))
        return { ok: false, code: "bad_state", error: "The fork already exists." };
      registry.addMember(input.forkRepoId, input.parentRepoId, "joining");
      return undefined;
    });
    if (joined) return joined;
    let exported: ForkExport;
    try {
      exported = await this.env.REPO.getByName(input.parentRepoId).exportForFork(
        `fork:${input.forkRepoId}`,
        FORK_EXPORT_LEASE_MS,
      );
    } catch (error) {
      this.#abandon(input.forkRepoId);
      return {
        ok: false,
        code: "export_failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    // A pack the network did not share yet was written by the parent (one
    // it borrowed is already known, with its writer). A pack whose deletion
    // has begun cannot be borrowed: the fork is not created.
    const shared = this.context.storage.transactionSync(() => {
      const ours = exported.packs.filter((p) => p.networkId === input.networkId);
      if (ours.some((p) => registry.deleting(p.packId))) return false;
      registry.share(ours, () => input.parentRepoId, [input.parentRepoId, input.forkRepoId]);
      return true;
    });
    if (!shared) {
      this.#abandon(input.forkRepoId);
      return {
        ok: false,
        code: "network_busy",
        error: "A pack of the repository is being deleted; try again shortly.",
      };
    }
    return { ok: true, export: exported };
  }

  /**
   * A pull request's base comes to read packs of its head's repository
   * (behind the collection's fence, as a fork's start): packs the network
   * does not share yet become shared, written by that repository, which
   * claims them; the base claims every one, at the network's next claim
   * sequence (`seq`, see `NetworkRegistry.renewClaims`). Both must be
   * active members. Answers the packs it could not claim (deleted, being
   * deleted, or of another network): the base reads none of them.
   */
  async sharePacks(input: {
    networkId: string;
    writerRepoId: string;
    claimantRepoId: string;
    packs: readonly ViewPack[];
  }): Promise<{ ok: true; gone: string[]; seq: number } | NetworkFailure> {
    const bad = this.#ensure(input.networkId);
    if (bad) return bad;
    if (!(await this.#passFence()))
      return {
        ok: false,
        code: "network_busy",
        error: "The fork network is being collected; try again shortly.",
      };
    const { registry } = this;
    return this.context.storage.transactionSync(() => {
      for (const id of [input.writerRepoId, input.claimantRepoId])
        if (registry.member(id)?.state !== "active")
          return {
            ok: false as const,
            code: "not_member" as const,
            error: "The repositories are not both in this network.",
          };
      const gone: string[] = [];
      const known = registry.known(input.packs.map((p) => p.packId));
      for (const pack of input.packs) {
        if (
          pack.networkId !== input.networkId ||
          registry.packState(pack.packId) === "deleted" ||
          registry.deleting(pack.packId)
        ) {
          gone.push(pack.packId);
          continue;
        }
        if (!known.has(pack.packId))
          registry.share([pack], () => input.writerRepoId, [input.writerRepoId]);
        else if (registry.packState(pack.packId) === "condemned") registry.reprieve(pack.packId);
      }
      const claimed = input.packs.map((p) => p.packId).filter((id) => !gone.includes(id));
      const seq = registry.renewClaims(input.claimantRepoId, claimed);
      return { ok: true as const, gone, seq };
    });
  }

  /** Records a pack the fork wrote to keep its view under the cap (shared base packs compacted), claimed by the fork. */
  recordCompaction(input: { networkId: string; forkRepoId: string; output: ViewPack }): void {
    this.registry.ensure(input.networkId);
    this.registry.share([input.output], () => input.forkRepoId, [input.forkRepoId]);
  }

  /**
   * The fork is published: it is a full member, and the network is
   * collected from now on (now, if a collection was waiting for it).
   */
  completeFork(input: { networkId: string; forkRepoId: string }): boolean {
    this.registry.ensure(input.networkId);
    const done = this.registry.setMemberState(input.forkRepoId, ["joining"], "active");
    const runtime = this.runtime;
    scheduleNetworkGc(runtime, this.context.now() + this.policy.gcIntervalMs);
    wakeGc(runtime);
    return done;
  }

  /** The fork was not created: it leaves the network with its claims. */
  abortFork(input: { networkId: string; forkRepoId: string }): void {
    this.registry.ensure(input.networkId);
    this.#abandon(input.forkRepoId);
  }

  #abandon(forkRepoId: string): void {
    const unclaimed = this.context.storage.transactionSync(() => {
      const left = this.registry.removeJoining(forkRepoId);
      this.registry.condemn(left, this.policy.retentionMs);
      return left;
    });
    if (unclaimed.length > 0) scheduleDeletions(this.runtime);
    wakeGc(this.runtime);
  }

  /**
   * `repoId` is deleted: it leaves the network with all its claims. Shared
   * packs nobody claims any more are condemned, then deleted as usual; its
   * forks keep the packs they claim.
   */
  removeMember(input: { networkId: string; repoId: string }): void {
    // A network never forked has nothing to record.
    if (this.registry.networkId() === undefined) return;
    if (this.#ensure(input.networkId)) return;
    const unclaimed = this.context.storage.transactionSync(() => {
      const left = this.registry.removeMember(input.repoId);
      this.registry.condemn(left, this.policy.retentionMs);
      return left;
    });
    if (unclaimed.length > 0) scheduleDeletions(this.runtime);
    // It may have been the fork a collection waits for.
    wakeGc(this.runtime);
  }

  /** Of `packIds`, the ones the network knows: their bytes are the network's to delete. */
  sharedPacks(packIds: readonly string[]): string[] {
    return [...this.registry.known(packIds)];
  }

  /**
   * `repoId`'s view no longer holds the packs of `releases`: its claims on
   * them go, each unless made again after the release's `upTo` (see
   * `NetworkRegistry.releaseUpTo`), so a release told late or twice is
   * harmless. Shared packs nobody claims any more are condemned (and
   * deleted after acknowledgements, leases and the retention).
   */
  releaseClaims(input: {
    networkId: string;
    repoId: string;
    releases: readonly { packId: string; upTo: number }[];
  }): void {
    if (this.#ensure(input.networkId)) return;
    const unclaimed = this.context.storage.transactionSync(() => {
      const left = this.registry.releaseUpTo(input.repoId, input.releases);
      this.registry.condemn(left, this.policy.retentionMs);
      return left;
    });
    if (unclaimed.length > 0) scheduleDeletions(this.runtime);
  }

  /**
   * `repoId`'s view holds `packIds` (a restored member re-claiming its
   * packs): pending deletions of them are dropped. Returns the
   * ones that are gone: deleted, or being deleted (past the deletion fence;
   * those are not claimed).
   */
  claim(input: { networkId: string; repoId: string; packIds: readonly string[] }): string[] {
    if (this.#ensure(input.networkId)) return [];
    return this.context.storage.transactionSync(() => {
      const gone: string[] = [];
      for (const packId of input.packIds) {
        const state = this.registry.packState(packId);
        if (state === "deleted" || this.registry.deleting(packId)) gone.push(packId);
        else if (state === "condemned") this.registry.reprieve(packId);
      }
      this.registry.claim(
        [input.repoId],
        input.packIds.filter((id) => !gone.includes(id)),
      );
      return gone;
    });
  }

  /**
   * Whether `repoId` may sweep the network's pack prefix on its own: no
   * other member, and no shared pack whose bytes are not deleted (a shared
   * pack may be in no registry but the network's).
   */
  isSoleMember(repoId: string): boolean {
    const members = this.registry.members();
    if (members.some((m) => m.repoId !== repoId)) return false;
    return !this.registry.hasLivePacks();
  }

  /**
   * Starts detaching `repoId`: behind the collection's
   * fence it becomes `detaching` (no fork of it is created from now on), a
   * new network id is allocated, and the repository starts its closure
   * rewrite into the new network.
   */
  async detach(input: {
    networkId: string;
    repoId: string;
  }): Promise<{ ok: true; newNetworkId: string } | NetworkFailure> {
    const bad = this.#ensure(input.networkId);
    if (bad) return bad;
    if (!(await this.#passFence()))
      return { ok: false, code: "network_busy", error: "The fork network is being collected." };
    const moved = this.context.storage.transactionSync(() => {
      if (this.registry.members().length === 0)
        this.registry.addMember(input.repoId, null, "active");
      return this.registry.setMemberState(input.repoId, ["active"], "detaching");
    });
    if (!moved)
      return { ok: false, code: "bad_state", error: "The repository is not an active member." };
    const newNetworkId = allocateNetworkId();
    const begun = await this.env.REPO.getByName(input.repoId).beginDetach(newNetworkId);
    if (!begun.ok) {
      this.registry.setMemberState(input.repoId, ["detaching"], "active");
      return { ok: false, code: "bad_state", error: begun.error };
    }
    return { ok: true, newNetworkId };
  }

  /** The detach swapped: the repository reads nothing of this network once its claims are released. */
  completeDetach(input: { networkId: string; repoId: string }): void {
    this.registry.ensure(input.networkId);
    this.registry.setMemberState(input.repoId, ["detaching"], "detached");
  }

  /** Records `repoId` as the root of a network created for it (a detached repository's new network). */
  registerRoot(input: { networkId: string; repoId: string }): void {
    this.registry.ensure(input.networkId);
    if (!this.registry.member(input.repoId)) this.registry.addMember(input.repoId, null, "active");
  }

  /** Starts a network collection now (or keeps the one in progress). */
  startGc(): void {
    this.jobs.ensure("network_gc", NETWORK_GC_JOB_ID, { runAt: this.context.now() });
  }

  /** Where the network stands, for operators and tests. */
  status(): {
    networkId: string | undefined;
    membershipVersion: number;
    members: Member[];
    gc: GcState;
    packs: { packId: string; state: string; claims: string[] }[];
    deletions: ReturnType<NetworkRegistry["deletions"]>;
  } {
    const packs = this.context.storage.sql
      .exec<{ pack_id: string; state: string }>(
        "SELECT pack_id, state FROM network_packs ORDER BY pack_id",
      )
      .toArray()
      .map((r) => ({
        packId: r.pack_id,
        state: r.state,
        claims: this.registry.claimants(r.pack_id),
      }));
    return {
      networkId: this.registry.networkId(),
      membershipVersion: this.registry.membershipVersion(),
      members: this.registry.members(),
      gc: this.registry.gcState(),
      packs,
      deletions: this.registry.deletions(),
    };
  }

  /**
   * Runs the network's due jobs as a measured invocation: the job queue
   * starts no slice once its calls near the invocation's budget.
   */
  override async alarm(): Promise<void> {
    const runtime = this.runtime;
    await measureInvocation(
      this.context.metrics,
      { where: "do", op: "alarm", doClass: "NetworkDO" },
      () =>
        this.jobs.runDue(
          { network_gc: networkGcHandler(runtime), network_delete: deletionHandler(runtime) },
          this.#memory,
          this.context.now() + ALARM_BUDGET_MS,
        ),
    );
  }
}
