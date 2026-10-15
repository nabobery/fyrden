import { createLogger, type Metrics } from "@fyrden/adapters-cloudflare/obs";
import type { RepoDO } from "../do/RepoDO.js";
import { allocateEpoch } from "../events/epochs.js";
import { DEFAULT_ORG_SHARD } from "../events/read-model.js";
import type { RewriteState } from "../git/maintenance/rewrite.js";
import { packCapPolicy } from "../git/maintenance/tail-merge-plan.js";
import { advanceDeletion } from "../repos/deletion.js";
import {
  agentRepoQuotaError,
  defaultBranchOf,
  forgetResolved,
  heldBack,
  type NewRepoRow,
  newRepoStatements,
  type RepoEntry,
} from "../repos/directory.js";
import { clock, newId } from "../services.js";
import type { ForkExport, NetworkFailure, ViewPack } from "./types.js";
import { chooseBaseCompaction, VIEW_CAP } from "./view-cap.js";

/*
 * Fork creation, driven from the Worker. No pack byte is
 * copied: the fork borrows the parent's live packs.
 *
 * 1. The network object starts the fork behind the collection's fence: the
 *    fork joins, the parent exports its branches, tags and live packs
 *    (read-leased for the fork), and the network records the packs as
 *    shared, claimed by both.
 * 2. The fork's object takes the network, HEAD and the borrowed packs.
 * 3. The parent's verified commit-graph rows for the closure of the
 *    exported refs are copied, so negotiation, connectivity, merge-base and
 *    object authorization work from the fork's first request. The fork's
 *    object pulls them from the parent's page by page, in bounded steps:
 *    each step is one call from here and one invocation of the fork's
 *    object, within a budget of calls to the parent, and hands back the
 *    frontier the next step starts from. The calls this request makes grow
 *    with the history only by one per step, and no invocation of either
 *    object runs past its budget.
 * 4. If the borrowed packs would leave too little room under the view cap
 *    (a fork of a fork), the oldest are compacted into one shared pack
 *    first (view-cap.ts). This is the only case that writes pack bytes.
 * 5. The refs are set, the fork becomes a full member, the parent's lease
 *    is released, and only then is the directory row written: the fork is
 *    published (visible and cloneable) only when all of the above is done.
 *
 * A failure at any step leaves no directory row; the network drops the
 * joining fork and its claims (or the collection does, after a while).
 */

/** Commit rows per page of the graph copy. Proposed. */
const COMMIT_PAGE = 2_000;
/**
 * Pages (calls to the parent's object) one step of the graph copy makes.
 * Proposed: well inside the 1,000 calls to internal services an invocation
 * may make on Free (measured on Workers Free, 2026-10-10).
 */
const COPY_CALLS = 400;
/** Wall time after which a copy step starts no new page. Proposed: inside 30 s of CPU per invocation. */
const COPY_STEP_MS = 10_000;

export interface ForkRequest {
  readonly parent: RepoEntry;
  readonly ownerId: string;
  readonly ownerHandle: string;
  readonly name: string;
  /** When the fork is deleted (Unix ms); null to keep it. */
  readonly expiresAt?: number | null;
  /** The owner's repository quota, checked again as the fork is published. */
  readonly maxRepos: number;
  readonly requestId?: string;
  readonly metrics?: Metrics;
  /** Who forks it, when not the owner itself: an agent acting for it (its audit row names the chain). */
  readonly actorId?: string;
  readonly act?: readonly string[];
  readonly grantId?: string;
  /** The agent forking it for its owner, and that agent's limit, checked again as it is published. */
  readonly createdBy?: NewRepoRow["createdBy"];
}

export interface ForkOptions {
  /** Packs in a full view. Default `VIEW_CAP` (Proposed 32). */
  readonly viewCap?: number;
  /** Own packs a repository may have (the pack-count cap). Default from the Worker's variables. */
  readonly ownCap?: number;
  readonly pageSize?: number;
  /** Pages one step of the graph copy may fetch. Default `COPY_CALLS` (Proposed 400). */
  readonly copyCalls?: number;
  /** Pause points. For tests. */
  readonly hooks?: {
    readonly afterCopyStep?: (
      step: { readonly step: number; readonly pages: number; readonly copied: number },
      forkId: string,
    ) => Promise<void> | void;
  };
}

