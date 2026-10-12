import { concatBytes, latin1 } from "../object/bytes.js";
import {
  isZeroOid,
  OID_HEX_LENGTH,
  type Oid,
  oidToHex,
  parseOidHex,
  zeroOid,
} from "../object/oid.js";
import { excerpt, malformedLine, ProtocolError, unexpectedPacket } from "./errors.js";
import { chompLf, encodePktLine, flushPkt, type PktLineSource } from "./pktline.js";

/**
 * Capabilities as git exchanges them: a name with an optional value
 * (`name` or `name=value`). Protocol v0/v1 sends them as one space-separated
 * list after a NUL (gitprotocol-capabilities); v2 sends one per line
 * (gitprotocol-v2). Fyrden speaks v0/v1 only for receive-pack, because
 * protocol v2 defines no push.
 */
export interface Capability {
  readonly name: string;
  /** Absent for `name`, the empty string for `name=`. */
  readonly value?: string;
}

export function findCapability(
  capabilities: readonly Capability[],
  name: string,
): Capability | undefined {
  return capabilities.find((c) => c.name === name);
}

const isListByte = (b: number) => b >= 0x21 && b <= 0x7e;

function capability(name: string, value: string | undefined): Capability {
  return value === undefined ? { name } : { name, value };
}

/**
 * Parses a v0/v1 capability list: tokens separated by spaces, each made of
 * printable ASCII. Repeated spaces are ignored, since git's client puts a
 * space before every token, the first included.
 */
export function parseCapabilityList(bytes: Uint8Array): Capability[] {
  const out: Capability[] = [];
  let start = 0;
  for (let i = 0; i <= bytes.length; i++) {
    if (i < bytes.length && bytes[i] !== 0x20) {
      if (!isListByte(bytes[i] as number)) {
        throw new ProtocolError(
          "bad-capability",
          `protocol error: bad capability list '${excerpt(bytes)}'`,
        );
      }
      continue;
    }
    if (i > start) out.push(parseToken(bytes.subarray(start, i)));
    start = i + 1;
  }
  return out;
}

function parseToken(token: Uint8Array): Capability {
  const text = latin1(token);
  const eq = text.indexOf("=");
  const name = eq < 0 ? text : text.slice(0, eq);
  if (name.length === 0) {
    throw new ProtocolError(
      "bad-capability",
      `protocol error: capability without a name '${excerpt(token)}'`,
    );
  }
  return capability(name, eq < 0 ? undefined : text.slice(eq + 1));
}

const LIST_NAME = /^[!-<>-~]+$/;
const LIST_VALUE = /^[!-~]*$/;

function listToken(c: Capability): string {
  if (!LIST_NAME.test(c.name) || (c.value !== undefined && !LIST_VALUE.test(c.value))) {
    throw new RangeError(`capability ${JSON.stringify(c)} cannot be sent in a v0/v1 list`);
  }
  return c.value === undefined ? c.name : `${c.name}=${c.value}`;
}

/** The v0/v1 list form, tokens joined by single spaces. Throws RangeError on what cannot be parsed back. */
export function encodeCapabilityList(capabilities: readonly Capability[]): string {
  return capabilities.map(listToken).join(" ");
}

/** One advertised ref. Names stay bytes: git allows any byte from 0x80 up in them. */
export interface AdvertisedRef {
  readonly oid: Oid;
  readonly name: Uint8Array;
}

export interface RefAdvertisement {
  /** 1 when the advertisement starts with `version 1`, else 0. */
  readonly version: 0 | 1;
  readonly refs: readonly AdvertisedRef[];
  readonly capabilities: readonly Capability[];
}

const encoder = new TextEncoder();
const CAPABILITIES_REF = "capabilities^{}";

function checkRefName(name: Uint8Array): void {
  if (name.length === 0 || name.includes(0) || name.includes(0x0a)) {
    throw new RangeError("advertised ref name must be non-empty, without NUL or LF");
  }
}

/**
 * The v0/v1 ref advertisement that `git receive-pack --advertise-refs`
 * writes: the first ref carries the capabilities after a NUL, an empty
 * repository advertises `capabilities^{}` with the zero id, and a flush ends it.
 */
export function encodeRefAdvertisement(advertisement: {
  refs: readonly AdvertisedRef[];
  capabilities: readonly Capability[];
  version?: 0 | 1;
}): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  if (advertisement.version === 1) parts.push(encodePktLine("version 1\n"));
  const caps = encoder.encode(encodeCapabilityList(advertisement.capabilities));
  const refs =
    advertisement.refs.length > 0
      ? advertisement.refs
      : [{ oid: zeroOid(), name: encoder.encode(CAPABILITIES_REF) }];
  refs.forEach((ref, i) => {
    checkRefName(ref.name);
    const head = encoder.encode(`${oidToHex(ref.oid)} `);
    const tail = i === 0 ? [Uint8Array.of(0), caps] : [];
    parts.push(encodePktLine(concatBytes([head, ref.name, ...tail, Uint8Array.of(0x0a)])));
  });
  parts.push(flushPkt());
  return concatBytes(parts);
}

