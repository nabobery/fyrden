import {
  type LockHandle,
  newUlid,
  type RefActor,
  type RepoGitStorage,
} from "@fyrden/adapters-cloudflare/git";
import type { Logger } from "@fyrden/adapters-cloudflare/obs";
import { MAX_ASSET_UPLOADS, MAX_RELEASE_ASSETS } from "@fyrden/domain";
import { partLayout } from "../../git/chunked/session.js";
import type { PushDecision } from "../../git/push/commit.js";
import type { RepoEvents } from "./events.js";

/*
 * A repository's release assets: upload sessions, each a multipart upload
 * of its own under a unique key; the assets they made; objects replaced or
 * deleted, retained for 30 days on the account's quota; and the totals the
 * repository states to its account. Nothing about a total is recorded per
 * session: a session's bytes are in every total from the moment it enters
 * `completing`, and it commits only after a checked total since then was
 * taken.
 */

/** The bucket's name in metrics. */
export const ASSETS_BUCKET = "fyrden-assets";
/** The job that ends expired sessions, purges retained objects and tells the account its total. */
export const RELEASE_ASSETS_JOB = "release_assets";

/** Proposed values. */
export const RELEASE_ASSET_POLICY = {
  /** A session's life: 2 GiB at about 200 kbit/s; under R2's 7-day abort, so the DO gets there first. */
  sessionMs: 24 * 60 * 60 * 1000,
  /** How long after a completion is sent to R2 it may still land. */
  settleMs: 120_000,
  /** How long a replaced or deleted object is kept, and how far back a restore reaches. */
  retainMs: 30 * 24 * 60 * 60 * 1000,
  /** The completion lock: an R2 call can outlast it, so a token decides the outcome. */
  completeLockMs: 60_000,
  /** Retained objects purged a slice (one R2 delete). */
  purgeBatch: 50,
  /** Sessions ended or cleared a slice. */
  sessionBatch: 20,
  /** Open sessions a deletion aborts a call (each an R2 call of the object's own). */
  settleBatch: 100,
  /** A session's parts at most. */
  maxParts: 2_000,
  /** The stored part list's UTF-8 JSON at most, under SQLite's 2 MB row limit. */
  maxPartsJsonBytes: 1.5 * 1024 * 1024,
  /** How soon an untold total is sent again. */
  statementRetryMs: 60_000,
  /** How long a frozen repository's slice sleeps at most: also the most a purge waits after landing. */
  frozenWakeMs: 60 * 60 * 1000,
};

export const assetKey = (repoId: string, objectId: string) =>
  `release-assets/${repoId}/${objectId}`;
/** The account hold of a session's reservation. */
export const assetHoldId = (uploadId: string) => `release-asset:${uploadId}`;

export type AssetFailure = {
  readonly ok: false;
  readonly status: 403 | 404 | 409 | 410 | 422 | 503;
  readonly code: string;
  readonly error: string;
};

const fail = (status: AssetFailure["status"], code: string, error: string): AssetFailure => ({
  ok: false,
  status,
  code,
  error,
});

const NO_UPLOAD = fail(404, "upload_not_found", "No such upload session.");

