import { appendFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { copyBytes } from "../../src/object/bytes.js";
import { type Oid, oidFromHex, oidToHex } from "../../src/object/oid.js";
import { PackExistenceSummary } from "../../src/pack/existence-summary.js";
import { PackIdx } from "../../src/pack/idx-read.js";
import type { CommitGraphRow } from "../../src/ports/commit-graph.js";
import type { PackId, PackInfo, PackStore, PackWriter } from "../../src/ports/pack-store.js";
import { createReadStats, type ReadStats } from "../../src/reader/stats.js";
import type { ViewPack } from "../../src/reader/view.js";
import type {
  MaterialisedPackStore,
  UploadPackRepository,
  VerbatimCandidate,
} from "../../src/upload-pack/fetch.js";
import { createMemoryBudget } from "../fakes/memory-budget.js";
import { createMemoryCommitGraph } from "../fakes/memory-commit-graph.js";
import { createMemoryRepoStore } from "../fakes/memory-repo-store.js";
import { createNodeZlib } from "../node-zlib.js";

/*
 * A repository served by the upload-pack test server, kept in a directory so
 * each server process (one per git connection) loads the same state:
 *
 *   state.json          refs, HEAD, packs in view order, commit graph rows
 *   packs/<name>.pack   stored pack bytes, as the receive path keeps them
 *   packs/<name>.idx    the `.idx` written by the engine for that pack
 *   fetch/<key>.pack    objects the server materialised (regenerated packs,
 *                       side-band framed copies), by cache key
 *   requests.jsonl      one line per command the server answered
 */

export interface UploadPackRepoState {
  readonly head: string | null;
  /** Ref name and hex oid. */
  readonly refs: readonly (readonly [string, string])[];
  /** View order: lookups and verbatim plans follow it. */
  readonly packs: readonly { readonly name: string; readonly allReachable: boolean }[];
  /** oid, tree, parents, commit time, generation, level. */
  readonly commits: readonly (readonly [
    string,
    string,
    readonly string[],
    number,
    number,
    number,
  ])[];
}

/** One line of `requests.jsonl`. */
export interface UploadPackRequestLog {
  readonly command: string;
  readonly plan?: "as-is" | "stitched" | "regenerated" | undefined;
  readonly cached?: boolean | undefined;
  readonly objectCount?: number | undefined;
  /** `PackStore.openRange` calls made while planning (the Durable Object's reads). */
  readonly planStoreReads: number;
  readonly planStoreBytes: number;
  /** Writes of materialised objects (regenerated packs, framed copies). */
  readonly materialisedWrites: number;
  /** Ranged reads the transport makes to stream the response: one per pack part or stitched segment. */
  readonly transportReads: number;
  readonly leasePacks: number;
  readonly error?: string | undefined;
}

export async function writeRepoState(dir: string, state: UploadPackRepoState): Promise<void> {
  await writeFile(join(dir, "state.json"), JSON.stringify(state));
}

export async function readRepoState(dir: string): Promise<UploadPackRepoState> {
  return JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as UploadPackRepoState;
}

/** The request log of a repository directory, oldest first. */
export async function readRequestLog(dir: string): Promise<UploadPackRequestLog[]> {
  let text: string;
  try {
    text = await readFile(join(dir, "requests.jsonl"), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as UploadPackRequestLog);
}

export async function appendRequestLog(dir: string, entry: UploadPackRequestLog): Promise<void> {
  await appendFile(join(dir, "requests.jsonl"), `${JSON.stringify(entry)}\n`);
}

/** Pack store calls counted for the request log. */
export interface CountingPackStore extends PackStore {
  reads: number;
  bytes: number;
  writes: number;
}

export function counting(inner: PackStore): CountingPackStore {
  const store: CountingPackStore = {
    reads: 0,
    bytes: 0,
    writes: 0,
    listPacks: () => inner.listPacks(),
    beginPack(): PackWriter {
      const writer = inner.beginPack();
      return {
        packId: writer.packId,
        write(chunk) {
          store.writes++;
          return writer.write(chunk);
        },
        finish: () => writer.finish(),
        abort: () => writer.abort(),
      };
    },
    async openRange(packId, offset, length) {
      store.reads++;
      store.bytes += length;
      return inner.openRange(packId, offset, length);
    },
  };
  return store;
}

const KEY = /^[0-9a-f]{40}$/;

/**
 * Materialised objects kept in the in-memory pack store and mirrored to
 * `fetch/<key>.pack`, so a later server process finds them again.
 */
export function directoryMaterialisedStore(dir: string, store: PackStore): MaterialisedPackStore {
  const found = new Map<string, PackInfo>();
  return {
    async find(key) {
      if (!KEY.test(key)) throw new RangeError(`bad materialised key ${key}`);
      const known = found.get(key);
      if (known) return known;
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await readFile(join(dir, "fetch", `${key}.pack`)));
      } catch {
        return undefined;
      }
      const writer = store.beginPack();
      await writer.write(bytes);
      const info = await writer.finish();
      found.set(key, info);
      return info;
    },
    begin(key) {
      if (!KEY.test(key)) throw new RangeError(`bad materialised key ${key}`);
      const writer = store.beginPack();
      const chunks: Uint8Array[] = [];
      return {
        packId: writer.packId,
        async write(chunk) {
          chunks.push(copyBytes(chunk));
          await writer.write(chunk);
        },
        async finish() {
          const info = await writer.finish();
          await mkdir(join(dir, "fetch"), { recursive: true });
          const temp = join(dir, "fetch", `${key}.${process.pid}.tmp`);
          await writeFile(temp, Buffer.concat(chunks));
          await rename(temp, join(dir, "fetch", `${key}.pack`));
          found.set(key, info);
          return info;
        },
        abort: () => writer.abort(),
      };
    },
  };
}

