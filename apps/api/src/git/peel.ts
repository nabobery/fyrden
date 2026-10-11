import { GitObjectError, type Oid, oidToHex, parseTag } from "@fyrden/git-core";

/** What peeling needs from the object reader. */
export interface PeelReader {
  readHeader(oid: Oid): Promise<{ readonly type: string } | undefined>;
  readObject(oid: Oid): Promise<{ readonly type: string; readonly bytes: Uint8Array } | undefined>;
}

/**
 * Longest tag-to-tag chain followed. Proposed; git has no limit, but a chain
 * cannot loop (each tag names its target by hash), so this only bounds work.
 */
export const MAX_TAG_CHAIN = 64;

/**
 * What `oid` peels to, as git's `peel_object` (object.c) decides it: an
 * annotated tag peels to the first object in its chain that a tag declares
 * as not a tag; anything else, a missing object, a broken chain or a tag
 * that does not parse, has no peeled value.
 */
export async function peelOid(reader: PeelReader, oid: Oid): Promise<Oid | undefined> {
  const header = await reader.readHeader(oid);
  if (header?.type !== "tag") return undefined;
  let current = oid;
  for (let depth = 0; depth < MAX_TAG_CHAIN; depth++) {
    const object = await reader.readObject(current);
    if (object?.type !== "tag") return undefined;
    let tag: ReturnType<typeof parseTag>["value"];
    try {
      tag = parseTag(object.bytes).value;
    } catch (error) {
      if (error instanceof GitObjectError) return undefined;
      throw error;
    }
    if (tag.type !== "tag") return tag.object;
    current = tag.object;
  }
  return undefined;
}

/**
 * Peeled values for `oids`, keyed by hex; only annotated tags appear.
 * `isCommit` answers from the commit graph, so refs at known commits (almost
 * all of them) never open the reader. `openReader` is called at most once,
 * and only when some oid is not a known commit.
 */
export async function peelAll(
  oids: readonly Oid[],
  isCommit: (oids: readonly Oid[]) => boolean[],
  openReader: () => Promise<{ reader: PeelReader; close(): void } | undefined>,
): Promise<Map<string, Oid>> {
  const peeled = new Map<string, Oid>();
  const unique = [...new Map(oids.map((oid) => [oidToHex(oid), oid])).values()];
  const known = isCommit(unique);
  const unknown = unique.filter((_, i) => !known[i]);
  if (unknown.length === 0) return peeled;
  const opened = await openReader();
  if (!opened) return peeled;
  try {
    for (const oid of unknown) {
      const target = await peelOid(opened.reader, oid);
      if (target) peeled.set(oidToHex(oid), target);
    }
  } finally {
    opened.close();
  }
  return peeled;
}
