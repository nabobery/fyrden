// What commit a ref names, for browse and blame alike. The lookups come from
// the caller, so each reads refs and peels tags through its own reader and
// limits: browse over its ref snapshot, blame with point reads.
import { type Oid, oidFromHex } from "@fyrden/git-core";
import { HEX_OID } from "./cache/object-access.js";

export interface RefLookups {
  /** The object of the ref HEAD names, or undefined when HEAD names none. */
  head(): Oid | undefined;
  /** One ref's object, or undefined. */
  ref(name: string): Oid | undefined;
  /** Whether this repository has the commit, in its verified view. */
  isVerified(oid: Oid): boolean;
  /** The commit an object is or peels to (an annotated tag), if this repository has it. */
  commitOf(oid: Oid): Promise<Oid | undefined>;
}

export type ResolvedRef =
  | { readonly ok: true; readonly commit: Oid }
  | { readonly ok: false; readonly reason: "repo_empty" | "ref_not_found" };

/**
 * The commit `ref` names: with none, HEAD's; a commit id this repository
 * has; else a branch, a tag, then a full ref name, the first found deciding.
 */
export async function resolveRef(
  ref: string | undefined,
  lookups: RefLookups,
): Promise<ResolvedRef> {
  if (ref === undefined || ref === "") {
    const head = lookups.head();
    return head ? { ok: true, commit: head } : { ok: false, reason: "repo_empty" };
  }
  if (HEX_OID.test(ref)) {
    const oid = oidFromHex(ref);
    // A branch or tag may be named like a commit id this repository lacks.
    if (lookups.isVerified(oid)) return { ok: true, commit: oid };
  }
  const names = [`refs/heads/${ref}`, `refs/tags/${ref}`];
  if (ref.startsWith("refs/")) names.push(ref);
  for (const name of names) {
    const oid = lookups.ref(name);
    if (!oid) continue;
    const commit = await lookups.commitOf(oid);
    return commit ? { ok: true, commit } : { ok: false, reason: "ref_not_found" };
  }
  return { ok: false, reason: "ref_not_found" };
}
