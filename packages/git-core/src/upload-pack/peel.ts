import { GitObjectError } from "../object/fsck.js";
import type { ObjectType } from "../object/object.js";
import { type Oid, oidToHex } from "../object/oid.js";
import { parseTag } from "../object/tag.js";
import type { CommitGraph } from "../ports/commit-graph.js";
import type { ObjectReader } from "../reader/object-reader.js";

/** What peeling reads: object types and tag bodies. */
export type PeelReader = Pick<ObjectReader, "readHeader" | "readObject">;

/** A ref tip, and what it peels to. */
export interface PeeledTip {
  readonly oid: Oid;
  readonly type: ObjectType;
  /** The first object along a tag chain that is not a tag; the tip itself when it is not a tag. */
  readonly target: Oid;
  readonly targetType: ObjectType;
}

/**
 * Longest tag-to-tag chain followed. Proposed; git has no limit, but a
 * chain cannot loop (each tag names its target by hash), so this only
 * bounds the work.
 */
export const MAX_TAG_CHAIN = 64;

/** Thrown when a stored tag chain is broken: a missing target or a tag that does not parse. */
export class BrokenTagError extends Error {
  override readonly name = "BrokenTagError";
}

/**
 * The type and peeled target of each of `oids` (ref tips), keyed by hex.
 * Commits are answered from the commit graph without reading objects; an
 * oid the view does not hold is left out. Annotated tags are followed as
 * git's `peel_object` does: to the first object a tag declares as not a
 * tag.
 */
export async function peelRefTips(
  oids: readonly Oid[],
  graph: CommitGraph,
  reader: PeelReader,
): Promise<Map<string, PeeledTip>> {
  const unique = [...new Map(oids.map((oid) => [oidToHex(oid), oid])).values()];
  const rows = await graph.read(unique, "verified");
  const out = new Map<string, PeeledTip>();
  for (const [i, oid] of unique.entries()) {
    if (rows[i]) {
      out.set(oidToHex(oid), { oid, type: "commit", target: oid, targetType: "commit" });
      continue;
    }
    const header = await reader.readHeader(oid);
    if (!header) continue;
    if (header.type !== "tag") {
      out.set(oidToHex(oid), { oid, type: header.type, target: oid, targetType: header.type });
      continue;
    }
    const chain = await tagChain(reader, oid);
    const target = chain.target;
    const [targetRow] = await graph.read([target], "verified");
    const targetType = targetRow ? "commit" : (await reader.readHeader(target))?.type;
    if (targetType === undefined)
      throw new BrokenTagError(`tag ${oidToHex(oid)} points at a missing object`);
    out.set(oidToHex(oid), { oid, type: "tag", target, targetType });
  }
  return out;
}

/** The tags of the chain starting at tag `oid` (outermost first) and the object it ends at. */
export async function tagChain(
  reader: PeelReader,
  oid: Oid,
): Promise<{ tags: Oid[]; target: Oid; declaredType: ObjectType }> {
  const tags: Oid[] = [];
  let current = oid;
  for (let depth = 0; depth < MAX_TAG_CHAIN; depth++) {
    const object = await reader.readObject(current);
    if (object?.type !== "tag") {
      throw new BrokenTagError(
        `tag chain from ${oidToHex(oid)} reaches ${oidToHex(current)}, not a tag`,
      );
    }
    let tag: ReturnType<typeof parseTag>["value"];
    try {
      tag = parseTag(object.bytes).value;
    } catch (error) {
      if (error instanceof GitObjectError) {
        throw new BrokenTagError(`tag ${oidToHex(current)} does not parse: ${error.message}`);
      }
      throw error;
    }
    tags.push(current);
    if (tag.type !== "tag") return { tags, target: tag.object, declaredType: tag.type };
    current = tag.object;
  }
  throw new BrokenTagError(`tag chain from ${oidToHex(oid)} is longer than ${MAX_TAG_CHAIN}`);
}
