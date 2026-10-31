/*
 * A repository's entities a page at a time, for a read model that compares
 * its rows with the repository's own state (search's reconciliation): the
 * repository entity, then its issues and pull requests (one number
 * sequence, deleted issues' tombstones included), labels and milestones,
 * each in key order. Every page names the position it was read at, and a
 * page asked under another epoch or ownership generation than the
 * export's answers `stale`: the export starts again.
 */

/** What an export walks, in its order. */
export const EXPORT_KINDS = ["repo", "subjects", "labels", "milestones"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

/** Entities a page holds at most, and the bytes of their JSON (one entity always fits). */
export const EXPORT_PAGE = { entities: 200, bytes: 2 * 1024 * 1024 } as const;

/**
 * An entity as an export answers it: as its events carry it, but for a
 * milestone's counts, which are as they stand now (an issue joining or
 * leaving it changes them without a milestone event).
 */
export interface ExportedEntity {
  readonly type: string;
  readonly id: string;
  readonly version: number;
  readonly deleted: boolean;
  /** The row its events carry; null once deleted. */
  readonly row: Record<string, unknown> | null;
  /** A deleted issue's: where its deletion's event is (null when it predates their recording). */
  readonly deletedAt?: { readonly epochGen: number; readonly sourceSeq: number } | null;
}

export interface ExportPageRequest {
  readonly kind: ExportKind;
  /** The key the page starts after (0 for the first). */
  readonly after: number;
  /** Entities wanted, 1 to `EXPORT_PAGE.entities`. */
  readonly limit: number;
  /** The epoch and ownership generation the export started under (none for its first page). */
  readonly expected?: { readonly epochGen: number; readonly ownerGen: number };
}

export interface ExportPage {
  readonly sourceId: string;
  readonly epochGen: number;
  readonly ownerGen: number;
  /** The repository's latest event sequence when the page was read. */
  readonly watermark: number;
  readonly entities: readonly ExportedEntity[];
  /** The key to ask the next page after; null when the kind is done. */
  readonly next: number | null;
}

/** Where the repository's events stand, and its own entity. */
export interface ExportPosition {
  readonly sourceId: string;
  readonly epochGen: number;
  readonly ownerGen: number;
  readonly watermark: number;
  readonly repo: ExportedEntity;
}

/** An entity an export may answer: its key, and how to read it whole. */
export interface ExportEntry {
  readonly key: number;
  load(): ExportedEntity;
}

/** What an export reads: where the repository stands, and each kind's entries after a key. */
export interface ExportSources {
  position(): ExportPosition | null;
  /** In key order, at most `limit`; only the ones a page holds are loaded. */
  entries(kind: Exclude<ExportKind, "repo">, after: number, limit: number): ExportEntry[];
}

const encoder = new TextEncoder();
const sizeOf = (value: unknown) => encoder.encode(JSON.stringify(value)).length;

/**
 * Reads one page; null without an identity, `stale` when the repository's
 * epoch or ownership is no longer the export's. Each entity is loaded only
 * once it is the page's next, and the page stops before its JSON would pass
 * `EXPORT_PAGE.bytes` (one entity always fits).
 */
export function readExportPage(
  sources: ExportSources,
  request: ExportPageRequest,
): ExportPage | "stale" | null {
  const { kind, after, limit, expected } = request;
  if (!EXPORT_KINDS.includes(kind)) throw new RangeError(`unknown export kind: ${kind}`);
  if (!Number.isSafeInteger(after) || after < 0)
    throw new RangeError("after must be a key, 0 or more");
  if (!Number.isInteger(limit) || limit < 1 || limit > EXPORT_PAGE.entities)
    throw new RangeError(`limit must be an integer from 1 to ${EXPORT_PAGE.entities}`);
  const position = sources.position();
  if (!position) return null;
  if (
    expected &&
    (expected.epochGen !== position.epochGen || expected.ownerGen !== position.ownerGen)
  )
    return "stale";
  const { repo, ...at } = position;
  if (kind === "repo") return { ...at, entities: [repo], next: null };
  const entries = sources.entries(kind, after, limit);
  const entities: ExportedEntity[] = [];
  // The page's own JSON, its entities aside (with the longest `next`), then each entity
  // and the comma before it.
  let bytes = sizeOf({ ...at, entities: [], next: Number.MAX_SAFE_INTEGER });
  let last: number | undefined;
  for (const entry of entries) {
    const entity = entry.load();
    const size = sizeOf(entity) + (entities.length > 0 ? 1 : 0);
    if (entities.length > 0 && bytes + size > EXPORT_PAGE.bytes) break;
    entities.push(entity);
    bytes += size;
    last = entry.key;
  }
  const more = entities.length < entries.length || entries.length === limit;
  return { ...at, entities, next: more && last !== undefined ? last : null };
}
