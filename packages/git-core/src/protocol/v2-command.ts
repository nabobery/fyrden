import { concatBytes, latin1, startsWithAscii } from "../object/bytes.js";
import { OID_HEX_LENGTH, type Oid, oidToHex, parseOidHex } from "../object/oid.js";
import {
  type Capability,
  decodeV2Value,
  findCapability,
  splitV2Capability,
  v2CapabilityLine,
} from "./capabilities.js";
import { excerpt, malformedLine, ProtocolError, unexpectedPacket } from "./errors.js";
import { chompLf, delimPkt, encodePktLine, flushPkt, type PktLineSource } from "./pktline.js";

/**
 * Protocol v2 command requests (gitprotocol-v2, "Command Request"; git
 * v2.53.0 serve.c `process_request`, upload-pack.c `process_args`, ls-refs.c,
 * verified):
 *
 *   PKT-LINE("command=" key) *PKT-LINE(capability) delim *PKT-LINE(arg) flush
 *
 * The delim and arguments may be left out (the flush then ends the request);
 * a lone flush ends the session.
 */
export interface V2CommandRequest {
  readonly command: string;
  readonly capabilities: readonly Capability[];
  /** Command arguments, without their trailing LF; parsed per command. */
  readonly args: readonly Uint8Array[];
}

/** What the server advertised: command names and the other capability names. */
export interface V2Advertised {
  readonly commands: readonly string[];
  readonly capabilities: readonly string[];
}

const COMMAND_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * Reads one command request. Returns undefined when the client ends the
 * session (a flush, or the end of input, before any line). As in git, a
 * capability the server did not advertise, or a command used as one, is an
 * error; only SHA-1 is accepted as the object format.
 */
export async function readV2CommandRequest(
  source: PktLineSource,
  advertised: V2Advertised,
): Promise<V2CommandRequest | undefined> {
  let pkt = await source.read();
  if (pkt === undefined || pkt.kind === "flush") return undefined;
  let command: string | undefined;
  const capabilities: Capability[] = [];
  for (; pkt?.kind !== "flush" && pkt?.kind !== "delim"; pkt = await source.read()) {
    if (pkt?.kind !== "data") throw unexpectedPacket(pkt, "command request");
    const line = chompLf(pkt.data);
    if (startsWithAscii(line, 0, "command=")) {
      const name = latin1(line.subarray(8));
      if (command !== undefined) {
        throw new ProtocolError(
          "duplicate-command",
          `command '${excerpt(line.subarray(8))}' requested after already requesting command '${command}'`,
        );
      }
      if (!advertised.commands.includes(name)) {
        throw new ProtocolError(
          "unknown-command",
          `invalid command '${excerpt(line.subarray(8))}'`,
        );
      }
      command = name;
      continue;
    }
    const { key, value } = splitV2Capability(line);
    if (!advertised.capabilities.includes(key) || advertised.commands.includes(key)) {
      throw new ProtocolError("unknown-capability", `unknown capability '${excerpt(line)}'`);
    }
    capabilities.push(
      value === undefined ? { name: key } : { name: key, value: decodeV2Value(value, line) },
    );
  }
  if (command === undefined) throw new ProtocolError("no-command", "no command requested");
  const format = findCapability(capabilities, "object-format");
  if (format && format.value !== "sha1") {
    throw new ProtocolError(
      "object-format-mismatch",
      `mismatched object format: server sha1; client ${excerpt(new TextEncoder().encode(format.value ?? ""))}`,
    );
  }
  const args: Uint8Array[] = [];
  if (pkt.kind === "delim") {
    for (;;) {
      const arg = await source.read();
      if (arg?.kind === "flush") break;
      if (arg?.kind !== "data") {
        if (arg === undefined) throw unexpectedPacket(arg, `${command} arguments`);
        throw new ProtocolError("unexpected-packet", `expected flush after ${command} arguments`);
      }
      args.push(chompLf(arg.data));
    }
  }
  return { command, capabilities, args };
}

/**
 * Writes a command request with every line LF-terminated, as gitprotocol-v2
 * specifies (git's own client leaves the LF off some lines). Throws
 * RangeError on what could not be read back.
 */