export interface AssetRecord {
  readonly id: number;
  readonly releaseId: number;
  readonly name: string;
  readonly contentType: string;
  readonly objectId: string;
  readonly bytes: number;
  readonly uploader: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type UploadState = "receiving" | "completing" | "completed" | "aborted";

export interface UploadView {
  readonly uploadId: string;
  readonly releaseId: number;
  readonly name: string;
  readonly contentType: string;
  readonly bytes: number;
  readonly partBytes: number;
  readonly partCount: number;
  readonly state: UploadState;
  readonly expiresAt: number;
  /** The asset it made, once `completed`. */
  readonly asset?: AssetRecord;
}

export type UploadAnswer = { ok: true; view: UploadView } | AssetFailure;

/** What a part's request needs: where to send it. */
export type PartTarget =
  | { ok: true; key: string; multipartId: string; partNumber: number }
  | AssetFailure;

/** What the account answered a total with (see `OrgDO.setReleaseAssetStorage`). */
export type StatementAnswer = "ok" | "stale" | "no_room" | "not_here";

export interface AssetCaller {
  readonly principal: string;
  readonly tokenId: string;
  readonly grantId: string | null;
  /** Whether the caller writes the repository now (its role, read with no await before). */
  readonly writes: () => boolean;
  /**
   * Whether the repository changed owner since the caller's roles were
   * pulled: its snapshot is the new account's, or none, so `writes` can't
   * say. A completion is then asked again, not refused.
   */
  readonly moved?: () => boolean;
}

type UploadRow = {
  upload_id: string;
  release_id: number;
  name: string;
  name_fold: string;
  content_type: string;
  replace_existing: number;
  bytes: number;
  part_bytes: number;
  object_id: string;
  multipart_id: string;
  principal: string;
  token_id: string;
  grant_id: string | null;
  epoch_gen: number;
  completion_token: string | null;
  parts: string | null;
  settle_after: number | null;
  state: UploadState;
  created_at: number;
  expires_at: number;
};

type AssetRow = {
  id: number;
  release_id: number;
  name: string;
  name_fold: string;
  content_type: string;
  object_id: string;
  bytes: number;
  uploader: string;
  created_at: number;
  updated_at: number;
};

type Counters = {
  asset_bytes: number;
  usage_seq: number;
  told_seq: number;
  retain_until: number | null;
  early_purge_at: number | null;
};

export interface AssetHooks {
  /** Between each step of a completion, by name. For tests. */
  step?: (step: "listed" | "stated" | "sending" | "sent" | "decided") => Promise<void> | void;
}

const assetOf = (row: AssetRow): AssetRecord => ({
  id: row.id,
  releaseId: row.release_id,
  name: row.name,
  contentType: row.content_type,
  objectId: row.object_id,
  bytes: row.bytes,
  uploader: row.uploader,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** An R2 error's code, as its message ends: `... (10024)`. */
export function r2Code(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const code = /\((\d{5})\)/.exec(message)?.[1];
  if (code) return Number(code);
  return /does not exist/.test(message) ? 10024 : undefined;
}

const utf8 = new TextEncoder();

export class RepoReleaseAssets {
  constructor(
    private readonly deps: {
      readonly git: RepoGitStorage;
      readonly events: RepoEvents;
      readonly bucket: () => R2Bucket;
      readonly repoId: () => string;
      /** Why no change is taken now, or undefined. */
      readonly writeRefusal: () => { status: 404 | 409; code: string; error: string } | undefined;
      /** States the total to the account the repository belongs to now. */
      readonly state: (input: {
        readonly bytes: number;
        readonly epochGen: number;
        readonly seq: number;
        readonly mustFit: boolean;
        readonly dropReservations?: readonly string[];
      }) => Promise<StatementAnswer>;
      /** Frees a session's reservation, best effort. */
      readonly releaseHold: (holdId: string) => Promise<void>;
      readonly hooks: () => AssetHooks;
      readonly log: () => Logger;
    },
  ) {}

  // Reads.

  /** The assets of releases `releaseIds`, by release, each in name order. */
  ofReleases(releaseIds: readonly number[]): Map<number, AssetRecord[]> {
    const out = new Map<number, AssetRecord[]>();
    if (releaseIds.length === 0) return out;
    for (const row of this.#exec<AssetRow>(
      `SELECT * FROM release_assets WHERE release_id IN (SELECT value FROM json_each(?))
       ORDER BY release_id, name_fold`,
      JSON.stringify(releaseIds),
    )) {
      const list = out.get(row.release_id) ?? [];
      list.push(assetOf(row));
      out.set(row.release_id, list);
    }
    return out;
  }

  get(id: number): AssetRecord | undefined {
    const [row] = this.#exec<AssetRow>("SELECT * FROM release_assets WHERE id = ?", id);
    return row && assetOf(row);
  }

  /** The asset of release `releaseId` named `fold` (its folded name). */
  byName(releaseId: number, fold: string): AssetRecord | undefined {
    const [row] = this.#exec<AssetRow>(
      "SELECT * FROM release_assets WHERE release_id = ? AND name_fold = ?",
      releaseId,
      fold,
    );
    return row && assetOf(row);
  }

  /** What is retained: objects, their bytes, and when the next one is due. */
  retained(): { objects: number; bytes: number; nextPurgeAt: number | null } {
    const [row] = this.#exec<{ n: number; bytes: number }>(
      "SELECT count(*) AS n, coalesce(sum(bytes), 0) AS bytes FROM release_asset_retained",
    );
    return { objects: row?.n ?? 0, bytes: row?.bytes ?? 0, nextPurgeAt: this.#nextPurgeAt() };
  }

  /** The bytes counted now: assets and retained objects, and sessions in `completing`. */
  total(): number {
    const [row] = this.#exec<{ n: number }>(
      `SELECT (SELECT asset_bytes FROM release_asset_counters WHERE id = 1)
         + (SELECT coalesce(sum(bytes), 0) FROM release_asset_uploads WHERE state = 'completing')
         AS n`,
    );
    return row?.n ?? 0;
  }

