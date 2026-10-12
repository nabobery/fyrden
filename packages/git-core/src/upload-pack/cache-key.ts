import { Sha1 } from "../hash/sha1.js";
import { type Oid, oidToHex } from "../object/oid.js";
import type { PackId } from "../ports/pack-store.js";

/*
 * Keys of materialised objects: 40 lowercase hex digits (SHA-1 of a
 * canonical description), safe to use in storage keys as they are.
 *
 * A regenerated pack depends on the repository, its refs and pack
 * registry, and everything in the request that changes the bytes: wants,
 * common haves, shallow and deepen arguments, and the ofs-delta,
 * thin-pack and include-tag capabilities. Identical
 * requests then share one pack until refs or the registry move (CI fleets
 * cloning one commit at depth 1). A framed copy of stored packs depends
 * only on those packs, which never change, and the frame size.
 */

export interface RegeneratedKeyInput {
  readonly repoId: string;
  readonly refsVersion: number;
  readonly registryVersion: number;
  readonly wants: readonly Oid[];
  readonly commonHaves: readonly Oid[];
  readonly shallow: readonly Oid[];
  readonly deepen: number | undefined;
  readonly deepenRelative: boolean;
  readonly deepenSince: number | undefined;
  readonly deepenNot: readonly Uint8Array[];
  readonly ofsDelta: boolean;
  readonly thinPack: boolean;
  readonly includeTag: boolean;
  /** Side-band payload size of a framed pack; undefined for raw pack bytes. */
  readonly framedPayload: number | undefined;
}

const sortedHex = (oids: readonly Oid[]) => [...new Set(oids.map(oidToHex))].sort();
const hexBytes = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function digest(description: unknown): string {
  const sha = new Sha1({ detectCollisions: false });
  sha.update(new TextEncoder().encode(JSON.stringify(description)));
  return hexBytes(sha.digest());
}

export function regeneratedPackKey(input: RegeneratedKeyInput): string {
  return digest([
    "fyrden-fetch-pack-v1",
    input.repoId,
    input.refsVersion,
    input.registryVersion,
    sortedHex(input.wants),
    sortedHex(input.commonHaves),
    sortedHex(input.shallow),
    input.deepen ?? null,
    input.deepenRelative,
    input.deepenSince ?? null,
    input.deepenNot.map(hexBytes),
    input.ofsDelta,
    input.thinPack,
    input.includeTag,
    input.framedPayload ?? null,
  ]);
}

/** The key of the side-band framed copy of stored packs sent one after another (one pack: as-is). */
export function framedCopyKey(packIds: readonly PackId[], payloadBytes: number): string {
  return digest(["fyrden-framed-copy-v1", packIds, payloadBytes]);
}
