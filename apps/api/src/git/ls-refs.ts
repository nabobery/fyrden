import {
  encodePktLine,
  flushPkt,
  type LsRefsArgs,
  type Oid,
  oidToHex,
  type RefSnapshot,
} from "@fyrden/git-core";
import { concatBytes } from "./protocol.js";

const encoder = new TextEncoder();

function startsWith(name: Uint8Array, prefix: Uint8Array): boolean {
  if (prefix.length > name.length) return false;
  for (let i = 0; i < prefix.length; i++) if (name[i] !== prefix[i]) return false;
  return true;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/** A ref selected for an ls-refs response. */
export interface ListedRef {
  readonly name: string;
  readonly oid: Oid;
}

/**
 * The refs an ls-refs request lists, in git's order: by name as bytes
 * (`refs_for_each_fullref_in_prefixes` walks the sorted ref store), each
 * once, kept when any prefix matches (git ls-refs.c `ref_match`). HEAD is
 * handled separately.
 */
export function selectRefs(snapshot: RefSnapshot, prefixes: readonly Uint8Array[]): ListedRef[] {
  const named = [...snapshot.refs].map(([name, oid]) => ({
    name,
    oid,
    bytes: encoder.encode(name),
  }));
  return named
    .filter((ref) => prefixes.length === 0 || prefixes.some((p) => startsWith(ref.bytes, p)))
    .sort((a, b) => compareBytes(a.bytes, b.bytes))
    .map(({ name, oid }) => ({ name, oid }));
}

/** Whether HEAD passes the prefixes (git applies `ref_match` to HEAD too). */
export function headMatches(prefixes: readonly Uint8Array[]): boolean {
  const head = encoder.encode("HEAD");
  return prefixes.length === 0 || prefixes.some((p) => startsWith(head, p));
}

/** Oids an ls-refs response needs peeled: every listed oid, when the client asked for `peel`. */
export function peelCandidates(snapshot: RefSnapshot, args: LsRefsArgs): Oid[] {
  if (!args.peel) return [];
  const oids = selectRefs(snapshot, args.refPrefixes).map((ref) => ref.oid);
  const head = snapshot.head === null ? undefined : snapshot.refs.get(snapshot.head);
  if (head && headMatches(args.refPrefixes)) oids.push(head);
  return oids;
}

/**
 * The ls-refs response (gitprotocol-v2, "ls-refs"), byte for byte as git
 * v2.53.0 ls-refs.c writes it: HEAD first when it resolves (or, with both
 * `unborn` and `symrefs`, as `unborn HEAD` when its branch does not exist
 * yet), then the matching refs, then a flush. `peeled` maps an oid's hex
 * to its peeled target and holds only annotated tags.
 */
export function encodeLsRefs(
  snapshot: RefSnapshot,
  args: LsRefsArgs,
  peeled: ReadonlyMap<string, Oid>,
): Uint8Array<ArrayBuffer> {
  const lines: string[] = [];
  const attributes = (oid: Oid | undefined) => {
    const target = oid && args.peel ? peeled.get(oidToHex(oid)) : undefined;
    return target ? ` peeled:${oidToHex(target)}` : "";
  };

  if (snapshot.head !== null && headMatches(args.refPrefixes)) {
    const oid = snapshot.refs.get(snapshot.head);
    const symref = args.symrefs ? ` symref-target:${snapshot.head}` : "";
    if (oid) lines.push(`${oidToHex(oid)} HEAD${symref}${attributes(oid)}\n`);
    else if (args.unborn && args.symrefs) lines.push(`unborn HEAD${symref}\n`);
  }
  for (const ref of selectRefs(snapshot, args.refPrefixes)) {
    lines.push(`${oidToHex(ref.oid)} ${ref.name}${attributes(ref.oid)}\n`);
  }

  return concatBytes([...lines.map((line) => encodePktLine(line)), flushPkt()]);
}