/** `<oid> SP <name>` with the name running to the end of `line`. */
function parseRefLine(line: Uint8Array): AdvertisedRef {
  const oid = parseOidHex(line, 0);
  if (!oid || line[OID_HEX_LENGTH] !== 0x20)
    throw malformedLine("expected '<oid> <ref>', got", line);
  const name = line.subarray(OID_HEX_LENGTH + 1);
  if (name.length === 0 || name.includes(0)) throw malformedLine("bad ref name in", line);
  return { oid, name };
}

/** Reads a v0/v1 ref advertisement up to its flush. */
export async function readRefAdvertisement(source: PktLineSource): Promise<RefAdvertisement> {
  let version: 0 | 1 = 0;
  let pkt = await source.read();
  if (pkt?.kind === "data" && latin1(chompLf(pkt.data)) === "version 1") {
    version = 1;
    pkt = await source.read();
  }
  const refs: AdvertisedRef[] = [];
  let capabilities: Capability[] = [];
  for (let first = true; pkt?.kind !== "flush"; first = false, pkt = await source.read()) {
    if (pkt?.kind !== "data") throw unexpectedPacket(pkt, "ref advertisement");
    const line = chompLf(pkt.data);
    const nul = line.indexOf(0);
    if (first !== nul >= 0) {
      throw malformedLine(first ? "no capabilities in" : "unexpected NUL in", line);
    }
    const ref = parseRefLine(first ? line.subarray(0, nul) : line);
    if (first) capabilities = parseCapabilityList(line.subarray(nul + 1));
    const placeholder = first && isZeroOid(ref.oid) && latin1(ref.name) === CAPABILITIES_REF;
    if (!placeholder) refs.push(ref);
  }
  return { version, refs, capabilities };
}

const V2_KEY = /^[A-Za-z0-9_-]+$/;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** Splits a v2 capability line at its first '='; the key is checked by the caller. */
export function splitV2Capability(line: Uint8Array): {
  key: string;
  value: Uint8Array | undefined;
} {
  const eq = line.indexOf(0x3d);
  return eq < 0
    ? { key: latin1(line), value: undefined }
    : { key: latin1(line.subarray(0, eq)), value: line.subarray(eq + 1) };
}

/** A v2 capability value: any UTF-8 text without NUL or LF (server options may contain spaces). */
export function decodeV2Value(value: Uint8Array, line: Uint8Array): string {
  if (value.includes(0) || value.includes(0x0a)) {
    throw new ProtocolError(
      "bad-capability",
      `protocol error: bad capability value '${excerpt(line)}'`,
    );
  }
  try {
    return utf8.decode(value);
  } catch {
    throw new ProtocolError(
      "bad-capability",
      `protocol error: capability value is not UTF-8 '${excerpt(line)}'`,
    );
  }
}

/** Checks a v2 capability for encoding and returns its line, with LF. Throws RangeError. */
export function v2CapabilityLine(c: Capability): string {
  if (!V2_KEY.test(c.name) || (c.value !== undefined && /[\0\n]/.test(c.value))) {
    throw new RangeError(`capability ${JSON.stringify(c)} cannot be sent in protocol v2`);
  }
  return c.value === undefined ? `${c.name}\n` : `${c.name}=${c.value}\n`;
}

/** The v2 capability advertisement: `version 2`, one line per capability, flush. */
export function encodeV2CapabilityAdvertisement(
  capabilities: readonly Capability[],
): Uint8Array<ArrayBuffer> {
  return concatBytes([
    encodePktLine("version 2\n"),
    ...capabilities.map((c) => encodePktLine(v2CapabilityLine(c))),
    flushPkt(),
  ]);
}

/** Reads a v2 capability advertisement up to its flush. */
export async function readV2CapabilityAdvertisement(source: PktLineSource): Promise<Capability[]> {
  const first = await source.read();
  if (first?.kind !== "data") throw unexpectedPacket(first, "capability advertisement");
  if (latin1(chompLf(first.data)) !== "version 2")
    throw malformedLine("expected 'version 2', got", first.data);
  const out: Capability[] = [];
  for (;;) {
    const pkt = await source.read();
    if (pkt?.kind === "flush") return out;
    if (pkt?.kind !== "data") throw unexpectedPacket(pkt, "capability advertisement");
    const line = chompLf(pkt.data);
    const { key, value } = splitV2Capability(line);
    if (!V2_KEY.test(key)) {
      throw new ProtocolError(
        "bad-capability",
        `protocol error: bad capability '${excerpt(line)}'`,
      );
    }
    out.push(capability(key, value === undefined ? undefined : decodeV2Value(value, line)));
  }
}
