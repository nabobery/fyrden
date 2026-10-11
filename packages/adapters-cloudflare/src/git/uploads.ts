import type { PackId } from "@fyrden/git-core";
import { isNetworkId, newPackId, newUlid, packObjectKey } from "./keys.js";
import type { PackLeases } from "./leases.js";
import type { PackRegistry } from "./pack-registry.js";
import {
  blobOrNull,
  bytesOf,
  countRowsWritten,
  first,
  type GitStorageContext,
  rows,
  run,
} from "./sql.js";
import { discardPendingCommits } from "./sqlite-commit-graph.js";

export type UploadState = "open" | "indexing" | "indexed" | "committed" | "rejected" | "expired";

export interface BeginUpload {
  readonly networkId: string;
  readonly principal: string;
  readonly grantId?: string | null;
  readonly tokenId?: string | null;
  readonly quotaReservationId?: string | null;
  /** The ref-update commands, stored as JSON for the commit and the reaper. */
  readonly commands: unknown;
  readonly atomic: boolean;
  /** False for a delete-only push, which has no pack. */
  readonly withPack: boolean;
  /** Time to live before the reaper aborts it. Proposed default 24 h. */
  readonly ttlMs: number;
  /** How long the index lease lasts before renewal. */
  readonly leaseTtlMs: number;
}

export interface BegunUpload {
  readonly uploadId: string;
  readonly packId: PackId | null;
  readonly r2Key: string | null;
  readonly leaseId: string | null;
  readonly expiresAt: number;
}

export interface UploadRecord {
  readonly uploadId: string;
  readonly packId: PackId | null;
  readonly r2Key: string | null;
  readonly principal: string;
  readonly grantId: string | null;
  readonly tokenId: string | null;
  readonly state: UploadState;
  readonly deps: PackId[];
  readonly expiresAt: number;
}

type RawUpload = {
  upload_id: string;
  pack_id: string | null;
  r2_key: string | null;
  principal: string;
  grant_id: string | null;
  token_id: string | null;
  state: string;
  deps: string;
  expires_at: number;
};

/** Upload proposed default time to live: 24 hours (Proposed; tuned with the reaper). */
export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The id of an upload's resumable index job. Enqueue it with
 * `JobQueue.ensure("index", indexJobId(uploadId), ...)`: while it is queued
 * or running, the orphan reaper leaves the upload alone.
 */
export function indexJobId(uploadId: string): string {
  return `index:${uploadId}`;
}

/**
 * Uploads in flight: one row per push or server-side write. `begin` creates
 * the upload, its `pending` pack row and its index lease in one
 * transaction, before any byte is stored, so every R2 object under the
 * repository's network has a row from the start. The commit itself is the
 * ref store's `commitSync` with `uploadId`.
 */
export class UploadRegistry {
  constructor(
    private readonly context: GitStorageContext,
    private readonly registry: PackRegistry,
    private readonly leases: PackLeases,
    /** Called after each upload begins (the storage schedules the orphan reaper here). */
    private readonly onBegin: (upload: BegunUpload) => void = () => {},
  ) {}

