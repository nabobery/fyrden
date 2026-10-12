import { isValidRefname, type Oid, oidToHex, type RemoteRef } from "@fyrden/git-core";
import type { RefUpdateSpec } from "../chunked/head.js";

/*
 * Which of a source repository's refs an import creates: its branches and
 * tags, under the same rules a push meets. A name that is not UTF-8 is
 * skipped and reported (every Fyrden surface is JSON, where such a name
 * could not be shown faithfully), as is a name git would not accept or one
 * longer than a push may create.
 */

/** Longest ref name a push may create (the push policy's cap, Proposed 1,024 bytes). */
const MAX_REF_NAME_BYTES = 1024;

/**
 * Most refs one import creates. Proposed 10,000, the receive-pack command
 * limit the import's commit goes through.
 */
export const MAX_IMPORT_REFS = 10_000;

export const IMPORT_REF_PREFIXES = ["HEAD", "refs/heads/", "refs/tags/"] as const;

export interface ImportSelection {
  /** Creates (old: null), sorted by name. */
  readonly updates: RefUpdateSpec[];
  /** Distinct object ids to fetch, sorted. */
  readonly wants: Oid[];
  readonly skipped: { readonly ref: string; readonly reason: string }[];
  /** The branch the source's HEAD names, when it is imported. */
  readonly head?: string;
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A name for display: UTF-8 as is, other bytes as `\xNN`. */
export function displayRefName(name: Uint8Array): string {
  try {
    return utf8.decode(name);
  } catch {
    return [...name]
      .map((b) =>
        b >= 0x20 && b < 0x7f && b !== 0x5c
          ? String.fromCharCode(b)
          : `\\x${b.toString(16).padStart(2, "0")}`,
      )
      .join("");
  }
}

function isImportable(name: string): boolean {
  return name.startsWith("refs/heads/") || name.startsWith("refs/tags/");
}

export function selectImportRefs(refs: readonly RemoteRef[]): ImportSelection {
  const updates: RefUpdateSpec[] = [];
  const skipped: { ref: string; reason: string }[] = [];
  const wants = new Map<string, Oid>();
  let headTarget: string | undefined;
  for (const ref of refs) {
    let name: string;
    try {
      name = utf8.decode(ref.name);
    } catch {
      skipped.push({ ref: displayRefName(ref.name), reason: "ref name must be valid UTF-8" });
      continue;
    }
    if (name === "HEAD") {
      if (ref.symrefTarget) headTarget = displayRefName(ref.symrefTarget);
      continue;
    }
    if (!isImportable(name)) continue;
    if (ref.name.length > MAX_REF_NAME_BYTES) {
      skipped.push({ ref: name, reason: "ref name is too long" });
      continue;
    }
    if (!isValidRefname(ref.name)) {
      skipped.push({ ref: name, reason: "not a valid ref name" });
      continue;
    }
    const hex = oidToHex(ref.oid);
    updates.push({ ref: name, old: null, new: hex });
    wants.set(hex, ref.oid);
  }
  updates.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  const head =
    headTarget?.startsWith("refs/heads/") && updates.some((u) => u.ref === headTarget)
      ? headTarget
      : undefined;
  return {
    updates,
    wants: [...wants.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, oid]) => oid),
    skipped,
    ...(head ? { head } : {}),
  };
}
