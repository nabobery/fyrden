import { createWorkersZlib, DEFAULT_CACHE_API_CALLS } from "@fyrden/adapters-cloudflare";
import type { RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import {
  type BlockCache,
  ObjectReader,
  type Oid,
  oidFromBytes,
  oidFromHex,
  oidToHex,
} from "@fyrden/git-core";
import { openRequestBlockCache } from "../git/cache/pack-blocks.js";
import { liveView } from "../git/pack-view.js";
import { peelAll } from "../git/peel.js";
import type {
  CommitPage,
  CommitRowData,
  CondemnAnswer,
  ExportedRef,
  ForkExport,
  MemberPack,
  ViewPack,
} from "./types.js";

/*
 * A repository's side of its fork network: what it hands a
 * new fork (refs, live packs, its commit-graph closure page by page), how a
 * fork starts from that, and what the network object asks of a member
 * (a snapshot of its view, acknowledging condemned packs, which pack ids
 * its registry names). Everything runs inside the repository object.
 */

/** Refs a fork copies: branches and tags (pull request and other refs stay with the parent). */
export const FORKED_REF_PREFIXES = ["refs/heads/", "refs/tags/"] as const;

/** Delta-base cache for peeling tags at fork time. Proposed. */
const PEEL_DELTA_CACHE_BYTES = 1024 * 1024;

type RawViewPack = {
  pack_id: string;
  network_id: string;
  r2_key: string;
  kind: string;
  origin: string;
  bytes: number;
  object_count: number | null;
  unit_id: string | null;
  created_at: number;
};

/** The live packs of the repository's view (own and borrowed), oldest first. */
export function liveViewPacks(git: RepoGitStorage): ViewPack[] {
  return git.context.storage.sql
    .exec<RawViewPack>(
      `SELECT pack_id, network_id, r2_key, kind, origin, bytes, object_count, unit_id, created_at
       FROM packs WHERE state = 'live' AND bytes IS NOT NULL ORDER BY created_at, pack_id`,
    )
    .toArray()
    .map((r) => ({
      packId: r.pack_id,
      networkId: r.network_id,
      r2Key: r.r2_key,
      kind: r.kind,
      origin: r.origin === "borrowed" ? "borrowed" : "own",
      bytes: r.bytes,
      objectCount: r.object_count,
      unitId: r.unit_id,
      createdAt: r.created_at,
    }));
}

/**
 * The parent's half of fork creation: its branches, tags and live packs,
 * read together (no await in between, so the refs never name objects
 * outside the packs), with the packs read-leased by `holder` for `ttlMs`
 * so nothing deletes them before the network has recorded the fork's
 * claims. Then the commits the refs reach first, annotated tags peeled.
 */
export async function exportForFork(
  git: RepoGitStorage,
  memoryBlocks: BlockCache,
  holder: string,
  ttlMs: number,
): Promise<ForkExport> {
  const packs = liveViewPacks(git);
  const snapshot = git.refStore.readRefsSync();
  const refs: ExportedRef[] = [...snapshot.refs]
    .filter(([name]) => FORKED_REF_PREFIXES.some((prefix) => name.startsWith(prefix)))
    .map(([name, oid]) => ({ name, oid: new Uint8Array(oid) }));
  let leaseId: string | null = null;
  if (packs.length > 0) {
    const grant = git.leases.grant(
      "read",
      packs.map((p) => p.packId as never),
      holder,
      ttlMs,
    );
    if (!grant.ok) throw new Error(`pack ${grant.packId} cannot be leased (${grant.reason})`);
    leaseId = grant.leaseId;
  }
  try {
    const tips = await commitTips(
      git,
      memoryBlocks,
      refs.map((r) => oidFromBytes(r.oid)),
    );
    return {
      refs,
      head: snapshot.head,
      version: snapshot.version,
      tips: tips.map((t) => new Uint8Array(t)),
      packs,
      leaseId,
    };
  } catch (error) {
    if (leaseId) git.leases.release(leaseId);
    throw error;
  }
}

/** The commits `oids` name: commits as they are, annotated tags peeled; anything else is left out. */
async function commitTips(
  git: RepoGitStorage,
  memoryBlocks: BlockCache,
  oids: readonly Oid[],
): Promise<Oid[]> {
  const isCommit = (list: readonly Oid[]) =>
    git.commitGraph.readSync(list, "verified").map((row) => row !== undefined);
  const peeled = await peelAll(oids, isCommit, async () => {
    const view = liveView(git);
    if (view.packs.length === 0) return undefined;
    const reader = await ObjectReader.open({
      view,
      packStore: git.packStore,
      zlib: createWorkersZlib(),
      memory: git.memory,
      blockCache: (
        await openRequestBlockCache(memoryBlocks, {
          scope: view.scope,
          maxCalls: DEFAULT_CACHE_API_CALLS,
        })
      ).cache,
      limits: { deltaBaseCacheBytes: PEEL_DELTA_CACHE_BYTES },
    });
    return { reader, close: () => reader.release() };
  });
  const candidates = oids.map((oid) => peeled.get(oidToHex(oid)) ?? oid);
  const known = isCommit(candidates);
  const unique = new Map<string, Oid>();
  candidates.forEach((oid, i) => {
    if (known[i]) unique.set(oidToHex(oid), oid);
  });
  return [...unique.values()];
}

type RawCommit = {
  oid: ArrayBuffer;
  tree: ArrayBuffer;
  parents: ArrayBuffer;
  commit_time: number;
  generation: number;
  level: number;
  signature: string | null;
};

function readCommit(git: RepoGitStorage, oid: Oid): CommitRowData | undefined {
  const raw = git.context.storage.sql
    .exec<RawCommit>(
      `SELECT oid, tree, parents, commit_time, generation, level, signature
       FROM commits WHERE oid = ?`,
      new Uint8Array(oid).buffer,
    )
    .toArray()[0];
  return (
    raw && {
      oid: new Uint8Array(raw.oid),
      tree: new Uint8Array(raw.tree),
      parents: new Uint8Array(raw.parents),
      commitTime: raw.commit_time,
      generation: raw.generation,
      level: raw.level,
      signature: raw.signature,
    }
  );
}

/** Most commits still to visit a page may carry (bounds the cursor). Proposed. */
export const MAX_FRONTIER = 50_000;

/**
 * One page of the verified commit-graph rows the fork's refs reach,
 * newest generation first. The walk always takes the highest generation
 * left; a parent's generation is lower than each child's, so by the time a
 * commit is taken every child that reaches it has been taken, and it can
 * never be found again: no visited set is needed across pages, only the
 * commits still to visit (`frontier`). A parent the graph does not have (a
 * shallow boundary) ends that line.
 */
export function commitPage(
  git: RepoGitStorage,
  frontier: readonly string[],
  limit: number,
): CommitPage {
  const heap = new GenerationHeap();
  const pending = new Set<string>();
  const add = (hex: string) => {
    if (pending.has(hex)) return;
    const row = readCommit(git, oidFromHex(hex));
    if (!row) return;
    pending.add(hex);
    heap.push(row);
  };
  for (const hex of frontier) add(hex);
  const rows: CommitRowData[] = [];
  while (rows.length < limit) {
    const row = heap.pop();
    if (!row) break;
    pending.delete(oidToHex(oidFromBytes(row.oid)));
    rows.push(row);
    for (let at = 0; at < row.parents.length; at += 20)
      add(oidToHex(oidFromBytes(row.parents, at)));
  }
  if (pending.size > MAX_FRONTIER)
    throw new Error(`the commit graph is too wide to copy (${pending.size} open lines)`);
  return { rows, frontier: [...pending] };
}

/** A max-heap of commit rows by generation. */
class GenerationHeap {
  readonly #items: CommitRowData[] = [];

  push(row: CommitRowData): void {
    const items = this.#items;
    items.push(row);
    let i = items.length - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if ((items[up] as CommitRowData).generation >= row.generation) break;
      items[i] = items[up] as CommitRowData;
      i = up;
    }
    items[i] = row;
  }

  pop(): CommitRowData | undefined {
    const items = this.#items;
    const top = items[0];
    const last = items.pop();
    if (items.length === 0 || last === undefined) return top;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= items.length) break;
      const r = l + 1;
      const child =
        r < items.length &&
        (items[r] as CommitRowData).generation > (items[l] as CommitRowData).generation
          ? r
          : l;
      if ((items[child] as CommitRowData).generation <= last.generation) break;
      items[i] = items[child] as CommitRowData;
      i = child;
    }
    items[i] = last;
    return top;
  }
}

