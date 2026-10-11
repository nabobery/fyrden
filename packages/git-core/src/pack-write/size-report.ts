import { OBJECT_TYPES, type ObjectType } from "../object/object.js";
import { PACK_HEADER_BYTES, PACK_TRAILER_BYTES } from "../pack/entry-header.js";
import type { PackEntries } from "../pack/index-state.js";

/*
 * Where a pack's bytes go: per object type, how many entries are stored
 * whole or as deltas and how many bytes each takes in the pack (entry
 * header plus zlib stream). Used to compare packs written without delta
 * search against delta-compressed ones (clone wire size).
 */

export interface SizeTally {
  readonly count: number;
  readonly bytes: number;
}

export interface PackSizeReport {
  readonly objects: number;
  /** Pack bytes: header, entries and trailer. */
  readonly packBytes: number;
  readonly whole: SizeTally;
  readonly delta: SizeTally;
  readonly byType: Readonly<
    Record<ObjectType, { readonly whole: SizeTally; readonly delta: SizeTally }>
  >;
}

/** The size report of a parsed pack (`ParsedPack.entries`). */
export function packSizeReport(entries: PackEntries): PackSizeReport {
  const tally = () => ({ count: 0, bytes: 0 });
  const byType = Object.fromEntries(
    OBJECT_TYPES.map((t) => [t, { whole: tally(), delta: tally() }]),
  ) as Record<
    ObjectType,
    { whole: { count: number; bytes: number }; delta: { count: number; bytes: number } }
  >;
  const whole = tally();
  const delta = tally();
  let entryBytes = 0;
  for (let i = 0; i < entries.count; i++) {
    const kind = entries.kind(i);
    const isDelta = kind === "ofs-delta" || kind === "ref-delta";
    const bytes = entries.entryLength(i);
    const slot = byType[entries.type(i)][isDelta ? "delta" : "whole"];
    slot.count++;
    slot.bytes += bytes;
    const total = isDelta ? delta : whole;
    total.count++;
    total.bytes += bytes;
    entryBytes += bytes;
  }
  return {
    objects: entries.count,
    packBytes: PACK_HEADER_BYTES + entryBytes + PACK_TRAILER_BYTES,
    whole,
    delta,
    byType,
  };
}
