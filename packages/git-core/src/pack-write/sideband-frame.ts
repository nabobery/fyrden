import { SIDEBAND_64K_MAX_PAYLOAD, SIDEBAND_DATA } from "../protocol/sideband.js";

/*
 * Frames a pack for side-band-64k once, so the framed bytes can be stored
 * and later piped to clients without JavaScript touching them. In protocol
 * v2 the packfile section is always multiplexed (gitprotocol-v2, verified
 * 2026-10-11), and framing in a Worker costs about 2.4 to 3.7 ms of CPU
 * per MiB, measured on Workers Free on 2026-10-10.
 *
 * Frames are cut at fixed payload boundaries, so the output depends only on
 * the pack and the payload size, never on how the input was chunked. The
 * result is the band-1 packets only: the `packfile` section line before
 * them and the flush after them belong to each response.
 */

/** Proposed default; tuned under load. */
export const DEFAULT_FRAMED_OUTPUT_BYTES = 1024 * 1024;
const HEADER_BYTES = 5;
const HEX = "0123456789abcdef";

export interface SidebandFrameOptions {
  /** Payload bytes per packet, 1 to 65,515. Default: 65,515, the side-band-64k maximum. */
  readonly payloadBytes?: number;
  /** Bytes per output chunk, rounded down to whole packets (at least one). Default 1 MiB. */
  readonly outputBytes?: number;
}

/** Bytes of `dataLength` data once framed with `payloadBytes` per packet. */
export function sidebandFramedLength(
  dataLength: number,
  payloadBytes = SIDEBAND_64K_MAX_PAYLOAD,
): number {
  checkPayload(payloadBytes);
  if (!Number.isSafeInteger(dataLength) || dataLength < 0) {
    throw new RangeError(`bad data length ${dataLength}`);
  }
  return dataLength + HEADER_BYTES * Math.ceil(dataLength / payloadBytes);
}

/**
 * The band-1 packets carrying `source`, in output chunks of whole packets.
 * Empty input gives no packets. Each output chunk is a new buffer.
 */
export function frameSidebandData(
  source: AsyncIterable<Uint8Array>,
  options: SidebandFrameOptions = {},
): AsyncIterable<Uint8Array> {
  const payload = options.payloadBytes ?? SIDEBAND_64K_MAX_PAYLOAD;
  checkPayload(payload);
  const outputBytes = options.outputBytes ?? DEFAULT_FRAMED_OUTPUT_BYTES;
  if (!Number.isSafeInteger(outputBytes) || outputBytes < 1) {
    throw new RangeError(`outputBytes must be a positive integer, not ${outputBytes}`);
  }
  const frame = payload + HEADER_BYTES;
  const capacity = Math.max(1, Math.floor(outputBytes / frame)) * frame;
  return frames(source, payload, capacity);
}

async function* frames(
  source: AsyncIterable<Uint8Array>,
  payload: number,
  capacity: number,
): AsyncGenerator<Uint8Array> {
  let out = new Uint8Array(capacity);
  let pos = 0;
  // Start of the open packet's header, or -1 when no packet is open.
  let open = -1;
  let fill = 0;
  for await (const chunk of source) {
    let at = 0;
    while (at < chunk.length) {
      if (open < 0) {
        if (pos + HEADER_BYTES + payload > capacity) {
          yield out.subarray(0, pos);
          out = new Uint8Array(capacity);
          pos = 0;
        }
        open = pos;
        pos += HEADER_BYTES;
        fill = 0;
      }
      const take = Math.min(payload - fill, chunk.length - at);
      out.set(chunk.subarray(at, at + take), pos);
      pos += take;
      fill += take;
      at += take;
      if (fill === payload) {
        writeHeader(out, open, payload);
        open = -1;
      }
    }
  }
  if (open >= 0) writeHeader(out, open, fill);
  if (pos > 0) yield out.subarray(0, pos);
}

function writeHeader(out: Uint8Array, at: number, payload: number): void {
  const length = payload + HEADER_BYTES;
  out[at] = HEX.charCodeAt((length >> 12) & 15);
  out[at + 1] = HEX.charCodeAt((length >> 8) & 15);
  out[at + 2] = HEX.charCodeAt((length >> 4) & 15);
  out[at + 3] = HEX.charCodeAt(length & 15);
  out[at + 4] = SIDEBAND_DATA;
}

function checkPayload(payload: number): void {
  if (!Number.isInteger(payload) || payload < 1 || payload > SIDEBAND_64K_MAX_PAYLOAD) {
    throw new RangeError(`side-band payload must be 1 to ${SIDEBAND_64K_MAX_PAYLOAD} bytes`);
  }
}
