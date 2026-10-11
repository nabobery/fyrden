import { DEFAULT_PKT_LINE_LIMITS, PktLineStreamReader } from "../protocol/pktline.js";
import {
  type ReceivePackRequest,
  type ReceivePackRequestOptions,
  readReceivePackRequest,
} from "../protocol/receive-pack-request.js";

/**
 * A stored receive-pack request body: the bytes the client POSTed (commands,
 * push options, then the pack), kept whole in one object. The Worker
 * writes it with a single PUT; git does not compress receive-pack request
 * bodies, so these are the protocol bytes.
 */
export interface StoredBody {
  /** Bytes in the body. */
  readonly length: number;
  /** `length` bytes at `offset`; never past the end. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface PushBody {
  readonly request: ReceivePackRequest;
  /** Where the pack starts in the body (the first byte after the command section). */
  readonly packOffset: number;
  /** Bytes from `packOffset` to the end of the body; 0 for a delete-only push. */
  readonly packLength: number;
}

/** Proposed: the command section is read in 64 KiB ranges. Tuned under load. */
export const COMMAND_READ_BYTES = 64 * 1024;

/** Reads `body` from `start` to its end in ranges of `chunk` bytes. */
export async function* bodyChunks(
  body: StoredBody,
  start: number,
  chunk: number,
): AsyncGenerator<Uint8Array> {
  for (let at = start; at < body.length; at += chunk) {
    const length = Math.min(chunk, body.length - at);
    const bytes = await body.read(at, length);
    if (bytes.length !== length) {
      throw new RangeError(`stored body gave ${bytes.length} bytes at ${at}, not ${length}`);
    }
    yield bytes;
  }
}

/**
 * Parses the command section of a stored body and finds where the pack
 * starts. Throws `ProtocolError` for a malformed section; the caller sends
 * git's error back with status 200 (`encodeFatalError`).
 */
export async function readPushBody(
  body: StoredBody,
  options: ReceivePackRequestOptions,
): Promise<PushBody> {
  const reader = new PktLineStreamReader(bodyChunks(body, 0, COMMAND_READ_BYTES), {
    maxLines: DEFAULT_PKT_LINE_LIMITS.maxLines,
    maxBytes: DEFAULT_PKT_LINE_LIMITS.maxBytes,
  });
  const request = await readReceivePackRequest(reader, options);
  const packOffset = reader.bytesRead;
  return { request, packOffset, packLength: body.length - packOffset };
}

/** A `StoredBody` over bytes in memory (tests, and small bodies the Worker already holds). */
export function bytesBody(bytes: Uint8Array): StoredBody {
  return {
    length: bytes.length,
    async read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > bytes.length) {
        throw new RangeError(`range ${offset}+${length} is outside the body (${bytes.length})`);
      }
      return bytes.subarray(offset, offset + length);
    },
  };
}