export interface LoadedUploadPackRepo {
  readonly repository: UploadPackRepository;
  readonly packStore: CountingPackStore;
  readonly stats: ReadStats;
  /** The view's packs by the name they have in the directory (empty when the format has none). */
  readonly packIds: ReadonlyMap<string, PackId>;
}

/** Loads a repository directory into the in-memory fakes, ready for `planFetch`. */
export async function openUploadPackRepo(dir: string): Promise<LoadedUploadPackRepo> {
  const state = await readRepoState(dir);
  const memory = createMemoryRepoStore({ head: state.head });
  const packStore = counting(memory.packStore);
  const view: ViewPack[] = [];
  const verbatim: VerbatimCandidate[] = [];
  const packIds = new Map<string, PackId>();
  for (const pack of state.packs) {
    const bytes = new Uint8Array(await readFile(join(dir, "packs", `${pack.name}.pack`)));
    const idx = PackIdx.parse(
      new Uint8Array(await readFile(join(dir, "packs", `${pack.name}.idx`))),
    );
    const writer = memory.packStore.beginPack();
    await writer.write(bytes);
    const info = await writer.finish();
    packIds.set(pack.name, info.packId);
    view.push({
      packId: info.packId,
      bytes: info.bytes,
      idx,
      summary: PackExistenceSummary.fromIdx(idx),
    });
    verbatim.push({
      packId: info.packId,
      objectCount: idx.count,
      allReachable: pack.allReachable,
      oidTable: () => idx.oidTable(),
    });
  }
  const committed = await memory.refStore.commit({
    addPacks: view.map((p) => p.packId),
    removePacks: [],
    refUpdates: state.refs.map(([name, hex]) => ({ name, oldOid: null, newOid: oidFromHex(hex) })),
    expectedVersion: 0,
  });
  if (!committed.ok) throw new Error(`could not load refs: ${committed.reason}`);

  const graph = createMemoryCommitGraph();
  const rows: CommitGraphRow[] = state.commits.map(
    ([oid, tree, parents, commitTime, generation, level]) => ({
      oid: oidFromHex(oid),
      tree: oidFromHex(tree),
      parents: parents.map(oidFromHex),
      commitTime,
      generation,
      level,
    }),
  );
  await graph.insertPending("load", rows);
  await graph.promote("load");

  const stats = createReadStats();
  const refs = await memory.refStore.readRefs();
  const repository: UploadPackRepository = {
    refs,
    commitGraph: graph,
    view: { scope: "test-network", packs: view },
    packStore,
    zlib: createNodeZlib(),
    memory: createMemoryBudget(96 * 1024 * 1024),
    verbatim,
    materialised: directoryMaterialisedStore(dir, packStore),
    cacheIdentity: { repoId: "test-repo", registryVersion: refs.version },
  };
  return { repository, packStore, stats, packIds };
}

/** Names of the materialised objects in a repository directory. */
export async function materialisedKeys(dir: string): Promise<string[]> {
  try {
    return (await readdir(join(dir, "fetch")))
      .filter((name) => name.endsWith(".pack"))
      .map((name) => name.slice(0, -5));
  } catch {
    return [];
  }
}

export function rowOf(row: CommitGraphRow): UploadPackRepoState["commits"][number] {
  return [
    oidToHex(row.oid),
    oidToHex(row.tree),
    row.parents.map((p: Oid) => oidToHex(p)),
    row.commitTime,
    row.generation,
    row.level,
  ];
}
