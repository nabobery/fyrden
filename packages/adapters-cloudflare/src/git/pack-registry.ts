import type { PackId } from "@fyrden/git-core";
import { packObjectKey } from "./keys.js";
import { first, type GitStorageContext, rows, run } from "./sql.js";

/**
 * Pack states, as in the registry's state machine:
 *
 *   pending     row created before any byte is uploaded
 *   indexing    upload complete, being indexed
 *   indexed     index and connectivity done; can be committed
 *   live        part of the repository (only `RefStore.commit` sets this)
 *   superseded  replaced by compaction or GC; bytes kept until deletion
 *   garbage     holds unreachable objects; can be rescued to live
 *   condemned   no new leases; waiting for deletion
 *   discarded   never committed (aborted, invalid, duplicate)
 *   deleted     R2 objects removed
 */
export type PackState =
  | "pending"
  | "indexing"
  | "indexed"
  | "live"
  | "superseded"
  | "garbage"
  | "condemned"
  | "discarded"
  | "deleted";

export const PACK_KINDS = [
  "receive",
  "insert",
  "compact",
  "gc",
  "garbage",
  "completion",
  "fetch",
] as const;
export type PackKind = (typeof PACK_KINDS)[number];

/** A finished upload: its bytes can be read and it can be committed. */
export const FINISHED_STATES: readonly PackState[] = ["indexing", "indexed"];
/** States whose bytes are in R2 and may be read. */
export const READABLE_STATES: readonly PackState[] = [
  "indexing",
  "indexed",
  "live",
  "superseded",
  "garbage",
  "condemned",
];

export interface PackRow {
  readonly packId: PackId;
  readonly networkId: string;
  readonly r2Key: string;
  readonly kind: PackKind;
  readonly state: PackState;
  readonly bytes: number | null;
  readonly unitId: string | null;
  readonly uploadId: string | null;
}

type RawPackRow = {
  pack_id: string;
  network_id: string;
  r2_key: string;
  kind: string;
  state: string;
  bytes: number | null;
  unit_id: string | null;
  upload_id: string | null;
};

const COLUMNS = "pack_id, network_id, r2_key, kind, state, bytes, unit_id, upload_id";

function toRow(raw: RawPackRow): PackRow {
  return {
    packId: raw.pack_id as PackId,
    networkId: raw.network_id,
    r2Key: raw.r2_key,
    kind: raw.kind as PackKind,
    state: raw.state as PackState,
    bytes: raw.bytes,
    unitId: raw.unit_id,
    uploadId: raw.upload_id,
  };
}

export interface NewPack {
  readonly packId: PackId;
  readonly networkId: string;
  readonly kind: PackKind;
  /** Packs that live and die together (a thin pack and its completion pack). */
  readonly unitId?: string | null;
  readonly uploadId?: string | null;
  /**
   * Where the bytes are stored, when not under the pack prefix (materialised
   * fetch objects). Build it with the key functions in `keys.ts`.
   */
  readonly r2Key?: string;
}

/**
 * The pack registry: which packs exist and in what state. It is the source
 * of truth for what a repository can read. Moving packs to or from `live`
 * belongs to the ref store's commit, so it is not here. Every method is
 * synchronous and is safe to call inside `transactionSync`.
 */
export class PackRegistry {
  constructor(private readonly context: GitStorageContext) {}

  /** Creates a `pending` row. Call before any byte is uploaded. Returns rows written. */
  createPending(pack: NewPack): number {
    if (!PACK_KINDS.includes(pack.kind)) throw new RangeError(`unknown pack kind ${pack.kind}`);
    const now = this.context.now();
    return run(
      this.context.storage,
      `INSERT INTO packs (pack_id, network_id, r2_key, kind, state, unit_id, upload_id,
         created_at, last_touched_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      pack.packId,
      pack.networkId,
      pack.r2Key ?? packObjectKey(pack.networkId, pack.packId, "pack"),
      pack.kind,
      pack.unitId ?? null,
      pack.uploadId ?? null,
      now,
      now,
    );
  }

  get(packId: string): PackRow | undefined {
    const raw = first<RawPackRow>(
      this.context.storage,
      `SELECT ${COLUMNS} FROM packs WHERE pack_id = ?`,
      packId,
    );
    return raw && toRow(raw);
  }

  /** Every pack of a unit, or just the pack when it has no unit. */
  unitOf(pack: PackRow): PackRow[] {
    if (pack.unitId === null) return [pack];
    return rows<RawPackRow>(
      this.context.storage,
      `SELECT ${COLUMNS} FROM packs WHERE unit_id = ? ORDER BY pack_id`,
      pack.unitId,
    ).map(toRow);
  }

  /** Packs in `state`, oldest first. */
  inState(state: PackState): PackRow[] {
    return rows<RawPackRow>(
      this.context.storage,
      `SELECT ${COLUMNS} FROM packs WHERE state = ? ORDER BY created_at, pack_id`,
      state,
    ).map(toRow);
  }

  /**
   * Live packs, newest first (the order lookups and verbatim plans follow),
   * with what a fetch plan needs: the object count recorded at indexing
   * (null when it was not recorded) and the `all_reachable` flag.
   */
  liveForFetch(): (PackRow & { objectCount: number | null; allReachable: boolean })[] {
    return rows<RawPackRow & { object_count: number | null; all_reachable: number }>(
      this.context.storage,
      `SELECT ${COLUMNS}, object_count, all_reachable FROM packs WHERE state = 'live'
       ORDER BY created_at DESC, pack_id DESC`,
    ).map((raw) => ({
      ...toRow(raw),
      objectCount: raw.object_count,
      allReachable: raw.all_reachable === 1,
    }));
  }

  /**
   * The repository's own live packs (borrowed packs excluded), oldest first,
   * with the object count recorded at indexing (null when it was not) and
   * the creation time: what the pack-count cap counts and merges.
   */
  liveOwn(): (PackRow & { objectCount: number | null; createdAt: number })[] {
    return rows<RawPackRow & { object_count: number | null; created_at: number }>(
      this.context.storage,
      `SELECT ${COLUMNS}, object_count, created_at FROM packs
       WHERE state = 'live' AND origin = 'own' ORDER BY created_at, pack_id`,
    ).map((raw) => ({ ...toRow(raw), objectCount: raw.object_count, createdAt: raw.created_at }));
  }

  /**
   * Moves a pack from one of `from` to `to`, recording its size when given.
   * Returns the rows written: 0 (and nothing changed) when the pack is not
   * in one of `from`.
   */
  transition(
    packId: string,
    from: readonly PackState[],
    to: PackState,
    fields: { bytes?: number; objectCount?: number; trailerSha?: ArrayBuffer } = {},
  ): number {
    const now = this.context.now();
    const cursor = this.context.storage.sql.exec(
      `UPDATE packs SET state = ?, last_touched_at = ?,
         bytes = coalesce(?, bytes), object_count = coalesce(?, object_count),
         trailer_sha = coalesce(?, trailer_sha),
         superseded_at = CASE WHEN ? = 'superseded' THEN ? ELSE superseded_at END,
         condemned_at = CASE WHEN ? = 'condemned' THEN ? ELSE condemned_at END
       WHERE pack_id = ? AND state IN (${from.map(() => "?").join(", ")})`,
      to,
      now,
      fields.bytes ?? null,
      fields.objectCount ?? null,
      fields.trailerSha ?? null,
      to,
      now,
      to,
      now,
      packId,
      ...from,
    );
    cursor.toArray();
    return cursor.rowsWritten;
  }
}
