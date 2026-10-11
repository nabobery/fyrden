import { WalkLimitError } from "../graph/errors.js";
import { OidTable } from "../graph/oid-table.js";
import { type Oid, oidToHex } from "../object/oid.js";
import type { BlockCache } from "../ports/block-cache.js";
import type { CommitGraph } from "../ports/commit-graph.js";
import type { MemoryBudget } from "../ports/memory-budget.js";
import type { PackId, PackStore } from "../ports/pack-store.js";
import type { RefSnapshot } from "../ports/ref-store.js";
import type { Zlib } from "../ports/zlib.js";
import { flushPkt } from "../protocol/pktline.js";
import { SIDEBAND_64K_MAX_PAYLOAD } from "../protocol/sideband.js";
import type { FetchArgs } from "../protocol/v2-command.js";
import { ObjectReader } from "../reader/object-reader.js";
import { createReadStats, type ReadStats } from "../reader/stats.js";
import type { RepoView } from "../reader/view.js";
import { regeneratedPackKey } from "./cache-key.js";
import { selectCommits } from "./commits.js";
import { resolveDeepenNot } from "./deepen-not.js";
import { UploadPackError } from "./errors.js";
import { framingSink, type MaterialisedPackStore, materialise } from "./materialise.js";
import { commonCommits, readyToSend } from "./negotiate.js";
import { selectObjects } from "./objects.js";
import { type PeelReader, tagChain } from "./peel.js";
import { writeRegeneratedPack } from "./regenerate.js";
import {
  acknowledgmentsSection,
  type FetchResponsePart,
  packfileHeader,
  shallowInfoSection,
} from "./response.js";
import { planShallow, type ShallowPlan } from "./shallow.js";
import { planVerbatim, type VerbatimCandidate } from "./verbatim-plan.js";
import { RefTips, validateWants, type WantedObjects } from "./wants.js";

export type { MaterialisedPackStore } from "./materialise.js";
export type { VerbatimCandidate } from "./verbatim-plan.js";

/** What planning a fetch reads and writes for one repository. */
export interface UploadPackRepository {
  /** The current refs: wants are validated against these. */
  readonly refs: RefSnapshot;
  /** Read with the verified view only. */
  readonly commitGraph: CommitGraph;
  /** The repository's packs, as the object reader opens them. */
  readonly view: RepoView;
  readonly packStore: Pick<PackStore, "openRange">;
  readonly zlib: Zlib;
  /** The reader, the pack writer and the walk tables reserve here. */
  readonly memory: MemoryBudget;
  readonly blockCache?: BlockCache;
  /**
   * Registry facts per pack for verbatim plans (full clones served from
   * the stored packs). Without them every fetch is regenerated.
   */
  readonly verbatim?: readonly VerbatimCandidate[];
  /** Where regenerated packs and framed copies are written before the plan returns. */
  readonly materialised: MaterialisedPackStore;
  /** Identify the repository and its pack registry state in cache keys. */
  readonly cacheIdentity: { readonly repoId: string; readonly registryVersion: number };
}

export interface FetchPlanLimits {
  /** Commit rows one want-validation walk may load. Proposed: 100,000. */
  readonly wantWalkCommits: number;
  /** Commit rows the `ready` check may load. Proposed: 100,000. */
  readonly negotiationCommits: number;
  /** Commit rows the shallow and pack walks may load. Proposed: 1,000,000. */
  readonly enumerationCommits: number;
  /** Objects a regenerated pack may hold. Proposed: 1,000,000, the pack parser's limit. */
  readonly maxObjects: number;
  /** Most stored packs a verbatim plan stitches (the view cap). Proposed: 32. */
  readonly maxVerbatimPacks: number;
  /** Bytes per sequential read while regenerating. Proposed: 8 MiB. */
  readonly rangeBytes: number;
}

