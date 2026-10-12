import type { PackId, PackInfo, PackStore, PackWriter } from "@fyrden/git-core";
import { newPackId } from "./keys.js";
import {
  type PackKind,
  type PackRegistry,
  type PackState,
  READABLE_STATES,
} from "./pack-registry.js";
import { countRowsWritten, type GitStorageContext, rows } from "./sql.js";

const MiB = 1024 * 1024;

/**
 * Multipart part size. R2 requires every part but the last to be at least
 * 5 MiB and the same size, with at most 10,000 parts (verified:
 * https://developers.cloudflare.com/r2/objects/upload-objects/). 16 MiB is
 * the Proposed default, to be tuned under load. A pack no
 * larger than one part is written with a single PUT.
 */
export const DEFAULT_PART_BYTES = 16 * MiB;
export const MIN_PART_BYTES = 5 * MiB;

/** States a pack can be written again from (see `rewritePack`). */
const REWRITABLE_STATES: readonly PackState[] = ["pending", "indexing", "discarded"];

/** Where a new pack belongs. */
export interface NewPackUnit {
  readonly kind: PackKind;
  /** Packs that live and die together. */
  readonly unitId: string;
  readonly uploadId?: string;
}

export interface R2PackStoreOptions {
  readonly bucket: R2Bucket;
  /** The bucket's name, for cost counters. */
  readonly bucketName: string;
  readonly registry: PackRegistry;
  /** The repository's current network: new packs are stored under it. */
  readonly networkId: () => string;
  readonly partBytes?: number;
  /** The kind recorded for packs this store writes. */
  readonly kind?: PackKind;
  /** Allocates pack ids; tests inject a fixed sequence. */
  readonly newPackId?: () => PackId;
}

/**
 * Pack bytes in R2 under `net/<network_id>/p/<pack_id>.pack`; which packs
 * exist and their state is the Durable Object's registry. `beginPack`
 * creates the `pending` row before any byte is stored, `finish` moves it to
 * `indexing`, and only the ref store's commit makes it live, so `listPacks`
 * (the registry's live set) always agrees with the refs.
 *
 * A writer buffers one part in memory (up to `partBytes`); callers reserve
 * that from the memory budget along with their own working set.
 */
export class R2PackStore implements PackStore {
  readonly #partBytes: number;
  readonly #newPackId: () => PackId;

