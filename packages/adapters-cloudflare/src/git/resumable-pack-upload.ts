import type { PackId, PackInfo } from "@fyrden/git-core";
import { newPackId } from "./keys.js";
import type { PackKind } from "./pack-registry.js";
import { DEFAULT_PART_BYTES, MIN_PART_BYTES } from "./r2-pack-store.js";
import type { RepoGitStorage } from "./repo-git-storage.js";
import { countRowsWritten } from "./sql.js";

/**
 * Where a resumable pack upload stands, small enough for a job cursor: the
 * multipart upload and the parts already in R2. The bytes written after the
 * last part (fewer than one part) are not in it: `save` returns them for the
 * caller to keep (in a scratch object) and pass back to `resume`.
 */
export interface PackUploadState {
  readonly packId: PackId;
  readonly partBytes: number;
  readonly multipartId: string | null;
  readonly parts: readonly { readonly partNumber: number; readonly etag: string }[];
}

const BUCKET = "fyrden-git";

/**
 * A pack written by maintenance across several alarm slices: a multipart
 * upload whose state survives the Durable Object being evicted or reset.
 * R2 requires every part but the last to be the same size (at least 5 MiB;
 * verified: https://developers.cloudflare.com/r2/objects/upload-objects/),
 * so only whole parts are uploaded while writing; the rest stays in memory
 * until `save` hands it to the caller or `finish` uploads it as the last
 * part (or the whole pack with one PUT, when it never filled a part).
 *
 * Its registry row is created `pending` before any byte is stored, as for
 * every pack, and moves to `indexing` when the upload completes. Redoing a
 * slice from an older saved state uploads the same part numbers again,
 * which replaces them; the completion names the parts it was given.
 */
export class ResumablePackUpload {
  readonly packId: PackId;
  readonly #git: RepoGitStorage;
  readonly #key: string;
  readonly #partBytes: number;
  #multipartId: string | null;
  #multipart: R2MultipartUpload | undefined;
  readonly #parts: { partNumber: number; etag: string }[];
  #buffer: Uint8Array;
  #buffered = 0;
  #state: "open" | "finished" | "aborted" = "open";

  private constructor(git: RepoGitStorage, state: PackUploadState, tail: Uint8Array) {
    const row = git.registry.get(state.packId);
    if (!row) throw new Error(`pack ${state.packId} has no registry row`);
    if (row.state !== "pending")
      throw new Error(`pack ${state.packId} is ${row.state}, not pending`);
    if (!Number.isSafeInteger(state.partBytes) || state.partBytes < MIN_PART_BYTES)
      throw new RangeError(`part size must be at least ${MIN_PART_BYTES} bytes`);
    if (tail.length >= state.partBytes)
      throw new RangeError("the saved tail is a whole part or more");
    this.#git = git;
    this.packId = state.packId;
    this.#key = row.r2Key;
    this.#partBytes = state.partBytes;
    this.#multipartId = state.multipartId;
    this.#parts = state.parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag }));
    this.#buffer = new Uint8Array(state.partBytes);
    this.#buffer.set(tail);
    this.#buffered = tail.length;
  }

  /** Starts a new pack of `kind`: its `pending` row now, its bytes as they are written. */
  static begin(
    git: RepoGitStorage,
    kind: PackKind,
    options: { readonly partBytes?: number } = {},
  ): ResumablePackUpload {
    const packId = newPackId(git.context.now());
    const written = git.registry.createPending({ packId, networkId: git.networkId(), kind });
    countRowsWritten(git.context, "packs.begin", written);
    return new ResumablePackUpload(
      git,
      { packId, partBytes: options.partBytes ?? DEFAULT_PART_BYTES, multipartId: null, parts: [] },
      new Uint8Array(0),
    );
  }

  /** Continues an upload from a saved state and the tail `save` returned with it. */
  static resume(
    git: RepoGitStorage,
    state: PackUploadState,
    tail: Uint8Array,
  ): ResumablePackUpload {
    return new ResumablePackUpload(git, state, tail);
  }

  /** Bytes written so far. */
  get bytes(): number {
    return this.#parts.length * this.#partBytes + this.#buffered;
  }

  async write(chunk: Uint8Array): Promise<void> {
    this.#requireOpen();
    let at = 0;
    while (at < chunk.length) {
      const take = Math.min(chunk.length - at, this.#partBytes - this.#buffered);
      this.#buffer.set(chunk.subarray(at, at + take), this.#buffered);
      this.#buffered += take;
      at += take;
      if (this.#buffered === this.#partBytes) await this.#uploadPart();
    }
  }

  /** The state to keep, and a copy of the bytes not yet in R2 (fewer than one part). */
  save(): { state: PackUploadState; tail: Uint8Array } {
    this.#requireOpen();
    return {
      state: {
        packId: this.packId,
        partBytes: this.#partBytes,
        multipartId: this.#multipartId,
        parts: this.#parts.map((p) => ({ ...p })),
      },
      tail: this.#buffer.slice(0, this.#buffered),
    };
  }

  /** Stores the last bytes and completes the object; the row moves to `indexing`. */
  async finish(): Promise<PackInfo> {
    this.#requireOpen();
    const bytes = this.bytes;
    if (this.#multipartId === null) {
      this.#count("put");
      await this.#git.bucket.put(this.#key, this.#buffer.subarray(0, this.#buffered));
    } else {
      if (this.#buffered > 0) await this.#uploadPart();
      this.#count("complete_multipart");
      await this.#upload().complete(this.#parts);
    }
    this.#buffer = new Uint8Array(0);
    const written = this.#git.registry.transition(this.packId, ["pending"], "indexing", { bytes });
    if (written === 0) throw new Error(`pack ${this.packId} is no longer pending`);
    countRowsWritten(this.#git.context, "packs.finish", written);
    this.#state = "finished";
    return { packId: this.packId, bytes };
  }

  /** Abandons the pack: its row is discarded and its multipart upload aborted (aborting is free). */
  async abort(): Promise<void> {
    if (this.#state === "finished") throw new Error(`pack ${this.packId} is finished`);
    this.#state = "aborted";
    this.#buffer = new Uint8Array(0);
    countRowsWritten(
      this.#git.context,
      "packs.abort",
      this.#git.registry.transition(this.packId, ["pending"], "discarded"),
    );
    if (this.#multipartId !== null) await this.#upload().abort();
  }

  #upload(): R2MultipartUpload {
    this.#multipart ??= this.#git.bucket.resumeMultipartUpload(
      this.#key,
      this.#multipartId as string,
    );
    return this.#multipart;
  }

  async #uploadPart(): Promise<void> {
    if (this.#multipartId === null) {
      this.#count("create_multipart");
      this.#multipart = await this.#git.bucket.createMultipartUpload(this.#key);
      this.#multipartId = this.#multipart.uploadId;
    }
    this.#count("upload_part");
    const part = await this.#upload().uploadPart(
      this.#parts.length + 1,
      this.#buffer.slice(0, this.#buffered),
    );
    this.#parts.push({ partNumber: part.partNumber, etag: part.etag });
    this.#buffered = 0;
  }

  #requireOpen(): void {
    if (this.#state !== "open") throw new Error(`pack ${this.packId} is ${this.#state}`);
  }

  #count(op: string): void {
    this.#git.context.metrics.count("r2.class_a", { bucket: BUCKET, op });
  }
}