export const DEFAULT_FETCH_PLAN_LIMITS: FetchPlanLimits = Object.freeze({
  wantWalkCommits: 100_000,
  negotiationCommits: 100_000,
  enumerationCommits: 1_000_000,
  maxObjects: 1_000_000,
  maxVerbatimPacks: 32,
  rangeBytes: 8 * 1024 * 1024,
});

export interface FetchPlanOptions {
  /**
   * `transport`: pack parts name stored pack bytes and the transport frames
   * them while streaming (Workers Paid). `stored`: every pack part is a
   * side-band framed copy written here, which the transport passes through
   * natively (Workers Free, where per-chunk JavaScript in the Worker costs too much CPU).
   */
  readonly framing: "transport" | "stored";
  /** Side-band payload per packet in stored copies. Default 65,515. */
  readonly payloadBytes?: number;
  readonly limits?: Partial<FetchPlanLimits>;
  /** Read counts for this request's metrics; added to. */
  readonly stats?: ReadStats;
}

export interface FetchPlan {
  /** The response, in order. Empty for a request without wants (git sends nothing). */
  readonly parts: readonly FetchResponsePart[];
  /** Set when the response carries a pack. */
  readonly pack?: {
    readonly kind: "as-is" | "stitched" | "regenerated";
    /** Objects in the pack; not known for a materialised object found again by key. */
    readonly objectCount?: number;
    /** A materialised object written by an earlier request was reused. */
    readonly cached: boolean;
  };
  /**
   * Packs the transport reads, to take read leases on
   * before streaming and release after: stored packs of a verbatim plan,
   * or the materialised object. The caller also holds the view's packs
   * while planning.
   */
  readonly leasePacks: readonly PackId[];
}

/**
 * Plans the response to one protocol v2 `fetch` request.
 * Throws `UploadPackError` for a request it refuses; the transport sends
 * its message as an `ERR` packet.
 */
export async function planFetch(
  repo: UploadPackRepository,
  args: FetchArgs,
  options: FetchPlanOptions,
): Promise<FetchPlan> {
  // git answers a request without wants with nothing at all.
  if (args.wants.length === 0) return { parts: [], leasePacks: [] };
  const limits = { ...DEFAULT_FETCH_PLAN_LIMITS, ...options.limits };
  const graph = repo.commitGraph;
  const reader = await ObjectReader.open({
    view: repo.view,
    packStore: repo.packStore,
    zlib: repo.zlib,
    memory: repo.memory,
    ...(repo.blockCache ? { blockCache: repo.blockCache } : {}),
    stats: options.stats ?? createReadStats(),
  });
  try {
    const tips = new RefTips(repo.refs, graph, reader);
    const wanted = await validateWants(args.wants, tips, graph, reader, limits.wantWalkCommits);
    const common = await commonCommits(graph, args.haves);
    const parts: FetchResponsePart[] = [];
    if (args.haves.length > 0 && !args.done) {
      const wantCommits = (await wanted()).commits;
      const ready = await readyToSend(graph, wantCommits, common, limits.negotiationCommits);
      parts.push({ kind: "bytes", bytes: acknowledgmentsSection(common, ready) });
      if (!ready) return { parts, leasePacks: [] };
    }
    const deepenNot = await resolveDeepenNot(args.deepenNot, repo.refs, tips);
    const deepens =
      args.deepen !== undefined || args.deepenSince !== undefined || args.deepenNot.length > 0;
    const shallow = await planShallow(
      graph,
      reader,
      tips,
      {
        wants: deepens ? (await wanted()).commits : [],
        clientShallow: args.shallow,
        deepen: args.deepen,
        deepenRelative: args.deepenRelative,
        deepenSince: args.deepenSince,
        deepenNot,
      },
      limits.enumerationCommits,
    );
    if (shallow.active) {
      parts.push({ kind: "bytes", bytes: shallowInfoSection(shallow.shallow, shallow.unshallow) });
    }
    parts.push({ kind: "bytes", bytes: packfileHeader() });
    const payloadBytes = options.payloadBytes ?? SIDEBAND_64K_MAX_PAYLOAD;
    const framed = options.framing === "stored" ? payloadBytes : undefined;
    const context: PackContext = { repo, args, limits, reader, stats: options.stats, framed };

    const verbatim =
      common.length === 0 && !shallow.active
        ? await planVerbatim(repo, args, limits.maxVerbatimPacks, framed)
        : undefined;
    const pack = verbatim ?? (await regenerate(context, wanted, common, shallow));
    parts.push(...pack.parts, { kind: "bytes", bytes: flushPkt() });
    return { parts, pack: pack.pack, leasePacks: pack.leasePacks };
  } finally {
    reader.release();
  }
}