export type ForkResult =
  | {
      readonly ok: true;
      readonly repo: RepoEntry;
      /** The branch the fork's HEAD names (the parent's HEAD when it was exported). */
      readonly defaultBranch: string;
      /** From the request's start until the directory row was written. */
      readonly publishMs: number;
      readonly commitsCopied: number;
      /** Borrowed packs compacted to keep the view under the cap (0 for most forks). */
      readonly packsCompacted: number;
    }
  | {
      readonly ok: false;
      readonly status: 409 | 404 | 403;
      readonly code: string;
      readonly error: string;
    };

export async function forkRepository(
  env: Env,
  request: ForkRequest,
  options: ForkOptions = {},
): Promise<ForkResult> {
  const started = clock();
  const log = createLogger({ op: "repos.fork", parentId: request.parent.id });
  const { parent } = request;
  const networkId = parent.networkId;
  const forkId = newId("rep");
  const network = env.NETWORK.getByName(networkId);
  const fork = env.REPO.getByName(forkId);
  const parentStub = env.REPO.getByName(parent.id);

  const begun = await network.beginFork({ networkId, parentRepoId: parent.id, forkRepoId: forkId });
  if (!begun.ok) return refusal(begun);
  const exported: ForkExport = begun.export;
  let commitsCopied = 0;
  let packsCompacted = 0;
  try {
    const epochGen = await allocateEpoch(env.DIRECTORY, forkId, request.metrics);
    await fork.initFork(
      { networkId, head: exported.head, packs: exported.packs },
      {
        ownerId: request.ownerId,
        name: request.name,
        visibility: parent.visibility,
        epochGen,
        actor: request.actorId ?? request.ownerId,
      },
    );

    let frontier = exported.tips.map(hex);
    for (let step = 1; frontier.length > 0; step++) {
      const next = await fork.copyForkGraph({
        parentId: parent.id,
        frontier,
        pageSize: options.pageSize ?? COMMIT_PAGE,
        maxCalls: options.copyCalls ?? COPY_CALLS,
        budgetMs: COPY_STEP_MS,
      });
      commitsCopied += next.copied;
      frontier = next.frontier;
      await options.hooks?.afterCopyStep?.(
        { step, pages: next.pages, copied: next.copied },
        forkId,
      );
    }

    const ownCap = options.ownCap ?? packCapPolicy(env).cap;
    // At least one borrowed pack, even if the own-pack cap was raised to the view cap.
    const limit = Math.max(1, (options.viewCap ?? VIEW_CAP) - ownCap);
    const chosen = chooseBaseCompaction(exported.packs, limit);
    if (chosen.length > 0) {
      const output = await compactBase(
        fork,
        chosen.map((p) => p.packId),
      );
      await network.recordCompaction({ networkId, forkRepoId: forkId, output });
      packsCompacted = chosen.length;
    }

    await fork.finishFork(exported.refs, {
      principal: request.ownerId,
      ...(request.act && { actChain: request.act }),
      ...(request.grantId && { grantId: request.grantId }),
      requestId: request.requestId ?? null,
      via: "api",
    });
    if (!(await network.completeFork({ networkId, forkRepoId: forkId })))
      throw new Error("the fork is no longer joining its network");
  } catch (error) {
    log.error("fork creation failed", { forkId, error });
    await network.abortFork({ networkId, forkRepoId: forkId }).catch(() => {});
    throw error;
  } finally {
    if (exported.leaseId) await parentStub.releaseFetchLease(exported.leaseId).catch(() => {});
  }

  // Published: the directory row is the last write. Held back (a create
  // took the name or the quota's last slot meanwhile), the same batch hands
  // the fork to the deletion instead, so it never stays a member unpublished.
  const now = clock();
  const row = {
    id: forkId,
    ownerId: request.ownerId,
    name: request.name,
    networkId,
    orgShard: DEFAULT_ORG_SHARD,
    visibility: parent.visibility,
    parentId: parent.id,
    expiresAt: request.expiresAt ?? null,
    now,
    createdBy: request.createdBy ?? null,
  };
  request.metrics?.count("d1.query", { db: "directory", op: "repo_create" }, 6);
  const refused = heldBack(
    await env.DIRECTORY.batch([
      ...newRepoStatements(
        env.DIRECTORY,
        row,
        {
          actorId: request.actorId ?? request.ownerId,
          ...(request.requestId ? { requestId: request.requestId } : {}),
          action: "repo.fork",
          details: { name: request.name, parent_id: parent.id, network_id: networkId },
          ...(request.act && { act: request.act }),
        },
        request.maxRepos,
      ),
      ...discardStatements(env.DIRECTORY, row),
    ]),
    request.createdBy?.maxRepos,
  );
  if (refused) {
    await advanceDeletion(env, forkId, request.metrics ? { metrics: request.metrics } : {}).catch(
      () => "deleting",
    );
    if (refused === "agent_quota_exceeded") {
      const { message } = agentRepoQuotaError(request.createdBy?.maxRepos ?? 0);
      return { ok: false, status: 403, code: "quota_exceeded", error: message };
    }
    return refused === "name_taken"
      ? { ok: false, status: 409, code: "name_taken", error: nameTaken(request.name) }
      : {
          ok: false,
          status: 403,
          code: "quota_exceeded",
          error: `You have ${request.maxRepos} repositories, as many as your quota allows; delete one first.`,
        };
  }
  // The name may have redirected to another repository here.
  forgetResolved(request.ownerHandle, request.name);
  const publishMs = clock() - started;
  log.info("fork published", { forkId, publishMs, commitsCopied, packsCompacted });
  return {
    ok: true,
    repo: {
      id: forkId,
      ownerId: request.ownerId,
      ownerHandle: request.ownerHandle,
      name: request.name,
      networkId,
      visibility: parent.visibility,
      createdAt: now,
      nameGen: 0,
      parentId: parent.id,
      isTemplate: false,
      expiresAt: request.expiresAt ?? null,
    },
    defaultBranch: defaultBranchOf(exported.head),
    publishMs,
    commitsCopied,
    packsCompacted,
  };
}

