import { createSha1Hasher } from "../hash/sha1.js";
import { type Oid, oidToHex } from "../object/oid.js";
import { frameSidebandData } from "../pack-write/sideband-frame.js";
import {
  type PackRangeStream,
  streamVerbatimPack,
  type VerbatimPlan,
} from "../pack-write/verbatim.js";
import type { HasherFactory } from "../ports/hasher.js";
import type { PackId } from "../ports/pack-store.js";
import { encodePktLine, PktLineWriter } from "../protocol/pktline.js";
import { SIDEBAND_64K_MAX_PAYLOAD } from "../protocol/sideband.js";

/*
 * A protocol v2 fetch response (gitprotocol-v2, "fetch"), described as
 * parts a transport can serve cheaply:
 *
 *   output = acknowledgements flush-pkt |
 *            [acknowledgments delim-pkt] [shallow-info delim-pkt]
 *            packfile flush-pkt
 *
 * Section lines, acknowledgments and shallow-info are small literal
 * buffers. Pack bytes are never in the plan: a part names stored bytes (a
 * live pack, or an object the Durable Object materialised) that the
 * transport reads with one ranged GET. In protocol v2 the packfile section
 * is always side-band multiplexed, so pack bytes go out as band-1
 * packets: `framed: false` parts are framed by the transport while
 * streaming (the Workers Paid shape), `framed: true` parts were stored
 * already framed and pass through untouched (the Workers Free shape, where
 * per-chunk JavaScript in the Worker does not fit the CPU budget).
 */
export type FetchResponsePart =
  /** Bytes sent as they are: pkt-lines. */
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  /** Stored bytes sent on side-band 1: pack bytes (`framed: false`) or band-1 packets (`framed: true`). */
  | {
      readonly kind: "pack";
      readonly packId: PackId;
      readonly offset: number;
      readonly length: number;
      readonly framed: boolean;
    }
  /**
   * Several stored packs joined into one (a new header, each pack's
   * entries, a new trailer hashed over the stream), framed by the transport.
   */
  | { readonly kind: "stitched"; readonly plan: Extract<VerbatimPlan, { kind: "stitched" }> };

export interface RenderOptions {
  /** Side-band payload per packet for parts the renderer frames. Default 65,515. */
  readonly payloadBytes?: number;
  /** The stitched trailer's hasher. Default: git-core's SHA-1 without collision detection. */
  readonly createHasher?: HasherFactory;
}

/**
 * The exact response bytes for `parts`, reading stored bytes through
 * `read`. This is the reference the transport must match; a Worker may
 * serve the same parts with native streams instead.
 */
export async function* renderFetchResponse(
  parts: readonly FetchResponsePart[],
  read: PackRangeStream,
  options: RenderOptions = {},
): AsyncGenerator<Uint8Array> {
  const frame = { payloadBytes: options.payloadBytes ?? SIDEBAND_64K_MAX_PAYLOAD };
  for (const part of parts) {
    if (part.kind === "bytes") yield part.bytes;
    else if (part.kind === "pack") {
      const bytes = read(part.packId, part.offset, part.length);
      if (part.framed) yield* bytes;
      else yield* frameSidebandData(bytes, frame);
    } else {
      const hasher = options.createHasher ?? (() => createSha1Hasher({ detectCollisions: false }));
      yield* frameSidebandData(
        streamVerbatimPack(part.plan, read, { createHasher: hasher }),
        frame,
      );
    }
  }
}

/**
 * An `ERR` packet: git prints "remote error: <message>" and stops. Sent
 * instead of a response when a request is refused (git v2.53.0
 * `packet_writer_error`).
 */
export function uploadPackErrorPacket(message: string): Uint8Array<ArrayBuffer> {
  return encodePktLine(`ERR ${message}\n`);
}

/**
 * The acknowledgments section. Without `ready` it is the whole response
 * (ends with a flush); with `ready` the pack follows (ends with a delim).
 */
export function acknowledgmentsSection(common: readonly Oid[], ready: boolean): Uint8Array {
  const writer = new PktLineWriter().text("acknowledgments");
  if (common.length === 0) writer.text("NAK");
  for (const oid of common) writer.text(`ACK ${oidToHex(oid)}`);
  if (ready) return writer.text("ready").delim().bytes();
  return writer.flush().bytes();
}

/** The shallow-info section, ending with its delim. */
export function shallowInfoSection(shallow: readonly Oid[], unshallow: readonly Oid[]): Uint8Array {
  const writer = new PktLineWriter().text("shallow-info");
  for (const oid of shallow) writer.text(`shallow ${oidToHex(oid)}`);
  for (const oid of unshallow) writer.text(`unshallow ${oidToHex(oid)}`);
  return writer.delim().bytes();
}

/** The packfile section's header line. */
export function packfileHeader(): Uint8Array {
  return new PktLineWriter().text("packfile").bytes();
}