/** Stores a page of the parent's verified rows as this repository's own verified rows. */
export function importCommits(git: RepoGitStorage, rows: readonly CommitRowData[]): number {
  const { storage } = git.context;
  const written = storage.transactionSync(() => {
    let n = 0;
    for (const row of rows) {
      const cursor = storage.sql.exec(
        `INSERT INTO commits (oid, tree, parents, commit_time, generation, level, signature)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (oid) DO NOTHING`,
        new Uint8Array(row.oid).buffer,
        new Uint8Array(row.tree).buffer,
        new Uint8Array(row.parents).buffer,
        row.commitTime,
        row.generation,
        row.level,
        row.signature,
      );
      cursor.toArray();
      n += cursor.rowsWritten;
    }
    return n;
  });
  if (written > 0)
    git.context.metrics.count(
      "do.rows_written",
      { class: git.context.doClass, op: "fork.commits" },
      written,
    );
  return written;
}

/**
 * The fork's half of creation: its network, HEAD, and the parent's live
 * packs registered as borrowed (no byte is copied). Safe to repeat.
 */
export function initFork(
  git: RepoGitStorage,
  input: { networkId: string; head: string | null; packs: readonly ViewPack[] },
): void {
  git.initialize(input.networkId, input.head ?? "refs/heads/main");
  const { storage } = git.context;
  const now = git.context.now();
  storage.transactionSync(() => {
    for (const pack of input.packs)
      storage.sql
        .exec(
          `INSERT INTO packs (pack_id, network_id, r2_key, origin, kind, state, object_count,
             bytes, all_reachable, unit_id, created_at, last_touched_at)
           VALUES (?, ?, ?, 'borrowed', ?, 'live', ?, ?, 0, ?, ?, ?)
           ON CONFLICT (pack_id) DO NOTHING`,
          pack.packId,
          pack.networkId,
          pack.r2Key,
          pack.kind,
          pack.objectCount,
          pack.bytes,
          pack.unitId,
          pack.createdAt,
          now,
        )
        .toArray();
  });
}

