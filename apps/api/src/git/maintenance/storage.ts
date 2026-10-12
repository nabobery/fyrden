import { createWorkersZlib } from "@fyrden/adapters-cloudflare";
import { packObjectKey, type RepoGitStorage, scratchPrefix } from "@fyrden/adapters-cloudflare/git";
import {
  type BlockCache,
  type MemoryReservation,
  ObjectReader,
  type PackId,
  PackIdx,
  type PackStore,
  type ViewPack,
} from "@fyrden/git-core";

/*
 * What maintenance jobs read and keep in R2: pack indexes (read whole, under
 * a memory reservation), a reader over a set of packs, and the job's scratch
 * objects (`net/<nid>/scratch/<run_id>/<name>`) for state too large for its
 * cursor row: marks, writer checkpoints, the bytes of a part not yet
 * uploaded. A run deletes its scratch objects when it ends.
 */

export const BUCKET = "fyrden-git";

/** Counts R2 calls of one slice, to stop before the per-invocation limit. */
export interface CallCounter {
  calls: number;
}

/** A pack as maintenance reads it: registry facts and its parsed `.idx`. */
export interface LoadedPack {
  readonly packId: PackId;
  readonly networkId: string;
  readonly bytes: number;
  readonly idx: PackIdx;
}

/** Packs loaded for one slice, with the memory their indexes hold. */
export class LoadedPacks {
  readonly #reservations: MemoryReservation[] = [];
  readonly packs: LoadedPack[] = [];

  static async load(
    git: RepoGitStorage,
    packIds: readonly PackId[],
    counter: CallCounter,
  ): Promise<LoadedPacks> {
    const loaded = new LoadedPacks();
    try {
      for (const packId of packIds) {
        const row = git.registry.get(packId);
        if (!row || row.bytes === null) throw new Error(`pack ${packId} is not readable`);
        counter.calls++;
        git.context.metrics.count("r2.class_b", { bucket: BUCKET, op: "get_idx" });
        const object = await git.bucket.get(packObjectKey(row.networkId, packId, "idx"));
        if (!object) throw new Error(`the index of pack ${packId} is missing`);
        loaded.#reservations.push(await git.memory.reserve(Math.max(1, object.size)));
        const idx = PackIdx.parse(new Uint8Array(await object.arrayBuffer()));
        loaded.packs.push({ packId, networkId: row.networkId, bytes: row.bytes, idx });
      }
    } catch (error) {
      loaded.release();
      throw error;
    }
    return loaded;
  }

  release(): void {
    for (const reservation of this.#reservations.splice(0)) reservation.release();
  }
}

/** A pack store whose range reads are counted. */
export function countingStore(
  git: RepoGitStorage,
  counter: CallCounter,
): Pick<PackStore, "openRange"> {
  return {
    openRange(packId, offset, length) {
      if (length > 0) counter.calls++;
      return git.packStore.openRange(packId, offset, length);
    },
  };
}

/** A reader over `packs` (in this order), through the object's in-memory block tier. */
export function openReader(
  git: RepoGitStorage,
  packs: readonly LoadedPack[],
  counter: CallCounter,
  blocks?: BlockCache,
): Promise<ObjectReader> {
  const view: ViewPack[] = packs.map((p) => ({ packId: p.packId, bytes: p.bytes, idx: p.idx }));
  return ObjectReader.open({
    view: { scope: git.networkId(), packs: view },
    packStore: countingStore(git, counter),
    zlib: createWorkersZlib(),
    memory: git.memory,
    ...(blocks ? { blockCache: blocks } : {}),
  });
}

export function scratchKey(git: RepoGitStorage, runId: string, name: string): string {
  if (!/^[a-z0-9-]{1,64}$/.test(name)) throw new RangeError("bad scratch object name");
  return `${scratchPrefix(git.networkId(), runId)}${name}`;
}

export async function putScratch(
  git: RepoGitStorage,
  runId: string,
  name: string,
  bytes: Uint8Array,
  counter: CallCounter,
): Promise<void> {
  counter.calls++;
  git.context.metrics.count("r2.class_a", { bucket: BUCKET, op: "put_scratch" });
  await git.bucket.put(scratchKey(git, runId, name), bytes);
}

export async function getScratch(
  git: RepoGitStorage,
  runId: string,
  name: string,
  counter: CallCounter,
): Promise<Uint8Array> {
  counter.calls++;
  git.context.metrics.count("r2.class_b", { bucket: BUCKET, op: "get_scratch" });
  const object = await git.bucket.get(scratchKey(git, runId, name));
  if (!object) throw new Error(`maintenance scratch object ${name} of run ${runId} is missing`);
  return new Uint8Array(await object.arrayBuffer());
}

export async function deleteScratch(
  git: RepoGitStorage,
  runId: string,
  names: readonly string[],
): Promise<void> {
  if (names.length > 0) await git.bucket.delete(names.map((n) => scratchKey(git, runId, n)));
}

/** Deletes every scratch object of a run (paged). */
export async function deleteRun(git: RepoGitStorage, runId: string): Promise<void> {
  const prefix = scratchPrefix(git.networkId(), runId);
  for (;;) {
    const page = await git.bucket.list({ prefix, limit: 1_000 });
    const keys = page.objects.map((o) => o.key);
    if (keys.length > 0) await git.bucket.delete(keys);
    if (!page.truncated) return;
  }
}

/**
 * Deletes a maintenance output that will not be used: its row is
 * discarded, its bytes deleted. An output that already went live or became
 * garbage (its swap committed, the cursor saying so was lost) is left alone.
 */
export async function discardOutput(git: RepoGitStorage, packId: PackId): Promise<void> {
  const row = git.registry.get(packId);
  if (!row) return;
  git.registry.transition(packId, ["pending", "indexing"], "discarded");
  if (git.registry.get(packId)?.state !== "discarded") return;
  git.context.storage.sql.exec("DELETE FROM leases WHERE pack_id = ?", packId).toArray();
  await git.bucket.delete([row.r2Key, packObjectKey(row.networkId, packId, "idx")]);
}

/** Whether an output's swap already happened (it is live, or garbage). */
export function swapped(git: RepoGitStorage, packId: PackId | undefined): boolean {
  if (packId === undefined) return false;
  const state = git.registry.get(packId)?.state;
  return state === "live" || state === "garbage" || state === "superseded" || state === "condemned";
}

export const encodeJson = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));

export function decodeJson<T>(bytes: Uint8Array | null): T | undefined {
  if (!bytes) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return undefined;
  }
}