  counters(): Counters {
    return this.#exec<Counters>(
      "SELECT asset_bytes, usage_seq, told_seq, retain_until, early_purge_at FROM release_asset_counters WHERE id = 1",
    )[0] as Counters;
  }

  // Sessions.

  /** What a begin checks before it creates the multipart upload (and again after). */
  beginRefusal(input: {
    readonly releaseId: number;
    readonly fold: string;
    readonly replace: boolean;
  }): AssetFailure | undefined {
    if (this.#exec("SELECT 1 FROM releases WHERE id = ?", input.releaseId).length === 0)
      return fail(404, "release_not_found", "The repository has no such release.");
    const existing = this.byName(input.releaseId, input.fold);
    if (existing && !input.replace)
      return fail(
        422,
        "asset_name_taken",
        "The release has an asset of that name. Send replace to replace it.",
      );
    if (!existing && this.#assetCount(input.releaseId) >= MAX_RELEASE_ASSETS)
      return fail(422, "too_many_assets", `A release holds at most ${MAX_RELEASE_ASSETS} assets.`);
    const [open] = this.#exec<{ n: number }>(
      "SELECT count(*) AS n FROM release_asset_uploads WHERE state IN ('receiving', 'completing')",
    );
    if ((open?.n ?? 0) >= MAX_ASSET_UPLOADS)
      return fail(
        409,
        "too_many_uploads",
        `The repository has ${MAX_ASSET_UPLOADS} uploads open. Finish or abort one first.`,
      );
    return undefined;
  }

  /** A fresh object and its multipart upload, for a begin to record. */
  async createUpload(): Promise<{ objectId: string; multipartId: string }> {
    const objectId = newUlid(this.#now());
    this.#count("r2.class_a", "create_multipart");
    const upload = await this.deps
      .bucket()
      .createMultipartUpload(assetKey(this.deps.repoId(), objectId));
    return { objectId, multipartId: upload.uploadId };
  }

  /** Aborts a multipart upload no row names, best effort. */
  async dropUpload(created: { objectId: string; multipartId: string }): Promise<void> {
    try {
      this.#count("r2.class_a", "abort_multipart");
      await this.deps
        .bucket()
        .resumeMultipartUpload(assetKey(this.deps.repoId(), created.objectId), created.multipartId)
        .abort();
    } catch (error) {
      this.deps.log().warn("aborting an unrecorded asset upload failed", { error });
    }
  }

  /**
   * Records a session for the upload `created` made, rechecking release,
   * name and sessions in one transaction; the job is ensured at its expiry.
   */
  begin(
    input: {
      readonly releaseId: number;
      readonly name: string;
      readonly fold: string;
      readonly contentType: string;
      readonly bytes: number;
      readonly partBytes: number;
      readonly replace: boolean;
    },
    caller: AssetCaller,
    created: { objectId: string; multipartId: string },
  ): UploadAnswer {
    if (!caller.writes()) return fail(403, "forbidden", "Uploading assets takes write access.");
    const refused = this.beginRefusal(input);
    if (refused) return refused;
    const now = this.#now();
    const uploadId = newUlid(now);
    const expiresAt = now + RELEASE_ASSET_POLICY.sessionMs;
    this.#storage().transactionSync(() => {
      this.#exec(
        `INSERT INTO release_asset_uploads (upload_id, release_id, name, name_fold, content_type,
           replace_existing, bytes, part_bytes, object_id, multipart_id, principal, token_id,
           grant_id, epoch_gen, state, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'receiving', ?, ?)`,
        uploadId,
        input.releaseId,
        input.name,
        input.fold,
        input.contentType,
        input.replace ? 1 : 0,
        input.bytes,
        input.partBytes,
        created.objectId,
        created.multipartId,
        caller.principal,
        caller.tokenId,
        caller.grantId,
        this.deps.events.epochGen(),
        now,
        expiresAt,
      );
      this.#ensureJob(expiresAt);
    });
    return { ok: true, view: this.#view(this.#row(uploadId) as UploadRow) };
  }

  /** A session's view, for its principal. */
  view(uploadId: string, principal: string): UploadAnswer {
    const row = this.#row(uploadId);
    if (!row || row.principal !== principal) return NO_UPLOAD;
    return { ok: true, view: this.#view(row) };
  }

  /**
   * Where part `part` of `length` bytes goes, if the session takes it now:
   * a read, writing nothing. Each part has its own number, 1 to n, and an
   * upload again replaces it.
   */
  partTarget(uploadId: string, principal: string, part: number, length: number): PartTarget {
    const row = this.#row(uploadId);
    if (!row || row.principal !== principal) return NO_UPLOAD;
    const refused = this.deps.writeRefusal();
    if (refused) return fail(refused.status, refused.code, refused.error);
    if (row.epoch_gen !== this.deps.events.epochGen())
      return fail(409, "upload_aborted", "The upload was ended. Start it again.");
    if (row.state !== "receiving")
      return fail(409, "upload_not_receiving", "The upload takes no more parts.");
    if (row.expires_at <= this.#now())
      return fail(410, "upload_expired", "The upload session has expired.");
    const layout = partLayout(row.bytes, row.part_bytes);
    if (!Number.isSafeInteger(part) || part < 1 || part > layout.partCount)
      return fail(422, "invalid_part", `Parts are numbered 1 to ${layout.partCount}.`);
    const wanted = layout.lengthOf(part);
    if (length !== wanted)
      return fail(422, "invalid_part_length", `Part ${part} must be exactly ${wanted} bytes.`);
    return {
      ok: true,
      key: assetKey(this.deps.repoId(), row.object_id),
      multipartId: row.multipart_id,
      partNumber: part,
    };
  }

  /** Ends a session: its multipart upload aborted, its key deleted if it may hold an object. */
  async abort(uploadId: string, principal: string): Promise<UploadAnswer> {
    const row = this.#row(uploadId);
    if (!row || row.principal !== principal) return NO_UPLOAD;
    if (row.state === "completed")
      return fail(409, "upload_completed", "The upload made its asset already.");
    if (row.state !== "aborted") this.#end(row);
    // Read before R2 is asked: the job may clear the ended row meanwhile.
    const view = this.#view(this.#row(uploadId) as UploadRow);
    await this.#letGo(row);
    return { ok: true, view };
  }

  /**
   * Completes a session with the parts the client stored (§ completion):
   * the lock, the list stored once, a checked total, R2's assembly, then
   * the outcome, decided only by the holder of the session's token.
   */
  async complete(input: {
    readonly uploadId: string;
    readonly caller: AssetCaller;
    readonly parts: readonly { readonly partNumber: number; readonly etag: string }[];
    readonly decision: PushDecision;
  }): Promise<UploadAnswer> {
    const { uploadId, caller } = input;
    const lock = this.deps.git.locks.tryAcquire(
      `release-asset-complete:${uploadId}`,
      caller.principal,
      RELEASE_ASSET_POLICY.completeLockMs,
    );
    const current = this.#row(uploadId);
    if (!current || current.principal !== caller.principal) {
      if (lock) this.deps.git.locks.release(lock);
      return NO_UPLOAD;
    }
    if (!lock)
      return (
        this.#settled(current, caller) ?? {
          ok: true,
          view: { ...this.#view(current), state: "completing" },
        }
      );
    try {
      return await this.#complete(lock, current, input);
    } finally {
      this.deps.git.locks.release(lock);
    }
  }

  async #complete(
    lock: LockHandle,
    row: UploadRow,
    input: Parameters<RepoReleaseAssets["complete"]>[0],
  ): Promise<UploadAnswer> {
    const { caller } = input;
    const hooks = this.deps.hooks();
    const settled = this.#settled(row, caller);
    if (settled) return settled;
    // A restored session never deletes a key, whatever its state: a later state may name it.
    if (row.epoch_gen !== this.deps.events.epochGen()) {
      this.#end(row);
      await this.#letGo(row);
      return fail(409, "upload_aborted", "The upload was ended by a restore. Start it again.");
    }
    if (row.state === "receiving") {
      if (row.expires_at <= this.#now())
        return fail(410, "upload_expired", "The upload session has expired.");
      const refused = this.#refusal();
      if (refused) return refused;
      const listed = this.#listProblem(row, input.parts);
      if (listed) return listed;
      this.#storage().transactionSync(() =>
        this.#exec(
          `UPDATE release_asset_uploads SET state = 'completing', parts = ?, completion_token = ?
           WHERE upload_id = ? AND state = 'receiving'`,
          JSON.stringify(input.parts),
          lock.token,
          row.upload_id,
        ),
      );
    } else {
      // A retry after the lock lapsed: the earlier holder is fenced, and its list is the one.
      this.#exec(
        "UPDATE release_asset_uploads SET completion_token = ? WHERE upload_id = ?",
        lock.token,
        row.upload_id,
      );
    }
    await hooks.step?.("listed");

    // The fit: the total, this session in it, checked before anything commits.
    const refusedNow = this.#refusal();
    if (refusedNow) return refusedNow;
    const stated = await this.#stateTotal({ mustFit: true });
    await hooks.step?.("stated");
    if (stated === "no_room")
      return this.#refuse(
        lock,
        row,
        fail(403, "quota_exceeded", "The account's storage quota has no room for this asset."),
      );
    if (stated === "stale") return this.#completing(row.upload_id);
    if (stated !== "ok")
      return fail(503, "quota_unavailable", "The storage quota couldn't be checked. Try again.");

    // The assembly, sent only while the token is still ours and the session still lives.
    const sending = this.#storage().transactionSync(() => {
      const now = this.#now();
      const fresh = this.#row(row.upload_id);
      if (
        !fresh ||
        fresh.completion_token !== lock.token ||
        fresh.state !== "completing" ||
        fresh.epoch_gen !== this.deps.events.epochGen() ||
        fresh.expires_at <= now
      )
        return undefined;
      this.#exec(
        "UPDATE release_asset_uploads SET settle_after = ? WHERE upload_id = ?",
        now + RELEASE_ASSET_POLICY.settleMs,
        row.upload_id,
      );
      return fresh;
    });
    if (!sending) return this.#completing(row.upload_id);
    await hooks.step?.("sending");
    const assembled = await this.#assemble(sending);
    await hooks.step?.("sent");
    if (assembled === "retry") return this.#completing(row.upload_id);
    if (assembled !== "done") return this.#refuse(lock, row, assembled);

    // The outcome, decided by the token's holder only.
    const decided = this.#decide(lock, sending, input.decision, caller);
    await hooks.step?.("decided");
    if (decided === "not_ours") return this.#completing(row.upload_id);
    // A transfer isn't a refusal of the upload: its bytes travel in the total, and it commits after.
    if (decided?.code === "release_asset_transferring") return decided;
    if (decided) return this.#refuse(lock, row, decided);
    return { ok: true, view: this.#view(this.#row(row.upload_id) as UploadRow) };
  }

  /** The answer no completion changes: another token's, or a session that ended. */
  #settled(row: UploadRow, caller: AssetCaller): UploadAnswer | undefined {
    if (row.token_id !== caller.tokenId)
      return fail(409, "wrong_token", "Complete the upload with the token that started it.");
    if (row.state === "completed") return { ok: true, view: this.#view(row) };
    if (row.state === "aborted")
      return fail(409, "upload_aborted", "The upload was ended. Start it again.");
    return undefined;
  }

  /** The part list's problem, if any: checked before the session takes it. */
  #listProblem(
    row: UploadRow,
    parts: readonly { readonly partNumber: number; readonly etag: string }[],
  ): AssetFailure | undefined {
    const { partCount } = partLayout(row.bytes, row.part_bytes);
    const bad = (why: string) => fail(422, "invalid_parts", why);
    if (parts.length !== partCount)
      return bad(`The upload has ${partCount} parts; send each once.`);
    for (const [index, part] of parts.entries()) {
      if (part.partNumber !== index + 1) return bad("List the parts by number, 1 to n, in order.");
      if (typeof part.etag !== "string" || part.etag.length === 0)
        return bad(`Part ${part.partNumber} has no etag.`);
    }
    if (utf8.encode(JSON.stringify(parts)).length > RELEASE_ASSET_POLICY.maxPartsJsonBytes)
      return bad("The part list is too long.");
    return undefined;
  }

  /** R2's assembly by the stored list: `done`, a refusal (the session ends), or `retry`. */
  async #assemble(row: UploadRow): Promise<"done" | "retry" | AssetFailure> {
    const key = assetKey(this.deps.repoId(), row.object_id);
    const parts = JSON.parse(row.parts ?? "[]") as { partNumber: number; etag: string }[];
    const mismatch = fail(422, "size_mismatch", "The parts don't add up to the declared size.");
    const invalid = fail(422, "invalid_parts", "A part's etag or size is wrong. Upload it again.");
    try {
      this.#count("r2.class_a", "complete_multipart");
      const object = await this.deps
        .bucket()
        .resumeMultipartUpload(key, row.multipart_id)
        .complete(parts);
      return object.size === row.bytes ? "done" : mismatch;
    } catch (error) {
      const code = r2Code(error);
      if (code === 10024) {
        // Gone: done if an object of the right size is there (another holder's assembly).
        this.#count("r2.class_b", "head_asset");
        const object = await this.deps
          .bucket()
          .head(key)
          .catch(() => undefined);
        if (object === undefined) return "retry";
        if (object === null) return fail(409, "upload_lost", "The upload is gone. Start it again.");
        return object.size === row.bytes ? "done" : mismatch;
      }
      if (code === 10025 || code === 10048 || code === 10011) return invalid;
      this.deps.log().warn("assembling a release asset failed", { error, code });
      return "retry";
    }
  }

  /**
   * In one transaction with no await: whether the session's object becomes
   * its asset. `not_ours` when another holder took the token, or the
   * session ended, which touches nothing; a refusal ends it.
   */
  #decide(
    lock: LockHandle,
    row: UploadRow,
    decision: PushDecision,
    caller: AssetCaller,
  ): "not_ours" | AssetFailure | undefined {
    return this.#storage().transactionSync(() => {
      const fresh = this.#row(row.upload_id);
      if (!fresh || fresh.completion_token !== lock.token || fresh.state !== "completing")
        return "not_ours" as const;
      const refused = this.deps.writeRefusal();
      if (refused?.code === "repo_transferring") return this.#transferring();
      if (refused) return fail(refused.status, refused.code, refused.error);
      if (decision.refusal !== undefined) return fail(403, "access_lost", decision.refusal);
      if (fresh.epoch_gen !== this.deps.events.epochGen())
        return fail(409, "upload_aborted", "The upload was ended by a restore. Start it again.");
      if (caller.moved?.()) return this.#transferring();
      if (!caller.writes()) return fail(403, "access_lost", "You no longer write this repository.");
      if (this.#exec("SELECT 1 FROM releases WHERE id = ?", fresh.release_id).length === 0)
        return fail(404, "release_not_found", "The release was deleted.");
      const existing = this.byName(fresh.release_id, fresh.name_fold);
      if (existing && fresh.replace_existing !== 1)
        return fail(422, "asset_name_taken", "The release has an asset of that name now.");
      if (!existing && this.#assetCount(fresh.release_id) >= MAX_RELEASE_ASSETS)
        return fail(
          422,
          "too_many_assets",
          `A release holds at most ${MAX_RELEASE_ASSETS} assets.`,
        );
      const now = this.#now();
      if (existing) {
        this.#retain(existing.objectId, existing.bytes, now);
        this.#exec(
          `UPDATE release_assets SET name = ?, content_type = ?, object_id = ?, bytes = ?,
             uploader = ?, updated_at = ? WHERE id = ?`,
          fresh.name,
          fresh.content_type,
          fresh.object_id,
          fresh.bytes,
          fresh.principal,
          now,
          existing.id,
        );
      } else
        this.#exec(
          `INSERT INTO release_assets (release_id, name, name_fold, content_type, object_id, bytes,
             uploader, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          fresh.release_id,
          fresh.name,
          fresh.name_fold,
          fresh.content_type,
          fresh.object_id,
          fresh.bytes,
          fresh.principal,
          now,
          now,
        );
      // Its bytes join the assets as the session leaves the `completing` sum: no total is owed.
      this.#exec(
        "UPDATE release_asset_counters SET asset_bytes = asset_bytes + ? WHERE id = 1",
        fresh.bytes,
      );
      this.#exec(
        "UPDATE release_asset_uploads SET state = 'completed' WHERE upload_id = ?",
        fresh.upload_id,
      );
      this.deps.events.auditChange(
        existing ? "release_asset.replace" : "release_asset.upload",
        {
          principal: fresh.principal,
          grantId: fresh.grant_id,
          tokenId: fresh.token_id,
          actChain: decision.actChain ?? [],
          requestId: decision.requestId ?? null,
          via: "api",
        },
        { release: fresh.release_id, asset: fresh.name, bytes: fresh.bytes },
      );
      return undefined;
    });
  }

  /**
   * A refusal by the token's holder from `completing` on: the session ends
   * (its bytes leave the total), then its upload, key and hold are let go.
   */
  async #refuse(lock: LockHandle, row: UploadRow, refusal: AssetFailure): Promise<UploadAnswer> {
    const ended = this.#storage().transactionSync(() => {
      const fresh = this.#row(row.upload_id);
      if (!fresh || fresh.completion_token !== lock.token || fresh.state !== "completing")
        return undefined;
      this.#end(fresh);
      return fresh;
    });
    if (!ended) return this.#completing(row.upload_id);
    await this.#letGo(ended);
    return refusal;
  }

  /** Answers a session as `completing`: a later holder decides, and the client calls again. */
  #completing(uploadId: string): UploadAnswer {
    const row = this.#row(uploadId);
    if (!row) return NO_UPLOAD;
    if (row.state === "aborted")
      return fail(409, "upload_aborted", "The upload was ended. Start it again.");
    return {
      ok: true,
      view: { ...this.#view(row), state: row.state === "completed" ? "completed" : "completing" },
    };
  }

  #transferring(): AssetFailure {
    return fail(
      409,
      "release_asset_transferring",
      "The repository is being transferred. Complete the upload again once it lands.",
    );
  }

  /** Why a session's completion is refused now (a transfer apart), or undefined. */
  #refusal(): AssetFailure | undefined {
    const refused = this.deps.writeRefusal();
    if (refused?.code === "repo_transferring") return this.#transferring();
    return refused && fail(refused.status, refused.code, refused.error);
  }

  /**
   * In a transaction: the session ends. Its bytes leave the total if it was
   * `completing`; a total is owed either way, which the job sends.
   */
  #end(row: UploadRow): boolean {
    return this.#storage().transactionSync(() => {
      const ended = this.#storage().sql.exec(
        "UPDATE release_asset_uploads SET state = 'aborted' WHERE upload_id = ? AND state IN ('receiving', 'completing')",
        row.upload_id,
      ).rowsWritten;
      this.#bump();
      this.#ensureJob();
      return ended > 0;
    });
  }

  /**
   * After a session ended: its multipart upload aborted, its key deleted
   * if of the current generation (a restored one's may be named by a later
   * state), its hold freed; each best effort, the job doing the rest.
   */
  async #letGo(row: UploadRow): Promise<void> {
    const key = assetKey(this.deps.repoId(), row.object_id);
    try {
      this.#count("r2.class_a", "abort_multipart");
      await this.deps.bucket().resumeMultipartUpload(key, row.multipart_id).abort();
    } catch (error) {
      if (r2Code(error) !== 10024)
        this.deps.log().warn("aborting a release asset upload failed", { error });
    }
    if (row.epoch_gen === this.deps.events.epochGen()) {
      this.#count("r2.class_a", "delete_unfinished");
      await this.deps
        .bucket()
        .delete(key)
        .catch((error: unknown) =>
          this.deps.log().warn("deleting an unfinished release asset failed", { error }),
        );
    }
    await this.deps.releaseHold(assetHoldId(row.upload_id)).catch(() => undefined);
  }

  // Assets.

  /** Deletes an asset: its object retained for 30 days, still counted. */
  deleteAsset(id: number, actor: RefActor): { ok: true } | AssetFailure {
    const asset = this.get(id);
    if (!asset) return fail(404, "asset_not_found", "The repository has no such asset.");
    this.#storage().transactionSync(() => {
      this.#retain(asset.objectId, asset.bytes, this.#now());
      this.#exec("DELETE FROM release_assets WHERE id = ?", id);
      this.deps.events.auditChange("release_asset.delete", actor, {
        release: asset.releaseId,
        asset: asset.name,
      });
      this.#ensureJob();
    });
    return { ok: true };
  }

  /**
   * In a release's deleting transaction: its assets' objects retained, still
   * counted, and its open sessions left for the job to end.
   */
  retainRelease(releaseId: number): void {
    const now = this.#now();
    const assets = this.#exec<AssetRow>(
      "SELECT * FROM release_assets WHERE release_id = ?",
      releaseId,
    );
    for (const asset of assets) this.#retain(asset.object_id, asset.bytes, now);
    this.#exec("DELETE FROM release_assets WHERE release_id = ?", releaseId);
    // Its open sessions can't commit now: the job ends them, as it ends expired ones.
    const open = this.#exec(
      "SELECT 1 FROM release_asset_uploads WHERE release_id = ? AND state IN ('receiving', 'completing') LIMIT 1",
      releaseId,
    );
    if (assets.length > 0 || open.length > 0) this.#ensureJob();
  }

  /** In a transaction: an object kept for 30 days from `now`, its bytes still in `asset_bytes`. */
  #retain(objectId: string, bytes: number, now: number): void {
    this.#exec(
      `INSERT INTO release_asset_retained (object_id, bytes, purge_after) VALUES (?, ?, ?)
       ON CONFLICT (object_id) DO NOTHING`,
      objectId,
      bytes,
      now + RELEASE_ASSET_POLICY.retainMs,
    );
  }

  /**
   * Asks for every object retained before now to go early, past the restore
   * fence; refused while the repository takes no change. The job purges
   * them; their bytes leave the total only after R2.
   */
  purgeEarly(actor: RefActor): { ok: true; objects: number; bytes: number } | AssetFailure {
    const refused = this.deps.writeRefusal();
    if (refused) return fail(refused.status, refused.code, refused.error);
    return this.#storage().transactionSync(() => {
      const now = this.#now();
      const covered = this.#exec<{ n: number; bytes: number }>(
        `SELECT count(*) AS n, coalesce(sum(bytes), 0) AS bytes FROM release_asset_retained
         WHERE purge_after < ?`,
        now + RELEASE_ASSET_POLICY.retainMs,
      )[0] ?? { n: 0, bytes: 0 };
      this.#exec("UPDATE release_asset_counters SET early_purge_at = ? WHERE id = 1", now);
      this.deps.events.auditChange("release_asset.purge", actor, {
        objects: covered.n,
        bytes: covered.bytes,
      });
      this.#ensureJob();
      return { ok: true as const, objects: covered.n, bytes: covered.bytes };
    });
  }

  // The account.

  /**
   * States the total to the account: read, with `usage_seq` bumped, in one
   * transaction, so a tuple names one total; `told_seq` moves only to a
   * tuple the account took. The total counts every `completing` session, so
   * their holds are named to be left out and let go, each counted once.
   */
  async #stateTotal(options: { mustFit: boolean }): Promise<StatementAnswer | "failed"> {
    const statement = this.#storage().transactionSync(() => {
      this.#bump();
      return {
        bytes: this.total(),
        seq: this.counters().usage_seq,
        epochGen: this.deps.events.epochGen(),
        dropReservations: this.#exec<{ upload_id: string }>(
          "SELECT upload_id FROM release_asset_uploads WHERE state = 'completing'",
        ).map((row) => assetHoldId(row.upload_id)),
      };
    });
    let answer: StatementAnswer;
    try {
      answer = await this.deps.state({ ...statement, ...options });
    } catch (error) {
      this.deps.log().warn("stating release assets' storage failed", { error });
      return "failed";
    }
    if (answer === "ok")
      this.#exec(
        "UPDATE release_asset_counters SET told_seq = max(told_seq, ?) WHERE id = 1",
        statement.seq,
      );
    return answer;
  }

  /**
   * For a transfer's arrival: the total, every `completing` session in it,
   * under a tuple of its own. While frozen nothing enters `completing` or
   * commits, so it can only fall, which a later statement corrects.
   */
  usage(): { bytes: number; epochGen: number; seq: number } {
    return this.#storage().transactionSync(() => {
      this.#bump();
      return {
        bytes: this.total(),
        epochGen: this.deps.events.epochGen(),
        seq: this.counters().usage_seq,
      };
    });
  }

  /**
   * The restore hook, in the transaction taking the new generation (also
   * for a repository being deleted): states that may name a retained
   * object reach 30 days back from now, and the total is told again.
   */
  restored(): void {
    this.#exec(
      `UPDATE release_asset_counters SET retain_until = ?, usage_seq = usage_seq + 1
       WHERE id = 1`,
      this.#now() + RELEASE_ASSET_POLICY.retainMs,
    );
  }

  // Deletion.

  /**
   * For the repository's deletion, once it is frozen (no part, begin or
   * completion is taken): aborts up to `settleBatch` open sessions a call
   * (`more` while any remain); then `wait` while a completion sent to R2
   * may still land (`settle_after`, a completed session's too), and until
   * that long after the last restore, which can rewind a row to before its
   * `settle_after` was set; then deletes ended sessions' keys by name.
   * `settled` once nothing can make an object any more.
   */
  async settle(): Promise<"more" | "wait" | "settled"> {
    const open = this.#exec<UploadRow>(
      `SELECT * FROM release_asset_uploads WHERE state IN ('receiving', 'completing') LIMIT ?`,
      RELEASE_ASSET_POLICY.settleBatch + 1,
    );
    for (const row of open.slice(0, RELEASE_ASSET_POLICY.settleBatch)) {
      this.#end(row);
      try {
        this.#count("r2.class_a", "abort_multipart");
        await this.deps
          .bucket()
          .resumeMultipartUpload(assetKey(this.deps.repoId(), row.object_id), row.multipart_id)
          .abort();
      } catch (error) {
        if (r2Code(error) !== 10024)
          this.deps.log().warn("aborting a release asset upload failed", { error });
      }
    }
    if (open.length > RELEASE_ASSET_POLICY.settleBatch) return "more";
    const now = this.#now();
    const [landing] = this.#exec<{ n: number }>(
      "SELECT count(*) AS n FROM release_asset_uploads WHERE settle_after > ?",
      now,
    );
    if ((landing?.n ?? 0) > 0) return "wait";
    const { retain_until: retainUntil } = this.counters();
    if (
      retainUntil !== null &&
      retainUntil - RELEASE_ASSET_POLICY.retainMs + RELEASE_ASSET_POLICY.settleMs > now
    )
      return "wait";
    const ended = this.#exec<UploadRow>(
      "SELECT * FROM release_asset_uploads WHERE state IN ('completing', 'aborted')",
    );
    if (ended.length > 0) {
      this.#count("r2.class_a", "delete_unfinished");
      await this.deps
        .bucket()
        .delete(ended.map((row) => assetKey(this.deps.repoId(), row.object_id)));
      this.#exec(
        "DELETE FROM release_asset_uploads WHERE upload_id IN (SELECT value FROM json_each(?))",
        JSON.stringify(ended.map((row) => row.upload_id)),
      );
    }
    return "settled";
  }

  /** In a transfer's landing transaction: a total is owed to the new account. */
  landed(): void {
    this.#bump();
    this.#ensureJob();
  }

  // The job.

  /**
   * One slice: expired sessions ended, ended ones cleared once nothing can
   * land, due retained objects purged (not while frozen), and the total
   * told if it isn't; then when to run again, read with no await before
   * the job records it.
   */
  async slice(): Promise<{ done: true } | { done: false; runAfterMs: number }> {
    await this.#expire();
    await this.#clear();
    if (!this.#frozen()) await this.#purge();
    if (this.#untold()) await this.#stateTotal({ mustFit: false });
    const next = this.#nextRun();
    if (next === null) return { done: true };
    return { done: false, runAfterMs: Math.max(0, next - this.#now()) };
  }

  /** Ends expired sessions and deleted releases' ones, frozen or not: the row first, then R2. */
  async #expire(): Promise<void> {
    const now = this.#now();
    for (const row of this.#exec<UploadRow>(
      `SELECT * FROM release_asset_uploads WHERE state IN ('receiving', 'completing')
       AND (expires_at <= ? OR release_id NOT IN (SELECT id FROM releases))
       ORDER BY expires_at LIMIT ?`,
      now,
      RELEASE_ASSET_POLICY.sessionBatch,
    )) {
      // Only a session this slice ended: one that committed while an earlier one was let go
      // names a live asset's key.
      if (this.#end(row)) await this.#letGo(row);
    }
    // Restored sessions: ended, their keys left alone.
    for (const row of this.#exec<UploadRow>(
      `SELECT * FROM release_asset_uploads WHERE state IN ('receiving', 'completing')
       AND epoch_gen <> ? LIMIT ?`,
      this.deps.events.epochGen(),
      RELEASE_ASSET_POLICY.sessionBatch,
    )) {
      // Only a session this slice ended: one that committed while an earlier one was let go
      // names a live asset's key.
      if (this.#end(row)) await this.#letGo(row);
    }
  }

  /**
   * Clears ended sessions once a completion they sent can no longer land:
   * an aborted one's key deleted once more (current generation only), then
   * its row. A completed one stays to answer retries until it expires; its
   * key is its asset's, and stays.
   */
  async #clear(): Promise<void> {
    const now = this.#now();
    const rows = this.#exec<UploadRow>(
      `SELECT * FROM release_asset_uploads WHERE state IN ('completed', 'aborted')
       AND (settle_after IS NULL OR settle_after <= ?1)
       AND (state = 'aborted' OR expires_at <= ?1) LIMIT ?2`,
      now,
      RELEASE_ASSET_POLICY.sessionBatch,
    );
    const epoch = this.deps.events.epochGen();
    const keys = rows
      .filter((row) => row.state === "aborted" && row.epoch_gen === epoch)
      .map((row) => assetKey(this.deps.repoId(), row.object_id));
    if (keys.length > 0) {
      this.#count("r2.class_a", "delete_unfinished");
      await this.deps.bucket().delete(keys);
    }
    if (rows.length > 0)
      this.#exec(
        "DELETE FROM release_asset_uploads WHERE upload_id IN (SELECT value FROM json_each(?))",
        JSON.stringify(rows.map((row) => row.upload_id)),
      );
  }

  /** Purges up to a batch of due retained objects: R2 first, then the rows and the total. */
  async #purge(): Promise<void> {
    const now = this.#now();
    const due = this.#exec<{ object_id: string; bytes: number }>(
      `SELECT object_id, bytes FROM release_asset_retained ${this.#dueClause()}
       AND object_id NOT IN (SELECT object_id FROM release_asset_uploads WHERE settle_after > ?2)
       ORDER BY purge_after LIMIT ?3`,
      now,
      now,
      RELEASE_ASSET_POLICY.purgeBatch,
    );
    if (due.length === 0) return;
    this.#count("r2.class_a", "purge_retained");
    await this.deps.bucket().delete(due.map((row) => assetKey(this.deps.repoId(), row.object_id)));
    this.#storage().transactionSync(() => {
      const ids = JSON.stringify(due.map((row) => row.object_id));
      const [gone] = this.#exec<{ bytes: number }>(
        `SELECT coalesce(sum(bytes), 0) AS bytes FROM release_asset_retained
         WHERE object_id IN (SELECT value FROM json_each(?))`,
        ids,
      );
      this.#exec(
        "DELETE FROM release_asset_retained WHERE object_id IN (SELECT value FROM json_each(?))",
        ids,
      );
      this.#exec(
        "UPDATE release_asset_counters SET asset_bytes = asset_bytes - ? WHERE id = 1",
        gone?.bytes ?? 0,
      );
      this.#bump();
    });
  }

  /**
   * Due rows: past 30 days and past the restore fence, or retained strictly
   * before an early purge (which overrides the fence). `?1` is now.
   */
  #dueClause(): string {
    return `WHERE ((purge_after <= ?1 AND coalesce(
        (SELECT retain_until FROM release_asset_counters WHERE id = 1), 0) <= ?1)
      OR purge_after < (SELECT early_purge_at FROM release_asset_counters WHERE id = 1)
        + ${RELEASE_ASSET_POLICY.retainMs})`;
  }

  /**
   * When the next retained object is due: one an early purge covers at
   * once, any other at its 30 days or the restore fence, whichever is
   * later. Null when none is retained.
   */
  #nextPurgeAt(): number | null {
    const counters = this.counters();
    const early = counters.early_purge_at;
    const [row] = this.#exec<{ at: number | null }>(
      // Never before a completion still landing for the object can no longer land (the purge
      // leaves it until then), so a slice blocked by one doesn't run again at once.
      `SELECT min(max(
         CASE WHEN ?1 IS NOT NULL AND purge_after < ?1 + ?2 THEN ?1
           ELSE max(purge_after, coalesce(?3, 0)) END,
         coalesce((SELECT max(settle_after) FROM release_asset_uploads u
           WHERE u.object_id = r.object_id), 0))) AS at
       FROM release_asset_retained r`,
      early,
      RELEASE_ASSET_POLICY.retainMs,
      counters.retain_until,
    );
    return row?.at ?? null;
  }

  #untold(): boolean {
    const counters = this.counters();
    return counters.usage_seq > counters.told_seq;
  }

  #frozen(): boolean {
    return this.deps.writeRefusal()?.code === "repo_transferring";
  }

  /**
   * When the job runs next: the earliest session expiry, ended session to
   * clear, purge and statement retry; frozen, never a past deadline, and an
   * hour at most. Null when nothing is left.
   */
  #nextRun(): number | null {
    const now = this.#now();
    const [sessions] = this.#exec<{ expiry: number | null; settle: number | null; ended: number }>(
      `SELECT
         -- A session whose release went is due now: a deletion during a slice wakes no one.
         (SELECT min(CASE WHEN release_id IN (SELECT id FROM releases) THEN expires_at ELSE 0 END)
           FROM release_asset_uploads WHERE state IN ('receiving', 'completing')) AS expiry,
         (SELECT min(CASE WHEN state = 'completed'
             THEN max(coalesce(settle_after, 0), expires_at) ELSE coalesce(settle_after, 0) END)
           FROM release_asset_uploads WHERE state IN ('completed', 'aborted')) AS settle,
         0 AS ended`,
    );
    const times: number[] = [];
    if (sessions?.expiry != null) times.push(sessions.expiry);
    if (sessions?.settle != null) times.push(sessions.settle);
    if (this.#untold()) times.push(now + RELEASE_ASSET_POLICY.statementRetryMs);
    if (this.#frozen()) {
      const future = times.filter((t) => t > now);
      future.push(now + RELEASE_ASSET_POLICY.frozenWakeMs);
      return Math.min(...future);
    }
    const purge = this.#nextPurgeAt();
    if (purge !== null) times.push(purge);
    return times.length === 0 ? null : Math.min(...times);
  }

  #ensureJob(runAt?: number): void {
    this.deps.git.jobs.ensure(
      "release_assets",
      RELEASE_ASSETS_JOB,
      runAt === undefined ? {} : { runAt },
    );
  }

  /** In a transaction: a total is owed. */
  #bump(): void {
    this.#exec("UPDATE release_asset_counters SET usage_seq = usage_seq + 1 WHERE id = 1");
  }

  #assetCount(releaseId: number): number {
    return (
      this.#exec<{ n: number }>(
        "SELECT count(*) AS n FROM release_assets WHERE release_id = ?",
        releaseId,
      )[0]?.n ?? 0
    );
  }

  #row(uploadId: string): UploadRow | undefined {
    return this.#exec<UploadRow>(
      "SELECT * FROM release_asset_uploads WHERE upload_id = ?",
      uploadId,
    )[0];
  }

  #view(row: UploadRow): UploadView {
    const asset =
      row.state === "completed" ? this.byName(row.release_id, row.name_fold) : undefined;
    return {
      uploadId: row.upload_id,
      releaseId: row.release_id,
      name: row.name,
      contentType: row.content_type,
      bytes: row.bytes,
      partBytes: row.part_bytes,
      partCount: partLayout(row.bytes, row.part_bytes).partCount,
      state: row.state,
      expiresAt: row.expires_at,
      ...(asset && asset.objectId === row.object_id && { asset }),
    };
  }

  #count(metric: "r2.class_a" | "r2.class_b", op: string): void {
    this.deps.git.context.metrics.count(metric, { bucket: ASSETS_BUCKET, op });
  }

  #storage() {
    return this.deps.git.context.storage;
  }

  #now() {
    return this.deps.git.context.now();
  }

  #exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): T[] {
    const cursor = this.#storage().sql.exec<T>(query, ...bindings);
    const rows = cursor.toArray();
    if (cursor.rowsWritten > 0)
      this.deps.git.context.metrics.count(
        "do.rows_written",
        { class: this.deps.git.context.doClass, op: "release_assets.write" },
        cursor.rowsWritten,
      );
    return rows;
  }
}
