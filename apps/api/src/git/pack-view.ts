import { packObjectKey, type RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import {
  type IdxRangeReader,
  type IdxReadBudget,
  openRangedIdx,
  type PackIdxSource,
  type RangedPackIdx,
  type RepoView,
  type ViewPack,
} from "@fyrden/git-core";

/**
 * Reads `length` bytes at `offset` of an R2 object. R2 returns fewer bytes
 * only at the end of the object, which is what `openRangedIdx` expects.
 */
async function readRange(
  bucket: R2Bucket,
  key: string,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const object = await bucket.get(key, { range: { offset, length } });
  if (!object) throw new Error(`${key} is missing from R2`);
  return new Uint8Array(await object.arrayBuffer());
}

/**
 * An `.idx` opened on its first lookup, so packs a lookup never reaches
 * cost nothing. Reads go to the caller's budget, the opening read to the
 * lookup that made it.
 */
function lazyIdx(read: IdxRangeReader): PackIdxSource {
  let opened: Promise<RangedPackIdx> | undefined;
  const open = (budget: IdxReadBudget | undefined) => {
    if (!opened) {
      if (budget) budget.reads++;
      opened = openRangedIdx(read);
    }
    return opened;
  };
  return {
    async lookup(oid, at, budget) {
      return (await open(budget)).lookup(oid, at, budget);
    },
    async lookupMany(oids, budget) {
      // An index not yet opened costs one read before the lookup's own.
      if (!opened && budget && budget.reads + 1 > budget.maxReads) return oids.map(() => null);
      return (await open(budget)).lookupMany(oids, budget);
    },
    async crc32At(position, budget) {
      return (await open(budget)).crc32At(position, budget);
    },
  };
}

/**
 * The repository's live packs as a reader view, newest first, with each
 * `.idx` read by ranges from R2 (`net/<network_id>/p/<pack_id>.idx`, beside
 * the pack). Opening an index reads its header and fanout (one range read);
 * the registry keeps a copy of the fanout that would save it, but does not
 * expose it yet.
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
    if (pack.bytes === null) throw new Error(`live pack ${pack.packId} has no length`);
    const key = packObjectKey(pack.networkId, pack.packId, "idx");
    const idx = lazyIdx((offset, length) => {
      onRead();
      return readRange(git.bucket, key, offset, length);
    });
    packs.push({
      packId: pack.packId,
      bytes: pack.bytes,
      idx,
      ...(borrowed.has(pack.packId) ? { shared: true } : {}),
    });
  }
  return { scope: git.networkId(), packs };
}