export function encodeV2CommandRequest(request: V2CommandRequest): Uint8Array<ArrayBuffer> {
  if (!COMMAND_KEY.test(request.command))
    throw new RangeError(`bad command name ${JSON.stringify(request.command)}`);
  const parts: Uint8Array[] = [encodePktLine(`command=${request.command}\n`)];
  for (const c of request.capabilities) parts.push(encodePktLine(v2CapabilityLine(c)));
  parts.push(delimPkt());
  for (const arg of request.args) {
    if (arg.includes(0x0a)) throw new RangeError("command argument must not contain LF");
    parts.push(encodePktLine(concatBytes([arg, Uint8Array.of(0x0a)])));
  }
  parts.push(flushPkt());
  return concatBytes(parts);
}

const unexpectedArgument = (arg: Uint8Array) =>
  new ProtocolError("unexpected-argument", `unexpected line: '${excerpt(arg)}'`);

export interface LsRefsArgs {
  readonly peel: boolean;
  readonly symrefs: boolean;
  readonly unborn: boolean;
  /** Empty means every ref. */
  readonly refPrefixes: readonly Uint8Array[];
}

/**
 * Parses `ls-refs` arguments. As in git, more than `maxRefPrefixes`
 * prefixes (default 65535, git's TOO_MANY_PREFIXES less one) drops them all:
 * prefixes only narrow the listing, so listing everything is still correct.
 */
export function parseLsRefsArgs(
  args: readonly Uint8Array[],
  options: { readonly maxRefPrefixes?: number } = {},
): LsRefsArgs {
  const maxRefPrefixes = options.maxRefPrefixes ?? 65_535;
  let peel = false;
  let symrefs = false;
  let unborn = false;
  let refPrefixes: Uint8Array[] = [];
  let tooMany = false;
  for (const arg of args) {
    const text = latin1(arg);
    if (text === "peel") peel = true;
    else if (text === "symrefs") symrefs = true;
    else if (text === "unborn") unborn = true;
    else if (text.startsWith("ref-prefix ")) {
      if (refPrefixes.length < maxRefPrefixes) refPrefixes.push(arg.subarray(11));
      else tooMany = true;
    } else throw unexpectedArgument(arg);
  }
  if (tooMany) refPrefixes = [];
  return { peel, symrefs, unborn, refPrefixes };
}

export interface FetchArgs {
  /** Without repeats, in first-seen order. */
  readonly wants: readonly Oid[];
  /** Without repeats, in first-seen order. */
  readonly haves: readonly Oid[];
  readonly done: boolean;
  readonly thinPack: boolean;
  readonly noProgress: boolean;
  readonly includeTag: boolean;
  readonly ofsDelta: boolean;
  readonly shallow: readonly Oid[];
  readonly deepen: number | undefined;
  readonly deepenRelative: boolean;
  /** Seconds since the epoch. */
  readonly deepenSince: number | undefined;
  /** Ref names, as bytes, resolved by the caller. */
  readonly deepenNot: readonly Uint8Array[];
}

export interface FetchArgsOptions {
  readonly maxWants?: number;
  readonly maxHaves?: number;
  readonly maxShallow?: number;
  readonly maxDeepenNot?: number;
}

/** Proposed defaults; tuned under load. Git itself has no such limits. */
export const DEFAULT_FETCH_LIMITS = Object.freeze({
  maxWants: 100_000,
  maxHaves: 100_000,
  maxShallow: 100_000,
  maxDeepenNot: 1_000,
});

const FLAGS = {
  done: "done",
  "thin-pack": "thinPack",
  "no-progress": "noProgress",
  "include-tag": "includeTag",
  "ofs-delta": "ofsDelta",
  "deepen-relative": "deepenRelative",
} as const;

/** Largest depth: git parses `deepen` into an int. */
const MAX_DEPTH = 2 ** 31 - 1;

class OidList {
  readonly list: Oid[] = [];
  readonly #seen = new Set<string>();
  #lines = 0;
  constructor(
    readonly word: string,
    readonly max: number,
    readonly code: "too-many-wants" | "too-many-haves" | "too-many-shallows",
  ) {}

