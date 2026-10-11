import { concatBytes, startsWithAscii } from "../object/bytes.js";
import { OID_HEX_LENGTH, type Oid, oidToHex, parseOidHex } from "../object/oid.js";
import {
  type Capability,
  encodeCapabilityList,
  findCapability,
  parseCapabilityList,
} from "./capabilities.js";
import { malformedLine, ProtocolError, unexpectedPacket } from "./errors.js";
import { chompLf, encodePktLine, flushPkt, type PktLineSource } from "./pktline.js";

/**
 * The request a client sends to receive-pack, up to the pack
 * (gitprotocol-pack, "Reference Update Request"; git v2.53.0
 * builtin/receive-pack.c `read_head_info` and send-pack.c, verified):
 *
 *   *PKT-LINE("shallow" SP oid)
 *   PKT-LINE(old SP new SP ref NUL capability-list)
 *   *PKT-LINE(old SP new SP ref)
 *   flush
 *   [*PKT-LINE(push-option) flush]   when push-options is advertised and requested
 */

/** One ref update. The name stays bytes: whether it is acceptable is decided at the push boundary. */
export interface PushCommand {
  readonly oldOid: Oid;
  readonly newOid: Oid;
  readonly refName: Uint8Array;
}

export interface ReceivePackRequest {
  /** Shallow boundary commits of a client pushing from a shallow clone. */
  readonly shallow: readonly Oid[];
  readonly commands: readonly PushCommand[];
  /** Capabilities the client asked for (on the first command). */
  readonly capabilities: readonly Capability[];
  /** Present when the client asked for push-options and the server advertised them. */
  readonly pushOptions: readonly Uint8Array[] | undefined;
}

export interface ReceivePackRequestOptions {
  /** Whether the server advertised `push-options`; git reads the section only then. */
  readonly pushOptionsAdvertised: boolean;
  readonly maxCommands?: number;
  readonly maxShallow?: number;
  readonly maxPushOptions?: number;
}

/** Proposed defaults; tuned under load. Git itself has no such limits. */
export const DEFAULT_RECEIVE_PACK_LIMITS = Object.freeze({
  maxCommands: 10_000,
  maxShallow: 100_000,
  maxPushOptions: 100,
});

/** Length of `old SP new SP`. */
const REF_OFFSET = 2 * OID_HEX_LENGTH + 2;

function parseCommand(line: Uint8Array): PushCommand {
  const oldOid = parseOidHex(line, 0);
  const newOid = parseOidHex(line, OID_HEX_LENGTH + 1);
  if (
    !oldOid ||
    !newOid ||
    line[OID_HEX_LENGTH] !== 0x20 ||
    line[REF_OFFSET - 1] !== 0x20 ||
    line.length === REF_OFFSET
  ) {
    throw malformedLine("expected old/new/ref, got", line);
  }
  return { oldOid, newOid, refName: line.subarray(REF_OFFSET) };
}

function limitError(
  code: "too-many-commands" | "too-many-shallows" | "too-many-push-options",
  what: string,
  max: number,
) {
  return new ProtocolError(code, `protocol error: more than ${max} ${what}`);
}

/**
 * Reads the command list (and push options) of a receive-pack request.
 * The source is left at the first byte after them: the pack, if any.
 * Stricter than git where git's leniency is never used by its own client:
 * shallow lines must come first, only the first command may carry a NUL,
 * and push certificates are refused because Fyrden does not advertise them.
 */