  begin(input: BeginUpload): BegunUpload {
    const { storage } = this.context;
    const now = this.context.now();
    const uploadId = newUlid(now);
    const packId = input.withPack ? newPackId(now) : null;
    const r2Key = packId && packObjectKey(input.networkId, packId, "pack");
    const expiresAt = now + input.ttlMs;
    const outcome = storage.transactionSync(() => {
      let written = run(
        storage,
        `INSERT INTO uploads (upload_id, pack_id, r2_key, principal, grant_id, token_id,
           quota_reservation_id, commands, atomic, state, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
        uploadId,
        packId,
        r2Key,
        input.principal,
        input.grantId ?? null,
        input.tokenId ?? null,
        input.quotaReservationId ?? null,
        JSON.stringify(input.commands),
        input.atomic ? 1 : 0,
        now,
        expiresAt,
      );
      let leaseId: string | null = null;
      if (packId) {
        written += this.registry.createPending({
          packId,
          networkId: input.networkId,
          kind: "receive",
          unitId: uploadId,
          uploadId,
        });
        const grant = this.leases.grant("index", [packId], uploadId, input.leaseTtlMs);
        if (!grant.ok) throw new Error(`could not lease new pack ${packId}: ${grant.reason}`);
        leaseId = grant.leaseId;
      }
      return { leaseId, written };
    });
    countRowsWritten(this.context, "uploads.begin", outcome.written);
    const begun = { uploadId, packId, r2Key, leaseId: outcome.leaseId, expiresAt };
    this.onBegin(begun);
    return begun;
  }

  /**
   * Records the R2 multipart upload id of an open upload. Call it before
   * the first part is uploaded: the binding cannot list incomplete
   * multipart uploads, so a Worker killed mid-upload leaves one only the
   * stored id can abort. Returns false if the upload is not open.
   */
  recordMultipart(uploadId: string, multipartId: string, key?: string): boolean {
    // A multipart upload outside the pack key (a chunked upload's scratch
    // object) is recorded with its key, which the reaper aborts it by.
    if (key !== undefined) {
      const network = first<{ network_id: string }>(
        this.context.storage,
        "SELECT network_id FROM packs WHERE upload_id = ? LIMIT 1",
        uploadId,
      )?.network_id;
      if (!network || !isScratchKeyOf(key, network, uploadId))
        throw new RangeError("a multipart key must be under the upload's scratch prefix");
    }
    const written = run(
      this.context.storage,
      `UPDATE uploads SET multipart_id = ?, r2_key = coalesce(?, r2_key)
       WHERE upload_id = ? AND state = 'open'`,
      multipartId,
      key ?? null,
      uploadId,
    );
    countRowsWritten(this.context, "uploads.multipart", written);
    return written > 0;
  }

  /**
   * Forgets the multipart upload id once the upload is completed (or
   * aborted): there is nothing left for the reaper to abort.
   */
  clearMultipart(uploadId: string): void {
    const written = run(
      this.context.storage,
      "UPDATE uploads SET multipart_id = NULL WHERE upload_id = ? AND multipart_id IS NOT NULL",
      uploadId,
    );
    countRowsWritten(this.context, "uploads.multipart", written);
  }

  /** The recorded multipart upload of an upload, if any. */
  multipartOf(uploadId: string): { key: string; multipartId: string } | undefined {
    const row = first<{ r2_key: string | null; multipart_id: string | null }>(
      this.context.storage,
      "SELECT r2_key, multipart_id FROM uploads WHERE upload_id = ?",
      uploadId,
    );
    return row?.r2_key && row.multipart_id
      ? { key: row.r2_key, multipartId: row.multipart_id }
      : undefined;
  }

  get(uploadId: string): UploadRecord | undefined {
    const raw = first<RawUpload>(
      this.context.storage,
      `SELECT upload_id, pack_id, r2_key, principal, grant_id, token_id, state, deps, expires_at
       FROM uploads WHERE upload_id = ?`,
      uploadId,
    );
    return raw && toRecord(raw);
  }

  /** The bytes are stored: the upload and its pack move to `indexing`. */
  markUploaded(
    uploadId: string,
    fields: { bytes: number; trailerSha?: Uint8Array; multipartId?: string | null },
  ): boolean {
    return this.#step(uploadId, "open", "indexing", "uploads.uploaded", (upload) => {
      const trailer = blobOrNull(fields.trailerSha);
      let written = run(
        this.context.storage,
        "UPDATE uploads SET trailer_sha = ?, multipart_id = coalesce(?, multipart_id) WHERE upload_id = ?",
        trailer,
        fields.multipartId ?? null,
        uploadId,
      );
      if (upload.packId) {
        const moved = this.registry.transition(upload.packId, ["pending"], "indexing", {
          bytes: fields.bytes,
          ...(trailer ? { trailerSha: trailer } : {}),
        });
        if (moved === 0) throw new Error(`pack ${upload.packId} is not pending`);
        written += moved;
      }
      return written;
    });
  }

  /**
   * The request body is stored (in scratch, not at the pack key): the
   * upload moves to `indexing`. Its pack stays `pending` until the indexing
   * job writes it (`R2PackStore.rewritePack`). Returns false if the upload
   * is not open.
   */
  markBodyStored(uploadId: string): boolean {
    return this.#step(uploadId, "open", "indexing", "uploads.body_stored", () => 0);
  }

  /**
   * Replaces the upload's recorded commands (JSON) once the request has
   * been read; the upload must not have committed or ended. Returns false
   * otherwise.
   */
  recordCommands(uploadId: string, commands: unknown): boolean {
    const written = run(
      this.context.storage,
      `UPDATE uploads SET commands = ? WHERE upload_id = ?
         AND state IN ('open', 'indexing', 'indexed')`,
      JSON.stringify(commands),
      uploadId,
    );
    countRowsWritten(this.context, "uploads.commands", written);
    return written > 0;
  }

  /** The upload's recorded commands, parsed; undefined for an unknown upload. */
  commandsOf(uploadId: string): unknown {
    const row = first<{ commands: string }>(
      this.context.storage,
      "SELECT commands FROM uploads WHERE upload_id = ?",
      uploadId,
    );
    return row && (JSON.parse(row.commands) as unknown);
  }

  /**
   * Stores the indexing job's cursor (or clears it with null). A Durable
   * Object row holds at most 2 MB (verified 2026-10-11:
   * https://developers.cloudflare.com/durable-objects/platform/limits/#sql-storage-limits),
   * so callers keep a large cursor elsewhere and store a reference here.
   */
  saveCursor(uploadId: string, cursor: Uint8Array | null): void {
    const written = run(
      this.context.storage,
      "UPDATE uploads SET cursor = ? WHERE upload_id = ?",
      blobOrNull(cursor),
      uploadId,
    );
    countRowsWritten(this.context, "uploads.cursor", written);
  }

  /** The stored cursor, or null. */
  cursorOf(uploadId: string): Uint8Array | null {
    const row = first<{ cursor: ArrayBuffer | null }>(
      this.context.storage,
      "SELECT cursor FROM uploads WHERE upload_id = ?",
      uploadId,
    );
    return row?.cursor ? bytesOf(row.cursor) : null;
  }

  /**
   * Indexing and the connectivity check are done. `deps` are the existing
   * packs the check relied on; the commit refuses if any is gone by then.
   */
  markIndexed(
    uploadId: string,
    fields: { deps: readonly PackId[]; objectCount?: number },
  ): boolean {
    return this.#step(uploadId, "indexing", "indexed", "uploads.indexed", (upload) => {
      let written = run(
        this.context.storage,
        "UPDATE uploads SET deps = ? WHERE upload_id = ?",
        JSON.stringify(fields.deps),
        uploadId,
      );
      if (upload.packId) {
        const pack = this.registry.get(upload.packId);
        for (const member of pack ? this.registry.unitOf(pack) : []) {
          // A pack the push never wrote (an empty pack, an attempt replaced
          // by a later one) is not part of what commits.
          if (member.state === "discarded") continue;
          const moved = this.registry.transition(
            member.packId,
            ["indexing"],
            "indexed",
            member.packId === upload.packId && fields.objectCount !== undefined
              ? { objectCount: fields.objectCount }
              : {},
          );
          if (moved === 0) throw new Error(`pack ${member.packId} is not indexing`);
          written += moved;
        }
      }
      return written;
    });
  }

  /**
   * Ends an upload that will not commit: deletes its pending commit rows,
   * discards its pack unit and releases its leases, in one transaction.
   * Returns the R2 keys to delete (the reaper deletes any the caller does
   * not). Aborting a committed upload is refused.
   */
  abort(uploadId: string, state: "rejected" | "expired" = "rejected"): string[] | undefined {
    const { storage } = this.context;
    const outcome = storage.transactionSync(() => {
      const upload = this.get(uploadId);
      if (!upload || upload.state === "committed") return undefined;
      let written = discardPendingCommits(this.context, uploadId);
      const keys: string[] = [];
      for (const pack of rows<{ pack_id: string; r2_key: string }>(
        storage,
        "SELECT pack_id, r2_key FROM packs WHERE upload_id = ? OR unit_id = ?",
        uploadId,
        uploadId,
      )) {
        written += this.registry.transition(
          pack.pack_id,
          ["pending", "indexing", "indexed"],
          "discarded",
        );
        keys.push(pack.r2_key);
      }
      written += this.leases.releaseHolder(uploadId);
      written += run(storage, "UPDATE uploads SET state = ? WHERE upload_id = ?", state, uploadId);
      return { keys, written };
    });
    if (!outcome) return undefined;
    countRowsWritten(this.context, "uploads.abort", outcome.written);
    return outcome.keys;
  }

  /** Uploads past their time to live that have not committed (for the reaper). */
  expired(limit: number): UploadRecord[] {
    return rows<RawUpload>(
      this.context.storage,
      `SELECT upload_id, pack_id, r2_key, principal, grant_id, token_id, state, deps, expires_at
       FROM uploads WHERE state IN ('open', 'indexing', 'indexed') AND expires_at <= ?
       ORDER BY expires_at LIMIT ?`,
      this.context.now(),
      limit,
    ).map(toRecord);
  }

  #step(
    uploadId: string,
    from: UploadState,
    to: UploadState,
    op: string,
    apply: (upload: UploadRecord) => number,
  ): boolean {
    const { storage } = this.context;
    const written = storage.transactionSync(() => {
      const upload = this.get(uploadId);
      if (!upload || upload.state !== from) return 0;
      return (
        apply(upload) +
        run(storage, "UPDATE uploads SET state = ? WHERE upload_id = ?", to, uploadId)
      );
    });
    countRowsWritten(this.context, op, written);
    return written > 0;
  }
}

/** `net/<network>/scratch/<upload_id>/<name>`, for this upload in its network. */
function isScratchKeyOf(key: string, networkId: string, uploadId: string): boolean {
  const parts = key.split("/");
  return (
    parts.length === 5 &&
    parts[0] === "net" &&
    parts[1] === networkId &&
    isNetworkId(networkId) &&
    parts[2] === "scratch" &&
    parts[3] === uploadId &&
    /^[a-z][a-z0-9-]{0,31}$/.test(parts[4] as string)
  );
}

function toRecord(raw: RawUpload): UploadRecord {
  return {
    uploadId: raw.upload_id,
    packId: raw.pack_id as PackId | null,
    r2Key: raw.r2_key,
    principal: raw.principal,
    grantId: raw.grant_id,
    tokenId: raw.token_id,
    state: raw.state as UploadState,
    deps: JSON.parse(raw.deps) as PackId[],
    expiresAt: raw.expires_at,
  };
}