  constructor(
    private readonly context: GitStorageContext,
    private readonly options: R2PackStoreOptions,
  ) {
    this.#partBytes = options.partBytes ?? DEFAULT_PART_BYTES;
    if (!Number.isSafeInteger(this.#partBytes) || this.#partBytes < MIN_PART_BYTES)
      throw new RangeError(`part size must be at least ${MIN_PART_BYTES} bytes`);
    this.#newPackId = options.newPackId ?? (() => newPackId(this.context.now()));
  }

  async listPacks(): Promise<readonly PackInfo[]> {
    return rows<{ pack_id: string; bytes: number }>(
      this.context.storage,
      "SELECT pack_id, bytes FROM packs WHERE state = 'live' ORDER BY created_at, pack_id",
    ).map((row) => ({ packId: row.pack_id as PackId, bytes: row.bytes }));
  }

  beginPack(): PackWriter {
    return this.beginObject(this.options.kind ?? "insert");
  }

  /**
   * Starts a pack of `kind`, stored under `keyFor(networkId, packId)` when
   * given (materialised fetch objects live under the fetch prefix), else
   * beside the other packs.
   */
  beginObject(kind: PackKind, keyFor?: (networkId: string, packId: PackId) => string): PackWriter {
    const packId = this.#newPackId();
    const networkId = this.options.networkId();
    const written = this.options.registry.createPending({
      packId,
      networkId,
      kind,
      ...(keyFor ? { r2Key: keyFor(networkId, packId) } : {}),
    });
    countRowsWritten(this.context, "packs.begin", written);
    return new R2PackWriter(this.context, this.options, packId, this.#partBytes);
  }

  /**
   * Starts a pack in a pack unit: a push's completion pack joins the
   * upload's unit, so both go live or are discarded together.
   */
  beginUnitPack(unit: NewPackUnit): PackWriter {
    const packId = this.#newPackId();
    const written = this.options.registry.createPending({
      packId,
      networkId: this.options.networkId(),
      kind: unit.kind,
      unitId: unit.unitId,
      uploadId: unit.uploadId ?? null,
    });
    countRowsWritten(this.context, "packs.begin", written);
    return new R2PackWriter(this.context, this.options, packId, this.#partBytes);
  }

  /**
   * Starts a pack that an upload writes outside its pack unit (the pack a
   * push's commit compacts its unit and older packs into). It carries the
   * upload's id, so aborting or reaping the upload discards it too; only a
   * commit that names it makes it live.
   */
  beginUploadPack(kind: PackKind, uploadId: string): PackWriter {
    const packId = this.#newPackId();
    const written = this.options.registry.createPending({
      packId,
      networkId: this.options.networkId(),
      kind,
      uploadId,
    });
    countRowsWritten(this.context, "packs.begin", written);
    return new R2PackWriter(this.context, this.options, packId, this.#partBytes);
  }

  /**
   * A writer for a pack whose row already exists: an upload's preallocated
   * pack, written by the indexing job. An attempt that died after writing
   * (or aborting) leaves the row `indexing` (or `discarded`); the next
   * attempt moves it back to `pending` and writes the pack from the start,
   * replacing any bytes in R2. A pack that is indexed, live or later is
   * never written again.
   */
  rewritePack(packId: PackId): PackWriter {
    const written = this.options.registry.transition(packId, REWRITABLE_STATES, "pending");
    if (written === 0) throw new Error(`pack ${packId} cannot be written again`);
    countRowsWritten(this.context, "packs.rewrite", written);
    return new R2PackWriter(this.context, this.options, packId, this.#partBytes);
  }

  async openRange(packId: PackId, offset: number, length: number): Promise<Uint8Array> {
    const pack = this.options.registry.get(packId);
    if (!pack || !READABLE_STATES.includes(pack.state) || pack.bytes === null)
      throw new Error(`pack ${packId} is not readable`);
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > pack.bytes
    ) {
      throw new RangeError(
        `range ${offset}+${length} is outside pack ${packId} (${pack.bytes} bytes)`,
      );
    }
    if (length === 0) return new Uint8Array(0);
    this.#count("r2.class_b", "get");
    const object = await this.options.bucket.get(pack.r2Key, { range: { offset, length } });
    if (!object) throw new Error(`pack ${packId} has no bytes in R2`);
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.length !== length)
      throw new Error(`pack ${packId}: read ${bytes.length} bytes, expected ${length}`);
    return bytes;
  }

  #count(metric: "r2.class_a" | "r2.class_b", op: string): void {
    this.context.metrics.count(metric, { bucket: this.options.bucketName, op });
  }
}

class R2PackWriter implements PackWriter {
  #state: "open" | "finishing" | "finished" | "aborted" = "open";
  #buffer: Uint8Array;
  #buffered = 0;
  #total = 0;
  #multipart: R2MultipartUpload | undefined;
  readonly #parts: R2UploadedPart[] = [];
  readonly #key: string;

  constructor(
    private readonly context: GitStorageContext,
    private readonly options: R2PackStoreOptions,
    readonly packId: PackId,
    private readonly partBytes: number,
  ) {
    this.#key = (options.registry.get(packId) as { r2Key: string }).r2Key;
    this.#buffer = new Uint8Array(0);
  }

  async write(chunk: Uint8Array): Promise<void> {
    this.#requireOpen();
    let at = 0;
    while (at < chunk.length) {
      if (this.#buffer.length === 0) this.#buffer = new Uint8Array(this.partBytes);
      const take = Math.min(chunk.length - at, this.partBytes - this.#buffered);
      // Copies, so the caller may reuse `chunk` once this resolves.
      this.#buffer.set(chunk.subarray(at, at + take), this.#buffered);
      this.#buffered += take;
      this.#total += take;
      at += take;
      if (this.#buffered === this.partBytes) await this.#flushPart();
    }
  }

  async finish(): Promise<PackInfo> {
    this.#requireOpen();
    this.#state = "finishing";
    try {
      if (this.#multipart) {
        if (this.#buffered > 0) await this.#flushPart();
        this.#count("r2.class_a", "complete_multipart");
        await this.#multipart.complete(this.#parts);
      } else {
        this.#count("r2.class_a", "put");
        await this.options.bucket.put(this.#key, this.#buffer.subarray(0, this.#buffered));
      }
    } catch (error) {
      await this.#discard();
      throw error;
    }
    this.#buffer = new Uint8Array(0);
    const written = this.options.registry.transition(this.packId, ["pending"], "indexing", {
      bytes: this.#total,
    });
    if (written === 0) throw new Error(`pack ${this.packId} is no longer pending`);
    countRowsWritten(this.context, "packs.finish", written);
    this.#state = "finished";
    return { packId: this.packId, bytes: this.#total };
  }

  async abort(): Promise<void> {
    if (this.#state === "finished") throw new Error(`pack ${this.packId} is finished`);
    if (this.#state === "aborted") return;
    await this.#discard();
  }

  async #flushPart(): Promise<void> {
    if (!this.#multipart) {
      this.#count("r2.class_a", "create_multipart");
      this.#multipart = await this.options.bucket.createMultipartUpload(this.#key);
    }
    this.#count("r2.class_a", "upload_part");
    const part = await this.#multipart.uploadPart(
      this.#parts.length + 1,
      this.#buffer.subarray(0, this.#buffered),
    );
    this.#parts.push(part);
    this.#buffered = 0;
  }

  async #discard(): Promise<void> {
    this.#state = "aborted";
    this.#buffer = new Uint8Array(0);
    const written = this.options.registry.transition(this.packId, ["pending"], "discarded");
    countRowsWritten(this.context, "packs.abort", written);
    // Aborting a multipart upload is free (verified: https://developers.cloudflare.com/r2/pricing/);
    // a leftover single PUT has no live row, so the reaper removes it.
    await this.#multipart?.abort();
  }

  #requireOpen(): void {
    if (this.#state !== "open") throw new Error(`pack ${this.packId} is ${this.#state}`);
  }

  #count(metric: "r2.class_a" | "r2.class_b", op: string): void {
    this.context.metrics.count(metric, { bucket: this.options.bucketName, op });
  }
}