interface PackContext {
  readonly repo: UploadPackRepository;
  readonly args: FetchArgs;
  readonly limits: FetchPlanLimits;
  readonly reader: ObjectReader;
  readonly stats: ReadStats | undefined;
  /** Payload size of stored framed copies, or undefined for transport framing. */
  readonly framed: number | undefined;
}

export interface PlannedPack {
  readonly parts: readonly FetchResponsePart[];
  readonly pack: NonNullable<FetchPlan["pack"]>;
  readonly leasePacks: readonly PackId[];
}

/** Selects what the client lacks and writes it as a new pack, unless an identical request already did. */
async function regenerate(
  context: PackContext,
  wanted: () => Promise<WantedObjects>,
  common: readonly Oid[],
  shallow: ShallowPlan,
): Promise<PlannedPack> {
  const { repo, args, limits, framed } = context;
  const key = regeneratedPackKey({
    repoId: repo.cacheIdentity.repoId,
    refsVersion: repo.refs.version,
    registryVersion: repo.cacheIdentity.registryVersion,
    wants: args.wants,
    commonHaves: common,
    shallow: args.shallow,
    deepen: args.deepen,
    deepenRelative: args.deepenRelative,
    deepenSince: args.deepenSince,
    deepenNot: args.deepenNot,
    ofsDelta: args.ofsDelta,
    thinPack: args.thinPack,
    includeTag: args.includeTag,
    framedPayload: framed,
  });
  const found = await repo.materialised.find(key);
  if (found) return packPart(found.packId, found.bytes, framed, { cached: true });

  const { objects, held } = await selectAll(context, await wanted(), common, shallow);
  const tables = await reserveTables(repo.memory, objects.byteLength);
  try {
    let objectCount = 0;
    const info = await materialise(repo.materialised, key, async (writer) => {
      const framing = framed === undefined ? undefined : framingSink(writer, framed);
      const written = await writeRegeneratedPack(objects, {
        view: repo.view,
        packStore: repo.packStore,
        zlib: repo.zlib,
        memory: repo.memory,
        reader: context.reader,
        stats: context.stats ?? context.reader.stats,
        ofsDelta: args.ofsDelta,
        // Thin only against what the client is proven to hold.
        ...(args.thinPack ? { externalBases: held } : {}),
        rangeBytes: limits.rangeBytes,
        sink: framing?.sink ?? writer,
      });
      await framing?.end();
      objectCount = written.objectCount;
    });
    return packPart(info.packId, info.bytes, framed, { cached: false, objectCount });
  } finally {
    tables.release();
  }
}

function packPart(
  packId: PackId,
  length: number,
  framed: number | undefined,
  pack: { cached: boolean; objectCount?: number },
): PlannedPack {
  return {
    parts: [{ kind: "pack", packId, offset: 0, length, framed: framed !== undefined }],
    pack: { kind: "regenerated", ...pack },
    leasePacks: [packId],
  };
}

async function reserveTables(memory: MemoryBudget, bytes: number) {
  try {
    return await memory.reserve(Math.max(1, bytes));
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new UploadPackError(
      "too-large",
      "upload-pack: the fetch needs more memory than this server has; fetch less history",
    );
  }
}

