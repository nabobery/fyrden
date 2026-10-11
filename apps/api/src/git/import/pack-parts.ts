import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import type { FetchPackSink } from "@fyrden/git-core";
import { BUCKET_NAME } from "../push/scratch.js";

/**
 * Writes a fetched pack to an R2 multipart upload in equal parts of
 * `partBytes` (the last smaller), as it arrives. The bytes must be copied
 * out of side-band frames anyway, so they are gathered in a part buffer; a
 * pipe without code per chunk is not possible here. The multipart
 * upload is created on the first byte and reported through `onCreated`
 * before any part is stored, so it can be recorded for the reaper.
 */
export class MultipartPackSink implements FetchPackSink {
  readonly #buffer: Uint8Array;
  #filled = 0;
  #upload: R2MultipartUpload | undefined;
  readonly #parts: R2UploadedPart[] = [];
  #bytes = 0;

  constructor(
    private readonly bucket: R2Bucket,
    private readonly key: string,
    partBytes: number,
    private readonly hooks: {
      readonly onCreated: (multipartId: string) => void;
      readonly onPart?: (bytes: number) => void | Promise<void>;
      readonly metrics: Metrics;
    },
  ) {
    this.#buffer = new Uint8Array(partBytes);
  }

  get bytes(): number {
    return this.#bytes;
  }

  async write(chunk: Uint8Array): Promise<void> {
    let at = 0;
    while (at < chunk.length) {
      const take = Math.min(chunk.length - at, this.#buffer.length - this.#filled);
      this.#buffer.set(chunk.subarray(at, at + take), this.#filled);
      this.#filled += take;
      at += take;
      this.#bytes += take;
      if (this.#filled === this.#buffer.length) await this.#flush();
    }
  }

  /** Stores the last part and completes the upload; returns the object's size. */
  async finish(): Promise<number> {
    if (this.#filled > 0 || this.#parts.length === 0) await this.#flush();
    this.#count("complete_multipart");
    const object = await (this.#upload as R2MultipartUpload).complete(this.#parts);
    return object.size;
  }

  async #flush(): Promise<void> {
    if (!this.#upload) {
      this.#count("create_multipart");
      this.#upload = await this.bucket.createMultipartUpload(this.key);
      this.hooks.onCreated(this.#upload.uploadId);
    }
    this.#count("upload_part");
    // A copy: whether the binding still reads the bytes after it resolves is unverified.
    const part = await this.#upload.uploadPart(
      this.#parts.length + 1,
      this.#buffer.slice(0, this.#filled),
    );
    this.#parts.push(part);
    this.#filled = 0;
    await this.hooks.onPart?.(this.#bytes);
  }

  #count(op: string): void {
    this.hooks.metrics.count("r2.class_a", { bucket: BUCKET_NAME, op });
  }
}