  /** Parses `<word> <oid>`, counting the line even when the oid repeats. */
  add(arg: Uint8Array): void {
    const oid = parseOidHex(arg, this.word.length + 1);
    if (!oid || arg.length !== this.word.length + 1 + OID_HEX_LENGTH) {
      throw malformedLine(`expected to get oid, not`, arg);
    }
    if (++this.#lines > this.max) {
      throw new ProtocolError(
        this.code,
        `protocol error: more than ${this.max} ${this.word} lines`,
      );
    }
    const key = oidToHex(oid);
    if (this.#seen.has(key)) return;
    this.#seen.add(key);
    this.list.push(oid);
  }
}

function badArgument(arg: Uint8Array): ProtocolError {
  return new ProtocolError("bad-argument", `invalid argument: '${excerpt(arg)}'`);
}

/**
 * Parses `fetch` arguments. Accepted are the base arguments and those of the
 * `shallow` feature; the features Fyrden does not advertise (filter,
 * ref-in-want, sideband-all, packfile-uris, wait-for-done) are refused like
 * unknown lines. Numbers must be plain decimal, which is what git writes.
 */
export function parseFetchArgs(
  args: readonly Uint8Array[],
  options: FetchArgsOptions = {},
): FetchArgs {
  const wants = new OidList(
    "want",
    options.maxWants ?? DEFAULT_FETCH_LIMITS.maxWants,
    "too-many-wants",
  );
  const haves = new OidList(
    "have",
    options.maxHaves ?? DEFAULT_FETCH_LIMITS.maxHaves,
    "too-many-haves",
  );
  const shallow = new OidList(
    "shallow",
    options.maxShallow ?? DEFAULT_FETCH_LIMITS.maxShallow,
    "too-many-shallows",
  );
  const maxDeepenNot = options.maxDeepenNot ?? DEFAULT_FETCH_LIMITS.maxDeepenNot;
  const flags = {
    done: false,
    thinPack: false,
    noProgress: false,
    includeTag: false,
    ofsDelta: false,
    deepenRelative: false,
  };
  let deepen: number | undefined;
  let deepenSince: number | undefined;
  const deepenNot: Uint8Array[] = [];
  for (const arg of args) {
    const text = latin1(arg);
    const space = text.indexOf(" ");
    const word = space < 0 ? text : text.slice(0, space);
    const value = space < 0 ? undefined : text.slice(space + 1);
    if (value === undefined && Object.hasOwn(FLAGS, word)) {
      flags[FLAGS[word as keyof typeof FLAGS]] = true;
    } else if (word === "want" && value !== undefined) wants.add(arg);
    else if (word === "have" && value !== undefined) haves.add(arg);
    else if (word === "shallow" && value !== undefined) shallow.add(arg);
    else if (word === "deepen" && value !== undefined) {
      if (!/^[1-9][0-9]{0,9}$/.test(value) || Number(value) > MAX_DEPTH) throw badArgument(arg);
      deepen = Number(value);
    } else if (word === "deepen-since" && value !== undefined) {
      if (!/^[0-9]{1,16}$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw badArgument(arg);
      deepenSince = Number(value);
    } else if (word === "deepen-not" && value !== undefined) {
      if (value === "") throw badArgument(arg);
      if (deepenNot.length >= maxDeepenNot) {
        throw new ProtocolError(
          "too-many-arguments",
          `protocol error: more than ${maxDeepenNot} deepen-not lines`,
        );
      }
      deepenNot.push(arg.subarray(11));
    } else throw unexpectedArgument(arg);
  }
  if (deepen !== undefined && (deepenSince !== undefined || deepenNot.length > 0)) {
    throw new ProtocolError(
      "bad-argument",
      "deepen and deepen-since (or deepen-not) cannot be used together",
    );
  }
  return {
    wants: wants.list,
    haves: haves.list,
    ...flags,
    shallow: shallow.list,
    deepen,
    deepenSince,
    deepenNot,
  };
}
