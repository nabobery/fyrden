import type { PktLine } from "./pktline.js";

/**
 * Why a peer's protocol input was refused. Every parser in this directory
 * throws only `ProtocolError` for bad input, so a caller can turn any of them
 * into an `ERR` packet or a side-band 3 message without guessing.
 */
export type ProtocolErrorCode =
  // pkt-line framing
  | "invalid-length"
  | "line-too-long"
  | "truncated"
  | "too-many-lines"
  | "too-many-bytes"
  // side-band
  | "missing-band"
  | "bad-band"
  // message structure
  | "unexpected-packet"
  | "malformed-line"
  | "bad-capability"
  | "unknown-capability"
  | "unknown-command"
  | "duplicate-command"
  | "no-command"
  | "object-format-mismatch"
  | "unexpected-argument"
  | "bad-argument"
  | "unsupported"
  // request limits
  | "too-many-wants"
  | "too-many-haves"
  | "too-many-shallows"
  | "too-many-commands"
  | "too-many-push-options"
  | "too-many-arguments";

export class ProtocolError extends Error {
  override readonly name = "ProtocolError";
  constructor(
    readonly code: ProtocolErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Longest excerpt of peer input quoted in an error message. */
const EXCERPT_BYTES = 64;

/**
 * Peer bytes made safe to quote in an error message, which may be logged or
 * sent back to the client: printable ASCII stays, anything else becomes an
 * octal escape (as git's packet trace prints it), and long input is cut.
 */
export function excerpt(bytes: Uint8Array): string {
  let out = "";
  const end = Math.min(bytes.length, EXCERPT_BYTES);
  for (let i = 0; i < end; i++) {
    const b = bytes[i] as number;
    out += b >= 0x20 && b <= 0x7e && b !== 0x5c ? String.fromCharCode(b) : `\\${b.toString(8)}`;
  }
  return bytes.length > EXCERPT_BYTES ? `${out}...` : out;
}

/** A line that does not match the grammar of its section. */
export function malformedLine(what: string, line: Uint8Array): ProtocolError {
  return new ProtocolError("malformed-line", `protocol error: ${what} '${excerpt(line)}'`);
}

/** A special packet, or the end of input, where a section expected something else. */
export function unexpectedPacket(pkt: PktLine | undefined, where: string): ProtocolError {
  return pkt === undefined
    ? new ProtocolError("truncated", `the remote end hung up unexpectedly in ${where}`)
    : new ProtocolError(
        "unexpected-packet",
        `protocol error: unexpected ${pkt.kind} packet in ${where}`,
      );
}