/**
 * Every object of the regenerated pack (commits, wanted and included tags,
 * trees, blobs), and the objects the walk proved the client holds.
 */
async function selectAll(
  context: PackContext,
  wanted: WantedObjects,
  common: readonly Oid[],
  shallow: ShallowPlan,
): Promise<{ objects: OidTable; held: OidTable }> {
  const { repo, args, limits, reader } = context;
  const graph = repo.commitGraph;
  let commits: Awaited<ReturnType<typeof selectCommits>>;
  try {
    commits = await selectCommits(
      graph,
      [...wanted.commits, ...shallow.extraWants],
      [...common, ...shallow.extraEdges],
      shallow.boundary,
      // A shallow request also counts the haves' own trees as held (git's
      // aggressive edges when shallow).
      shallow.active ? [...shallow.extraEdges, ...common] : shallow.extraEdges,
      limits.enumerationCommits,
    );
  } catch (error) {
    if (!(error instanceof WalkLimitError)) throw error;
    throw new UploadPackError(
      "too-large",
      `upload-pack: the fetch needs more than ${error.limit} commits; fetch less history`,
    );
  }
  const roots = await treesOf(graph, [...commits.sent]);
  const edges = await treesOf(graph, [...commits.edges]);
  const objects = new OidTable(commits.sent.size * 4);
  for (const oid of commits.sent) objects.add(oid);
  const extraBlobs: Oid[] = [];
  for (const { oid, type } of wanted.objects) {
    if (type === "tree") roots.push(oid);
    else if (type === "blob") extraBlobs.push(oid);
    else objects.add(oid);
  }
  const selected = await selectObjects(reader, roots, edges, limits.maxObjects);
  for (const oid of selected.trees) objects.add(oid);
  for (const oid of selected.blobs) objects.add(oid);
  for (const oid of extraBlobs) objects.add(oid);
  const held = selected.held;
  for (const oid of commits.edges) held.add(oid);
  if (args.includeTag)
    await includeTags(repo.refs, new RefTips(repo.refs, graph, reader), reader, objects);
  if (objects.size > limits.maxObjects) {
    throw new UploadPackError(
      "too-large",
      `upload-pack: the fetch needs more than ${limits.maxObjects} objects; fetch less history`,
    );
  }
  return { objects, held };
}

const TREE_BATCH = 4096;

/** The root trees of `commits`, from their commit graph rows. */
async function treesOf(graph: CommitGraph, commits: readonly Oid[]): Promise<Oid[]> {
  const trees: Oid[] = [];
  for (let at = 0; at < commits.length; at += TREE_BATCH) {
    const rows = await graph.read(commits.slice(at, at + TREE_BATCH), "verified");
    for (const [k, row] of rows.entries()) {
      if (!row) throw new Error(`commit ${oidToHex(commits[at + k] as Oid)} has no graph row`);
      trees.push(row.tree);
    }
  }
  return trees;
}

/**
 * `include-tag`: every annotated tag under `refs/tags/` whose peeled
 * object is being sent, with the tags along its chain (git v2.53.0
 * pack-objects.c `add_ref_tag`, `add_tag_chain`).
 */
async function includeTags(
  refs: RefSnapshot,
  tips: RefTips,
  reader: PeelReader,
  objects: OidTable,
): Promise<void> {
  const tagRefs = [...refs.refs].filter(([name]) => name.startsWith("refs/tags/"));
  if (tagRefs.length === 0) return;
  const peeled = await tips.peeled();
  for (const [, oid] of tagRefs) {
    const tip = peeled.get(oidToHex(oid));
    if (tip?.type !== "tag" || objects.has(oid) || !objects.has(tip.target)) continue;
    for (const tag of (await tagChain(reader, oid)).tags) objects.add(tag);
  }
}
