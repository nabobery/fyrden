import {
  type HeldPackIndex,
  type PackRow,
  packObjectKey,
  type RepoGitStorage,
} from "@fyrden/adapters-cloudflare/git";
import {
  type IdxRangeReader,
  type IdxReadBudget,
  openRangedIdx,
  PackIdx,
  type PackIdxSource,
  RangedPackIdx,
  type RepoView,
  type ViewPack,
} from "@fyrden/git-core";

/** An `.idx` without its entries: header, fanout and the two checksums. */
const IDX_FIXED_BYTES = 8 + 1024 + 40;
/** A fanout held for an index read by ranges: 256 counts of 4 bytes. */
const FANOUT_BYTES = 1024;
/** Packs from this size may hold 64-bit offsets, 8 more bytes per entry at most. */
const LARGE_OFFSET_PACK_BYTES = 2 ** 31;

/**
 * An R2 object, or `range` of it. R2 returns fewer bytes than asked only at
 * the end of the object, which is what `openRangedIdx` expects.
 */
async function readObject(
  bucket: R2Bucket,
  key: string,
  range?: { offset: number; length: number },
): Promise<Uint8Array> {
  const object = await bucket.get(key, range && { range });
  if (!object) throw new Error(`${key} is missing from R2`);
  return new Uint8Array(await object.arrayBuffer());
}

/** The most bytes the pack's `.idx` can have, or undefined when its object count was not recorded. */
function idxBytesAtMost(objectCount: number | null, packBytes: number): number | undefined {
  if (objectCount === null) return undefined;
  const perEntry = 20 + 4 + 4 + (packBytes >= LARGE_OFFSET_PACK_BYTES ? 8 : 0);
  return IDX_FIXED_BYTES + perEntry * objectCount;
}

/**
 * A pack's `.idx` through the repository object's index cache. An index of
 * at most `maxWholeBytes` is read whole with one GET on its first lookup
 * and then answers from memory, in this request and later ones; a larger
 * one (or one whose size is unknown) is read by ranges, with only its
 * fanout cached. A read goes to the budget of the lookup that made it; a
 * lookup answered from memory costs none.
 */
function cachedIdx(
  git: RepoGitStorage,
  pack: PackRow & { readonly bytes: number },
  onRead: () => void,
): PackIdxSource {
  const cache = git.packIndexes;
  const key = packObjectKey(pack.networkId, pack.packId, "idx");
  const readRange: IdxRangeReader = (offset, length) => {
    onRead();
    return readObject(git.bucket, key, { offset, length });
  };
  const atMost = idxBytesAtMost(pack.objectCount, pack.bytes);
  const wholeBytes = atMost !== undefined && atMost <= cache.maxWholeBytes ? atMost : undefined;
  const load = async (): Promise<HeldPackIndex> => {
    if (wholeBytes === undefined) return (await openRangedIdx(readRange)).fanout;
    onRead();
    return PackIdx.parse(await readObject(git.bucket, key));
  };
  let ranged: RangedPackIdx | undefined;
  const open = async (budget: IdxReadBudget | undefined) => {
    const held =
      cache.get(pack.packId) ??
      (await cache.load(pack.packId, wholeBytes ?? FANOUT_BYTES, () => {
        if (budget) budget.reads++;
        return load();
      }));
    if (held instanceof PackIdx) return held;
    ranged ??= RangedPackIdx.withFanout(readRange, held);
    return ranged;
  };
  return {
    async lookup(oid, at, budget) {
      const idx = await open(budget);
      return idx instanceof PackIdx ? idx.lookup(oid, at) : idx.lookup(oid, at, budget);
    },
    async lookupMany(oids, budget) {
      // An index not in memory costs one read before the lookup's own.
      if (!cache.get(pack.packId) && budget && budget.reads + 1 > budget.maxReads) {
        return oids.map(() => null);
      }
      const idx = await open(budget);
      return idx instanceof PackIdx ? idx.lookupMany(oids) : idx.lookupMany(oids, budget);
    },
    async crc32At(position, budget) {
      const idx = await open(budget);
      return idx instanceof PackIdx ? idx.crc32At(position) : idx.crc32At(position, budget);
    },
  };
}

/**
 * The repository's live packs as a reader view, newest first, each `.idx`
 * (`net/<network_id>/p/<pack_id>.idx`, beside the pack) read through the
 * object's index cache. Building the view drops the cached indexes of
 * packs no longer in it. `onRead` is called before each R2 read.
 */
export function liveView(
  git: RepoGitStorage,
  onRead: () => void = () => {},
  /** Packs of a push not live yet (indexed), read with the live ones (its commit point). */
  extraPacks: readonly string[] = [],
): RepoView {
  const live = [
    ...git.registry.inState("live").reverse(),
    ...extraPacks.flatMap((id) => {
      const row = git.registry.get(id);
      return row ? [row] : [];
    }),
  ];
  git.packIndexes.retain(new Set(live.map((pack) => pack.packId)));
  // Borrowed packs may hold another fork's objects: a push proves what it uses from them.
  const borrowed = new Set(
    git.context.storage.sql
      .exec<{ pack_id: string }>(
        "SELECT pack_id FROM packs WHERE state = 'live' AND origin = 'borrowed'",
      )
      .toArray()
      .map((r) => r.pack_id),
  );
  const packs: ViewPack[] = [];
  for (const pack of live) {
    const { bytes } = pack;
    if (bytes === null) throw new Error(`live pack ${pack.packId} has no length`);
    packs.push({
      packId: pack.packId,
      bytes,
      idx: cachedIdx(git, { ...pack, bytes }, onRead),
      ...(borrowed.has(pack.packId) ? { shared: true } : {}),
    });
  }
  return { scope: git.networkId(), packs };
}
