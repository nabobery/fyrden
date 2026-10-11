import { createDigestStreamHasher } from "@fyrden/adapters-cloudflare";
import {
  asPackId,
  frameSidebandData,
  type PackRangeStream,
  SIDEBAND_64K_MAX_PAYLOAD,
  SIDEBAND_DATA,
  streamVerbatimPack,
} from "@fyrden/git-core";
import type { StoredRange, WirePart } from "./wire.js";

/*
 * Streams a planned fetch response from the Worker. The response body is
 * the readable side of an `IdentityTransformStream`: literal pkt-lines are
 * written into it, and stored bytes reach it in one of two ways:
 *
 * - already framed (Workers Free): the R2 body is piped into it natively
 *   (`pipeTo`), so no JavaScript touches the bytes. A native pipe costs
 *   1 to 4 ms of CPU per GiB, against hundreds of ms per 100 MiB for any
 *   per-chunk JavaScript or for a `new TransformStream()` (measured on
 *   Workers Free on 2026-10-10).
 * - raw pack bytes (Workers Paid): framed into side-band packets here,
 *   reading R2 with a BYOB reader straight into each packet's buffer
 *   after its 5-byte header, one write per packet: 240 to 353 ms of CPU
 *   per 100 MiB in the same measurements, where a default reader delivers
 *   4 KiB chunks.
 *
 * Each stored range is one ranged GET, so a verbatim clone costs one R2
 * call per pack.
 */

const HEADER_BYTES = 5;
const HEX = "0123456789abcdef";
/** Reads per stitched segment and output chunks of a stitched pack. Proposed. */
const STITCH_CHUNK_BYTES = 1024 * 1024;

export interface ServeResult {
  /** Bytes written to the response. */
  readonly bytes: number;
  /** R2 GETs made. */
  readonly r2Calls: number;
  /** Set when the response could not be completed (the client went away, or a read failed). */
  readonly error?: unknown;
}

export interface FetchResponseStream {
  readonly body: ReadableStream<Uint8Array>;
  /** Settles when the body is complete or abandoned; never rejects. */
  readonly done: Promise<ServeResult>;
}

/** Starts streaming `parts`. Return `body` in the response right away; reading drives it. */
export function streamFetchResponse(
  parts: readonly WirePart[],
  bucket: R2Bucket,
): FetchResponseStream {
  const { readable, writable } = new IdentityTransformStream();
  const counters = { bytes: 0, r2Calls: 0 };
  const get = async (range: StoredRange): Promise<ReadableStream<Uint8Array>> => {
    counters.r2Calls++;
    const object = await bucket.get(range.key, {
      range: { offset: range.offset, length: range.length },
    });
    if (!object) throw new Error("stored pack bytes are missing");
    return object.body;
  };

  const done = (async (): Promise<ServeResult> => {
    try {
      for (const part of parts) {
        if (part.kind === "bytes") {
          await writeChunks(writable, [part.bytes]);
          counters.bytes += part.bytes.length;
        } else if (part.kind === "stored") {
          const body = await get(part);
          if (part.framed) {
            await body.pipeTo(writable, { preventClose: true });
            counters.bytes += part.length;
          } else {
            counters.bytes += await frameStream(body, part.length, writable);
          }
        } else {
          counters.bytes += await writeStitched(part, get, writable);
        }
      }
      await writable.close();
      return { ...counters };
    } catch (error) {
      await writable.abort(error).catch(() => {});
      return { ...counters, error };
    }
  })();
  return { body: readable, done };
}

async function writeChunks(
  writable: WritableStream<ArrayBufferView>,
  chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
): Promise<number> {
  const writer = writable.getWriter();
  let bytes = 0;
  try {
    for await (const chunk of chunks) {
      await writer.write(chunk);
      bytes += chunk.length;
    }
  } finally {
    writer.releaseLock();
  }
  return bytes;
}

function writeHeader(frame: Uint8Array, payload: number): void {
  const length = payload + HEADER_BYTES;
  frame[0] = HEX.charCodeAt((length >> 12) & 15);
  frame[1] = HEX.charCodeAt((length >> 8) & 15);
  frame[2] = HEX.charCodeAt((length >> 4) & 15);
  frame[3] = HEX.charCodeAt(length & 15);
  frame[4] = SIDEBAND_DATA;
}

/**
 * Frames `length` bytes of `body` as side-band 1 packets of 65,515 bytes
 * (the last shorter): each packet is read by BYOB straight into its own
 * buffer behind the header and written once. Returns bytes written.
 */
async function frameStream(
  body: ReadableStream<Uint8Array>,
  length: number,
  writable: WritableStream<ArrayBufferView>,
): Promise<number> {
  const reader = body.getReader({ mode: "byob" });
  const writer = writable.getWriter();
  let left = length;
  let written = 0;
  try {
    while (left > 0) {
      const want = Math.min(SIDEBAND_64K_MAX_PAYLOAD, left);
      const { value, done } = await reader.readAtLeast(
        want,
        new Uint8Array(new ArrayBuffer(want + HEADER_BYTES), HEADER_BYTES, want),
      );
      if (done || value === undefined || value.byteLength !== want) {
        throw new Error("stored pack bytes ended early");
      }
      const frame = new Uint8Array(value.buffer, 0, HEADER_BYTES + want);
      writeHeader(frame, want);
      await writer.write(frame);
      left -= want;
      written += frame.length;
    }
  } finally {
    writer.releaseLock();
    reader.releaseLock();
  }
  return written;
}

/** `length` bytes of `body` in reads of up to `chunkBytes`, each into a new buffer, by BYOB. */
async function* readChunks(
  body: ReadableStream<Uint8Array>,
  length: number,
  chunkBytes: number,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader({ mode: "byob" });
  try {
    let left = length;
    while (left > 0) {
      const want = Math.min(chunkBytes, left);
      const { value, done } = await reader.readAtLeast(want, new Uint8Array(want));
      if (done || value === undefined || value.byteLength !== want) {
        throw new Error("stored pack bytes ended early");
      }
      left -= want;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Several stored packs as one pack, framed: the planned header, each pack's
 * entries (one GET per pack), and a new trailer. The trailer is hashed with
 * `crypto.DigestStream` over 1 MiB writes.
 */
async function writeStitched(
  part: Extract<WirePart, { kind: "stitched" }>,
  get: (range: StoredRange) => Promise<ReadableStream<Uint8Array>>,
  writable: WritableStream<ArrayBufferView>,
): Promise<number> {
  const byPackId = new Map(part.segments.map((s) => [s.packId, s]));
  const read: PackRangeStream = async function* (packId, offset, length) {
    const segment = byPackId.get(packId);
    if (!segment || segment.offset !== offset || segment.length !== length) {
      throw new Error("a stitched read does not match its segment");
    }
    yield* readChunks(await get(segment), length, STITCH_CHUNK_BYTES);
  };
  const plan = {
    kind: "stitched" as const,
    header: part.header,
    segments: part.segments.map((s) => ({
      packId: asPackId(s.packId),
      offset: s.offset,
      length: s.length,
    })),
    length: part.length,
    objectCount: part.objectCount,
  };
  const pack = streamVerbatimPack(plan, read, {
    createHasher: createDigestStreamHasher,
    minChunkBytes: STITCH_CHUNK_BYTES,
  });
  return writeChunks(writable, frameSidebandData(pack, { outputBytes: STITCH_CHUNK_BYTES }));
}
