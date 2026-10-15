import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { putChunks } from "../put-chunks.js";
import { BUCKET_NAME } from "./scratch.js";

export type StoredPushBody =
  | { readonly ok: true; readonly bytes: number }
  /** Longer than the limit; `head` is the start of the body (to answer in the client's terms). */
  | { readonly ok: false; readonly reason: "too-large"; readonly head: Uint8Array }
  /** A gzip body that does not inflate. */
  | { readonly ok: false; readonly reason: "bad-gzip" };

/** Bytes of the body start kept for the refusal: the first command fits in one pkt-line. */
const HEAD_BYTES = 65_520;

/**
 * Stores a receive-pack request body at `key` with one R2 PUT.
 *
 * With a `Content-Length`, the request stream goes to R2 as it is: the
 * Worker runs no code per chunk (a single `put(request.body)` of 95–100 MiB
 * cost 0–1 ms of Worker CPU, measured on Workers Free, 2026-10-10). R2 needs
 * the length of a stream up front ("Provided readable stream must have a
 * known length", measured in the local runtime, 2026-10-11).
 *
 * Without one (git sends bodies above `http.postBuffer`, 1 MiB by default,
 * with chunked transfer encoding), the body is read into memory up to
 * `maxBytes` and stored from there, which costs Worker CPU per chunk.
 * Behind Cloudflare's edge this does not happen: the edge buffers a body of
 * unknown length and hands the Worker a `Content-Length` (measured on
 * Workers Free, 2026-10-10); the local runtime (`wrangler dev`) does not.
 *
 * With `gzip` (JGit compresses every receive-pack request), the body is
 * inflated by the runtime's `DecompressionStream` and takes the same
 * buffered path, since its inflated length is unknown until the end;
 * `maxBytes` bounds the inflated bytes, so a compression bomb stops at the
 * limit (the caller gives gzip bodies a smaller one).
 *
 * A buffered body is held once: its chunks go to R2 through a
 * `FixedLengthStream` of the length read, each dropped once written, with
 * no second, joined copy.
 */
export async function storePushBody(
  bucket: R2Bucket,
  key: string,
  request: Request,
  options: { declaredBytes: number | undefined; maxBytes: number; gzip: boolean },
  metrics: Metrics,
): Promise<StoredPushBody> {
  metrics.count("r2.class_a", { bucket: BUCKET_NAME, op: "put_body" });
  if (!request.body || !(options.gzip || options.declaredBytes === undefined)) {
    const object = await bucket.put(key, request.body ?? new Uint8Array(0));
    if (!object) throw new Error("R2 did not store the push body");
    return { ok: true, bytes: object.size };
  }
  const stream = options.gzip
    ? request.body.pipeThrough(new DecompressionStream("gzip"))
    : request.body;
  const read = await readCapped(stream, options.maxBytes, options.gzip);
  if (!read.ok) return read;
  const object = await putChunks(bucket, key, read.chunks);
  return { ok: true, bytes: object.size };
}

async function readCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  inflating: boolean,
): Promise<
  { ok: true; chunks: Uint8Array[]; length: number } | Exclude<StoredPushBody, { ok: true }>
> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    let next: ReadableStreamReadResult<Uint8Array>;
    try {
      next = await reader.read();
    } catch (error) {
      // The decompressor rejects corrupt or truncated gzip with a TypeError
      // (a dropped connection may land here too; that client sees no answer).
      if (inflating && error instanceof TypeError) return { ok: false, reason: "bad-gzip" };
      throw error;
    }
    const { done, value } = next;
    if (done) break;
    chunks.push(value);
    length += value.length;
    if (length > maxBytes) {
      await reader.cancel().catch(() => {});
      return { ok: false, reason: "too-large", head: join(chunks, Math.min(length, HEAD_BYTES)) };
    }
  }
  return { ok: true, chunks, length };
}

/** The first `length` bytes of `chunks`, in one buffer. */
function join(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    if (at >= length) break;
    const take = Math.min(chunk.length, length - at);
    out.set(chunk.subarray(0, take), at);
    at += take;
  }
  return out;
}
