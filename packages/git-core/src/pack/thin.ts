import { type Oid, oidFromBytes, oidToHex } from "../object/oid.js";
import { PackError } from "./errors.js";
import type { PackIndexState } from "./index-state.js";
import { receivedObjectId } from "./object-id.js";
import type { ExternalBaseLookup, PackLimits } from "./parse.js";
import type { Resolver } from "./resolve.js";

/** Most missing bases named in the error message. */
const MAX_NAMED = 10;

/*
 * Thin packs: after every in-pack base has been walked, REF_DELTAs still
 * unresolved name bases outside the pack. Like `git index-pack --fix-thin`
 * (fix_unresolved_deltas), they are taken in pack order, and each base is
 * looked up once; a base found outside is walked like an in-pack one, which
 * also resolves deltas against it further on. The bases used are returned,
 * so the receive path can store them whole in a completion pack next to the
 * received thin pack.
 */
export async function resolveThinBases(
  state: PackIndexState,
  resolver: Resolver,
  lookup: ExternalBaseLookup | undefined,
  limits: PackLimits,
): Promise<Oid[]> {
  const used: Oid[] = [];
  const asked = new Set<string>();
  for (let i = 0; i < state.count; i++) {
    if (state.isResolved(i) || state.kind(i) !== "ref-delta") continue;
    const oid = oidFromBytes(state.refBaseOids, state.refBaseAt(i));
    const hex = oidToHex(oid);
    if (asked.has(hex)) continue;
    asked.add(hex);
    let found = lookup && (await lookup(oid));
    if (found === undefined) continue;
    if (found.data.length > limits.maxObjectBytes) {
      throw new PackError("object-too-large", `external base ${hex} is above the cap`);
    }
    if (!receivedObjectId(found.type, found.data).every((byte, k) => byte === oid[k])) {
      throw new PackError("bad-external-base", `external base ${hex} does not hash to its id`);
    }
    used.push(oid);
    const root = {
      entry: -1,
      oid,
      type: found.type,
      data: found.data,
      reservation: await resolver.reserve(found.data.length),
    };
    // Only the frame holds the bytes now, so the base cache can drop them.
    found = undefined;
    await resolver.walk(root);
  }

  const unresolved: string[] = [];
  for (let i = 0; i < state.count && unresolved.length < MAX_NAMED; i++) {
    if (state.isResolved(i) || state.kind(i) !== "ref-delta") continue;
    const hex = oidToHex(oidFromBytes(state.refBaseOids, state.refBaseAt(i)));
    if (!unresolved.includes(hex)) unresolved.push(hex);
  }
  let left = 0;
  for (let i = 0; i < state.count; i++) if (!state.isResolved(i)) left++;
  if (left > 0) {
    // Either the bases are nowhere, or REF_DELTAs form a cycle (git t5314).
    throw new PackError(
      "missing-base",
      `${left} deltas unresolved; base objects missing (or in a delta cycle): ${unresolved.join(", ")}`,
    );
  }
  return used;
}
