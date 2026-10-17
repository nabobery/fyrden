import { createWorkersZlib } from "@fyrden/adapters-cloudflare";
import {
  DEFAULT_PART_BYTES,
  type PackRow,
  packObjectKey,
  type RepoGitStorage,
} from "@fyrden/adapters-cloudflare/git";
import { createLogger } from "@fyrden/adapters-cloudflare/obs";
import {
  type BlockCache,
  createReadStats,
  type FetchPlan,
  type FetchResponsePart,
  type MaterialisedPackStore,
  type MemoryReservation,
  type PackId,
  PackIdx,
  type PackStore,
  planFetch,
  UploadPackError,
  type VerbatimCandidate,
  type ViewPack,
} from "@fyrden/git-core";
import { openRequestBlockCache, type PackBlockStats } from "../cache/pack-blocks.js";
import type { FetchPlanReply, FetchPlanRequest, WirePart, WorkersPlan } from "./wire.js";

/**
 * Read leases on the packs a response streams from. The Worker renews them
 * while it streams and releases them at the end; a lease that is not
 * renewed expires, so a Worker that dies cannot pin a pack. Proposed;
 * tuned under load.
 */
export const FETCH_LEASE_TTL_MS = 10 * 60 * 1000;

/**
 * Cache API calls one plan may make for pack blocks. Free allows 50 per
 * request, shared with outbound fetches; Paid allows 1,000 (verified,
 * developers.cloudflare.com/workers/platform/limits/). Proposed.
 */
const CACHE_API_CALLS: Record<WorkersPlan, number> = { free: 40, paid: 500 };

export interface FetchPlanDeps {
  readonly git: RepoGitStorage;
  /** The object's long-lived in-memory block tier. */
  readonly memoryBlocks: BlockCache;
}

interface Counters {
  r2: number;
  cacheApi: number;
}

/**
 * Plans one protocol v2 `fetch` inside the repository object: validates wants against the current refs, negotiates over the
 * verified commit graph, and returns the response as small literal
 * buffers plus references to stored bytes, which the Worker streams. Any
 * pack it has to build (a regenerated pack, or a side-band framed copy on
 * Free) is written to R2 before it returns; pack bytes never travel in the
 * reply. The live packs are leased while planning, and the stored objects
 * the reply names stay leased for the Worker until it releases them.
 */
export async function planFetchInRepo(
  deps: FetchPlanDeps,
  request: FetchPlanRequest,
): Promise<FetchPlanReply> {
  const { git } = deps;
  const calls: Counters = { r2: 0, cacheApi: 0 };
  // The live packs and the refs, read together before any await, so the
  // refs never name objects outside the view.
  const live = git.registry.liveForFetch();
  const refs = git.refStore.readRefsSync();
  const holder = `fetch:${request.holder.slice(0, 100)}`;
  const planning =
    live.length > 0
      ? git.leases.grant(
          "read",
          live.map((p) => p.packId),
          holder,
          FETCH_LEASE_TTL_MS,
        )
      : undefined;
  if (planning && !planning.ok) return { ok: false, message: changedMessage, calls };

  const reservations: MemoryReservation[] = [];
  // Pack blocks are cached per network: this repository's network only,
  // reached only after the Worker authorized the request on it.
  const scope = git.networkId();
  const blocks = await openRequestBlockCache(deps.memoryBlocks, {
    scope,
    maxCalls: CACHE_API_CALLS[request.plan],
  });
  const blockStats: { -readonly [K in keyof PackBlockStats]: PackBlockStats[K] } = blocks.stats();
  try {
    const { view, candidates } = await fetchView(git, live, calls, reservations);
    let plan: FetchPlan;
    try {
      plan = await planFetch(
        {
          refs,
          commitGraph: git.commitGraph,
          view: { scope, packs: view },
          packStore: countingStore(git.packStore, calls),
          zlib: createWorkersZlib(),
          memory: git.memory,
          blockCache: blocks.cache,
          verbatim: candidates,
          materialised: countingMaterialised(git.fetchObjects, calls),
          cacheIdentity: {
            repoId: request.repoId,
            // Live packs change only with a ref-store commit, which bumps
            // the ref version, so the ref version also versions the registry.
            registryVersion: refs.version,
          },
        },
        request.args,
        { framing: request.plan === "paid" ? "transport" : "stored", stats: createReadStats() },
      );
    } catch (error) {
      if (error instanceof UploadPackError) {
        return { ok: false, message: error.message, calls, blocks: blockStats };
      }
      throw error;
    }

    let lease: { leaseId: string; expiresAt: number } | undefined;
    if (plan.leasePacks.length > 0) {
      const granted = git.leases.grant("read", plan.leasePacks, holder, FETCH_LEASE_TTL_MS);
      if (!granted.ok) return { ok: false, message: changedMessage, calls, blocks: blockStats };
      lease = { leaseId: granted.leaseId, expiresAt: granted.expiresAt };
    }
    const parts = plan.parts.map((part) => wirePart(git, part));
    const pack = plan.pack;
    return {
      ok: true,
      parts,
      kind: pack ? (request.args.haves.length > 0 ? "fetch" : "clone") : "negotiate",
      pack: pack?.kind ?? "none",
      cached: pack?.cached ?? false,
      ...(lease ? { lease } : {}),
      calls,
      blocks: blockStats,
    };
  } finally {
    for (const reservation of reservations) reservation.release();
    if (planning?.ok) git.leases.release(planning.leaseId);
    // The replies above hold these objects; fill them with the final counts.
    Object.assign(blockStats, blocks.stats());
    calls.cacheApi += blockStats.sharedCalls;
  }
}