/**
 * For a fork whose publication the batch held back: a directory row
 * already being deleted (named by its id, so it takes no name and counts
 * against no quota) and its deletion, so the ordinary deletion erases the
 * fork's object and removes it from the network. Nothing when the fork was
 * published.
 */
function discardStatements(db: D1Database, fork: NewRepoRow): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO repos (id, owner_id, name, network_id, org_shard, visibility, parent_id,
           state, created_at, updated_at)
         SELECT ?1, ?2, ?1, ?3, ?4, ?5, ?6, 'deleting', ?7, ?7
         WHERE NOT EXISTS (SELECT 1 FROM repos WHERE id = ?1)`,
      )
      .bind(
        fork.id,
        fork.ownerId,
        fork.networkId,
        fork.orgShard,
        fork.visibility,
        fork.parentId,
        fork.now,
      ),
    db
      .prepare(
        `INSERT INTO repo_deletions (repo_id, step, attempts, updated_at, requested_by)
         SELECT id, 'prepare', 0, ?2, NULL FROM repos WHERE id = ?1 AND state = 'deleting'
         ON CONFLICT (repo_id) DO NOTHING`,
      )
      .bind(fork.id, fork.now),
  ];
}

/** Compacts `sources` (borrowed packs of the fork) into one pack, slice by slice; swaps it in. */
async function compactBase(
  fork: DurableObjectStub<RepoDO>,
  sources: readonly string[],
): Promise<ViewPack> {
  let runId: string | undefined;
  let state: RewriteState | undefined;
  for (;;) {
    const slice = await fork.compactViewSlice({
      sources,
      ...(runId ? { runId } : {}),
      ...(state ? { state } : {}),
    });
    runId = slice.runId;
    if (slice.outcome.done) return fork.swapCompactedView(slice.outcome.packId, sources);
    state = slice.outcome.state;
  }
}

const nameTaken = (name: string) => `You already have a repository named ${name}.`;

function refusal(failure: NetworkFailure): ForkResult {
  switch (failure.code) {
    case "not_member":
    case "not_found":
      return { ok: false, status: 404, code: "repo_not_found", error: failure.error };
    case "export_failed":
      // The parent could not export (a server fault), not a conflict the caller can fix.
      throw new Error(`fork export failed: ${failure.error}`);
    default:
      return { ok: false, status: 409, code: failure.code, error: failure.error };
  }
}

const hex = (oid: Uint8Array) => Array.from(oid, (b) => b.toString(16).padStart(2, "0")).join("");