/** Points the fork's refs where the parent's were. Refs already set (a repeated call) are kept. */
export function finishFork(git: RepoGitStorage, refs: readonly ExportedRef[]): void {
  const current = git.refStore.readRefsSync();
  const updates = refs
    .filter((r) => !current.refs.has(r.name))
    .map((r) => ({ name: r.name, oldOid: null, newOid: oidFromBytes(r.oid) }));
  if (updates.length === 0) return;
  const result = git.refStore.commitSync({
    addPacks: [],
    removePacks: [],
    refUpdates: updates,
    expectedVersion: current.version,
  });
  if (!result.ok) throw new Error(`setting the fork's refs failed (${result.reason})`);
}

/** States of a member's registry row that hold (claim) a pack. */
const HOLDING_STATES = ["indexing", "indexed", "live", "garbage", "superseded", "condemned"];

/** The member's registry rows of packs stored under `networkId`, for the network collection. */
export function networkSnapshot(git: RepoGitStorage, networkId: string): MemberPack[] {
  return git.context.storage.sql
    .exec<{ pack_id: string; network_id: string; state: string; origin: string }>(
      `SELECT pack_id, network_id, state, origin FROM packs
       WHERE network_id = ? AND state IN (${HOLDING_STATES.map(() => "?").join(", ")})`,
      networkId,
      ...HOLDING_STATES,
    )
    .toArray()
    .map((r) => ({ packId: r.pack_id, networkId: r.network_id, state: r.state, origin: r.origin }));
}

/**
 * Phase 1 of the deletion of shared packs, at this member: a pack this
 * view no longer reads (superseded) is condemned, so it gets no new lease;
 * one it still reads (live, garbage, being indexed) refuses the deletion.
 * Answers with when this member's leases on them end.
 */
export function condemnShared(git: RepoGitStorage, packIds: readonly string[]): CondemnAnswer {
  const { storage } = git.context;
  const now = git.context.now();
  return storage.transactionSync((): CondemnAnswer => {
    const inView: string[] = [];
    let leasesUntil = 0;
    for (const packId of packIds) {
      const row = storage.sql
        .exec<{ state: string }>("SELECT state FROM packs WHERE pack_id = ?", packId)
        .toArray()[0];
      if (row && ["live", "garbage", "indexing", "indexed", "pending"].includes(row.state)) {
        inView.push(packId);
        continue;
      }
      if (row?.state === "superseded") git.registry.transition(packId, ["superseded"], "condemned");
      const lease = storage.sql
        .exec<{ at: number | null }>(
          "SELECT max(expires_at) AS at FROM leases WHERE pack_id = ? AND expires_at > ?",
          packId,
          now,
        )
        .one().at as number | null;
      leasesUntil = Math.max(leasesUntil, lease ?? 0);
    }
    return inView.length > 0 ? { ok: false, inView } : { ok: true, leasesUntil };
  });
}

/** Of `packIds`, the ones this repository's registry names (in any state). */
export function registeredPacks(git: RepoGitStorage, packIds: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < packIds.length; i += 90) {
    const batch = packIds.slice(i, i + 90);
    for (const row of git.context.storage.sql
      .exec<{ pack_id: string }>(
        `SELECT pack_id FROM packs WHERE pack_id IN (${batch.map(() => "?").join(", ")})`,
        ...batch,
      )
      .toArray())
      out.push(row.pack_id);
  }
  return out;
}