/**
 * `planFetchInRepo` for the object's RPC method: any failure other than a
 * refusal is logged here and answered with a generic `ERR`, so the error
 * never crosses the RPC boundary and the client always gets a message.
 */
export async function answerFetchPlan(
  deps: FetchPlanDeps,
  request: FetchPlanRequest,
): Promise<FetchPlanReply> {
  try {
    return await planFetchInRepo(deps, request);
  } catch (error) {
    createLogger({ do: "RepoDO" }).error("fetch plan failed", { error });
    return {
      ok: false,
      message: "upload-pack: the server could not plan this fetch",
      calls: { r2: 0, cacheApi: 0 },
    };
  }
}

const changedMessage =
  "upload-pack: the repository's packs changed while this fetch was planned; try again";

/**
 * The live packs as a reader view, newest first. Each `.idx` is read whole
 * with one GET on first use (a ranged index costs several reads per lookup,
 * and a regenerated pack looks up every object it sends), under a memory
 * reservation held until the plan returns.
 */
async function fetchView(
  git: RepoGitStorage,
  live: readonly (PackRow & { objectCount: number | null; allReachable: boolean })[],
  calls: Counters,
  reservations: MemoryReservation[],
): Promise<{ view: ViewPack[]; candidates: VerbatimCandidate[] }> {
  const view: ViewPack[] = [];
  const candidates: VerbatimCandidate[] = [];
  for (const row of live) {
    if (row.bytes === null) throw new Error(`live pack ${row.packId} has no length`);
    let loading: Promise<PackIdx> | undefined;
    const idx = () => {
      loading ??= loadIdx(git, row, calls, reservations);
      return loading;
    };
    view.push({
      packId: row.packId,
      bytes: row.bytes,
      idx: {
        lookup: async (oid, at) => (await idx()).lookup(oid, at),
        crc32At: async (position) => (await idx()).crc32At(position),
      },
    });
    candidates.push({
      packId: row.packId,
      objectCount: row.objectCount ?? (await idx()).count,
      allReachable: row.allReachable,
      oidTable: async () => (await idx()).oidTable(),
    });
  }
  return { view, candidates };
}

async function loadIdx(
  git: RepoGitStorage,
  row: PackRow,
  calls: Counters,
  reservations: MemoryReservation[],
): Promise<PackIdx> {
  calls.r2++;
  git.context.metrics.count("r2.class_b", { bucket: "fyrden-git", op: "get_idx" });
  const object = await git.bucket.get(packObjectKey(row.networkId, row.packId, "idx"));
  if (!object) throw new Error(`the index of pack ${row.packId} is missing`);
  reservations.push(await git.memory.reserve(Math.max(1, object.size)));
  return PackIdx.parse(new Uint8Array(await object.arrayBuffer()));
}

function countingStore(store: PackStore, calls: Counters): Pick<PackStore, "openRange"> {
  return {
    openRange(packId, offset, length) {
      if (length > 0) calls.r2++;
      return store.openRange(packId, offset, length);
    },
  };
}

/** Counts the R2 calls of materialised writes: one PUT, or a multipart upload. */
function countingMaterialised(
  store: MaterialisedPackStore,
  calls: Counters,
): MaterialisedPackStore {
  return {
    find: (key) => store.find(key),
    begin(key) {
      const writer = store.begin(key);
      return {
        packId: writer.packId,
        write: (chunk) => writer.write(chunk),
        async finish() {
          const info = await writer.finish();
          calls.r2 +=
            info.bytes <= DEFAULT_PART_BYTES ? 1 : 2 + Math.ceil(info.bytes / DEFAULT_PART_BYTES);
          return info;
        },
        abort: () => writer.abort(),
      };
    },
  };
}

function keyOf(git: RepoGitStorage, packId: PackId): string {
  const row = git.registry.get(packId);
  if (!row) throw new Error(`pack ${packId} is not registered`);
  return row.r2Key;
}

function wirePart(git: RepoGitStorage, part: FetchResponsePart): WirePart {
  if (part.kind === "bytes") return part;
  if (part.kind === "pack") {
    return {
      kind: "stored",
      key: keyOf(git, part.packId),
      offset: part.offset,
      length: part.length,
      framed: part.framed,
    };
  }
  const { plan } = part;
  return {
    kind: "stitched",
    header: plan.header,
    segments: plan.segments.map((s) => ({
      packId: s.packId,
      key: keyOf(git, s.packId),
      offset: s.offset,
      length: s.length,
    })),
    length: plan.length,
    objectCount: plan.objectCount,
  };
}