export async function readReceivePackRequest(
  source: PktLineSource,
  options: ReceivePackRequestOptions,
): Promise<ReceivePackRequest> {
  const maxCommands = options.maxCommands ?? DEFAULT_RECEIVE_PACK_LIMITS.maxCommands;
  const maxShallow = options.maxShallow ?? DEFAULT_RECEIVE_PACK_LIMITS.maxShallow;
  const shallow: Oid[] = [];
  const commands: PushCommand[] = [];
  let capabilities: Capability[] = [];
  for (;;) {
    const pkt = await source.read();
    if (pkt?.kind === "flush") break;
    if (pkt?.kind !== "data") throw unexpectedPacket(pkt, "command list");
    const line = chompLf(pkt.data);
    if (startsWithAscii(line, 0, "shallow ")) {
      const oid = parseOidHex(line, 8);
      if (!oid || line.length !== 8 + OID_HEX_LENGTH)
        throw malformedLine("expected shallow sha, got", line);
      if (commands.length > 0) throw malformedLine("shallow line after commands", line);
      if (shallow.length >= maxShallow)
        throw limitError("too-many-shallows", "shallow lines", maxShallow);
      shallow.push(oid);
      continue;
    }
    const nul = line.indexOf(0);
    const command = nul < 0 ? line : line.subarray(0, nul);
    if (command.length === 9 && startsWithAscii(command, 0, "push-cert")) {
      throw new ProtocolError("unsupported", "protocol error: push certificates are not supported");
    }
    if (nul >= 0) {
      if (commands.length > 0) throw malformedLine("capabilities after the first command", line);
      capabilities = parseCapabilityList(line.subarray(nul + 1));
    }
    if (commands.length >= maxCommands)
      throw limitError("too-many-commands", "ref updates", maxCommands);
    commands.push(parseCommand(command));
  }
  const format = findCapability(capabilities, "object-format");
  if (format && format.value !== "sha1") {
    throw new ProtocolError(
      "object-format-mismatch",
      `error: unsupported object format '${format.value ?? ""}'`,
    );
  }
  const wantsOptions =
    options.pushOptionsAdvertised && findCapability(capabilities, "push-options");
  const pushOptions = wantsOptions ? await readPushOptions(source, options) : undefined;
  return { shallow, commands, capabilities, pushOptions };
}

async function readPushOptions(
  source: PktLineSource,
  options: ReceivePackRequestOptions,
): Promise<Uint8Array[]> {
  const max = options.maxPushOptions ?? DEFAULT_RECEIVE_PACK_LIMITS.maxPushOptions;
  const out: Uint8Array[] = [];
  for (;;) {
    const pkt = await source.read();
    if (pkt?.kind === "flush") return out;
    if (pkt?.kind !== "data") throw unexpectedPacket(pkt, "push options");
    if (out.length >= max) throw limitError("too-many-push-options", "push options", max);
    out.push(chompLf(pkt.data));
  }
}

const encoder = new TextEncoder();

function checkLine(bytes: Uint8Array, what: string): void {
  if (bytes.includes(0) || bytes.includes(0x0a))
    throw new RangeError(`${what} must not contain NUL or LF`);
}

/**
 * Writes a request the way git's send-pack does, byte for byte: shallow
 * lines with LF, commands and push options without, capabilities after a
 * NUL with a space before each. Throws RangeError on requests that could not
 * be read back.
 */
export function encodeReceivePackRequest(request: ReceivePackRequest): Uint8Array<ArrayBuffer> {
  const asksForOptions = findCapability(request.capabilities, "push-options") !== undefined;
  if ((request.pushOptions !== undefined) !== asksForOptions) {
    throw new RangeError("push options must be sent exactly when push-options is requested");
  }
  if (request.commands.length === 0 && request.capabilities.length > 0) {
    throw new RangeError("capabilities need a command to travel on");
  }
  const caps = encodeCapabilityList(request.capabilities);
  const parts: Uint8Array[] = request.shallow.map((oid) =>
    encodePktLine(`shallow ${oidToHex(oid)}\n`),
  );
  request.commands.forEach((cmd, i) => {
    if (cmd.refName.length === 0) throw new RangeError("ref name must not be empty");
    checkLine(cmd.refName, "ref name");
    const head = encoder.encode(`${oidToHex(cmd.oldOid)} ${oidToHex(cmd.newOid)} `);
    const tail = i === 0 ? [Uint8Array.of(0), encoder.encode(caps === "" ? "" : ` ${caps}`)] : [];
    parts.push(encodePktLine(concatBytes([head, cmd.refName, ...tail])));
  });
  parts.push(flushPkt());
  if (request.pushOptions) {
    for (const option of request.pushOptions) {
      checkLine(option, "push option");
      parts.push(encodePktLine(option));
    }
    parts.push(flushPkt());
  }
  return concatBytes(parts);
}
