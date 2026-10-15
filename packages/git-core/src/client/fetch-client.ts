import { concatBytes, latin1, startsWithAscii } from "../object/bytes.js";
import { OID_HEX_LENGTH, type Oid, oidToHex, parseOidHex } from "../object/oid.js";
import { type Capability, readV2CapabilityAdvertisement } from "../protocol/capabilities.js";
import { excerpt, malformedLine, ProtocolError, unexpectedPacket } from "../protocol/errors.js";
import {
  chompLf,
  type PktLine,
  type PktLineSource,
  PktLineStreamReader,
} from "../protocol/pktline.js";
import { demultiplexSideband, SIDEBAND_64K_MAX_PAYLOAD } from "../protocol/sideband.js";
import { encodeV2CommandRequest } from "../protocol/v2-command.js";
import type { ClientResponse, HttpTransport } from "./transport.js";

/*
 * A git client for the smart HTTP protocol, version 2 only, fetch side
 * (gitprotocol-http, gitprotocol-v2; git v2.53.0 remote-curl.c and
 * connect.c, verified): discover the capabilities with
 * `GET <repo>/info/refs?service=git-upload-pack` and `Git-Protocol:
 * version=2`, then `POST <repo>/git-upload-pack` once per command
 * (`ls-refs`, `fetch`). Used by server-side import, which has nothing yet,
 * so a fetch sends its wants and `done` in one request and reads the pack
 * from the `packfile` section, demultiplexed from side-band.
 */

export type FetchClientErrorCode =
  /** The server answered with an HTTP status other than 200. */
  | "http-status"
  /** Not a smart-HTTP answer (a dumb server, a web page). */
  | "not-smart"
  /** The server does not speak protocol v2. */
  | "no-v2"
  /** The server lacks a command or uses an object format this client does not. */
  | "unsupported"
  /** The server reported an error (`ERR` or side-band 3). */
  | "remote-error"
  /** More refs or pack bytes than the limits allow. */
  | "too-large"
  /** The fetch response ended without a usable pack. */
  | "no-pack";

/** Why talking to the server failed, other than malformed protocol (`ProtocolError`). */
export class FetchClientError extends Error {
  override readonly name = "FetchClientError";
  constructor(
    readonly code: FetchClientErrorCode,
    message: string,
    /** The HTTP status, for `http-status`. */
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface FetchClientLimits {
  /** Bytes of the capability advertisement. */
  readonly maxAdvertisementBytes: number;
  /** Refs in one `ls-refs` answer. */
  readonly maxRefs: number;
  /** Bytes of one `ls-refs` answer. */
  readonly maxRefListBytes: number;
  /** Pack bytes of one fetch. */
  readonly maxPackBytes: number;
}

/** Proposed defaults; callers with their own bounds (import) pass them. */
export const DEFAULT_FETCH_CLIENT_LIMITS: FetchClientLimits = Object.freeze({
  maxAdvertisementBytes: 1024 * 1024,
  maxRefs: 100_000,
  maxRefListBytes: 32 * 1024 * 1024,
  maxPackBytes: 4 * 1024 * 1024 * 1024,
});

export interface FetchClientOptions {
  readonly transport: HttpTransport;
  /** The repository URL, as `git clone` takes it (`https://host/owner/repo.git`). */
  readonly url: string;
  /** Sent as `agent=` and in the User-Agent (`git/<agent>`). Default "fyrden". */
  readonly agent?: string;
  readonly limits?: Partial<FetchClientLimits>;
}

/** One ref from `ls-refs`. The name stays bytes: whether it is acceptable is the caller's policy. */
export interface RemoteRef {
  readonly name: Uint8Array;
  readonly oid: Oid;
  /** With `symrefs`: the ref a symbolic ref (HEAD) points at. */
  readonly symrefTarget?: Uint8Array;
  /** With `peel`: what an annotated tag points at. */
  readonly peeled?: Oid;
}

export interface LsRefsRequest {
  /** `ref-prefix` arguments; none lists every ref. */
  readonly prefixes?: readonly string[];
  readonly symrefs?: boolean;
  readonly peel?: boolean;
}

/** Where fetched pack bytes go, in order. */
export interface FetchPackSink {
  write(chunk: Uint8Array): void | Promise<void>;
}

export interface FetchPackOptions {
  /** Side-band 2 text; when absent the client asks for `no-progress`. */
  readonly onProgress?: (text: string) => void;
}

const ADVERTISEMENT_TYPE = "application/x-git-upload-pack-advertisement";
const RESULT_TYPE = "application/x-git-upload-pack-result";
const REQUEST_TYPE = "application/x-git-upload-pack-request";

const SYMREF_TARGET = "symref-target:";
const PEELED = "peeled:";

/**
 * Parses one `ls-refs` line without its LF:
 * `obj-id SP refname *(SP ref-attribute)`, attributes `symref-target:<ref>`
 * and `peeled:<obj-id>`. Ref names cannot contain a space
 * (`check_refname_format`), so fields split on spaces. Attributes this
 * client does not know are skipped, so a newer server's additions do not
 * break it. Throws `ProtocolError`.
 */
export function parseLsRefsLine(line: Uint8Array): RemoteRef {
  const oid = parseOidHex(line, 0);
  if (!oid || line[OID_HEX_LENGTH] !== 0x20) throw malformedLine("bad ls-refs line", line);
  const fields: Uint8Array[] = [];
  let start = OID_HEX_LENGTH + 1;
  for (let i = start; i <= line.length; i++) {
    if (i === line.length || line[i] === 0x20) {
      fields.push(line.subarray(start, i));
      start = i + 1;
    }
  }
  const [name, ...attributes] = fields;
  if (!name || name.length === 0) throw malformedLine("bad ls-refs line", line);
  let symrefTarget: Uint8Array | undefined;
  let peeled: Oid | undefined;
  for (const attribute of attributes) {
    if (startsWithAscii(attribute, 0, SYMREF_TARGET)) {
      const target = attribute.subarray(SYMREF_TARGET.length);
      if (target.length === 0 || symrefTarget) throw malformedLine("bad ls-refs line", line);
      symrefTarget = target;
    } else if (startsWithAscii(attribute, 0, PEELED)) {
      const value = parseOidHex(attribute, PEELED.length);
      if (!value || attribute.length !== PEELED.length + OID_HEX_LENGTH || peeled)
        throw malformedLine("bad ls-refs line", line);
      peeled = value;
    } else if (attribute.length === 0) {
      throw malformedLine("bad ls-refs line", line);
    }
  }
  return {
    name,
    oid,
    ...(symrefTarget ? { symrefTarget } : {}),
    ...(peeled ? { peeled } : {}),
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function mediaType(contentType: string | null): string {
  return (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/** `ERR <message>` from the server (a pkt-line the client must report, gitprotocol-v2). */
function remoteErrorOf(data: Uint8Array): FetchClientError | undefined {
  if (!startsWithAscii(data, 0, "ERR ")) return undefined;
  return new FetchClientError(
    "remote-error",
    `remote error: ${decoder.decode(chompLf(data.subarray(4)))}`,
  );
}

/**
 * `url` without its trailing slashes. A loop, not /\/+$/: that regex
 * backtracks quadratically on many slashes that do not end the string, and
 * the URL is a caller's input.
 */
export function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 0x2f) end--;
  return url.slice(0, end);
}

/** A packet source that hands back one packet it was given first. */
function withFirst(first: PktLine, rest: PktLineSource): PktLineSource {
  let pending: PktLine | undefined = first;
  return {
    read() {
      if (!pending) return rest.read();
      const out = pending;
      pending = undefined;
      return out;
    },
  };
}

export class SmartHttpClient {
  readonly #base: string;
  readonly #agent: string;
  readonly #transport: HttpTransport;
  readonly #limits: FetchClientLimits;
  readonly #requestCaps: Capability[];

  private constructor(
    options: FetchClientOptions,
    /** What the server advertised. */
    readonly capabilities: readonly Capability[],
  ) {
    this.#base = withoutTrailingSlashes(options.url);
    this.#agent = options.agent ?? "fyrden";
    this.#transport = options.transport;
    this.#limits = { ...DEFAULT_FETCH_CLIENT_LIMITS, ...options.limits };
    // object-format is sent only when the server named one (as git's client does).
    const format = capabilities.find((c) => c.name === "object-format");
    this.#requestCaps = [
      { name: "agent", value: this.#agent },
      ...(format ? [{ name: "object-format", value: "sha1" }] : []),
    ];
  }

  /** Reads the server's protocol v2 capabilities; refuses servers that cannot serve a fetch. */
  static async connect(options: FetchClientOptions): Promise<SmartHttpClient> {
    const limits = { ...DEFAULT_FETCH_CLIENT_LIMITS, ...options.limits };
    const base = withoutTrailingSlashes(options.url);
    const response = await options.transport({
      method: "GET",
      url: `${base}/info/refs?service=git-upload-pack`,
      headers: {
        "Git-Protocol": "version=2",
        "User-Agent": `git/${options.agent ?? "fyrden"}`,
        Accept: "*/*",
      },
    });
    const capabilities = await readAdvertisement(response, limits);
    const names = new Set(capabilities.map((c) => c.name));
    for (const command of ["ls-refs", "fetch"]) {
      if (!names.has(command))
        throw new FetchClientError("unsupported", `the server does not offer ${command}`);
    }
    const format = capabilities.find((c) => c.name === "object-format");
    if (format && format.value !== "sha1") {
      throw new FetchClientError(
        "unsupported",
        `the server's object format ${format.value ?? "(none)"} is not supported`,
      );
    }
    return new SmartHttpClient(options, capabilities);
  }

  /** `ls-refs`: the server's refs (names as bytes). */
  async lsRefs(request: LsRefsRequest = {}): Promise<RemoteRef[]> {
    const args: string[] = [];
    if (request.symrefs) args.push("symrefs");
    if (request.peel) args.push("peel");
    for (const prefix of request.prefixes ?? []) args.push(`ref-prefix ${prefix}`);
    const response = await this.#post("ls-refs", args);
    const reader = new PktLineStreamReader(response.body, {
      maxBytes: this.#limits.maxRefListBytes,
      maxLines: this.#limits.maxRefs + 1,
    });
    const refs: RemoteRef[] = [];
    try {
      for (;;) {
        const pkt = await reader.read();
        if (pkt === undefined)
          throw new ProtocolError("truncated", "the remote end hung up unexpectedly");
        if (pkt.kind === "flush") return refs;
        if (pkt.kind !== "data") throw unexpectedPacket(pkt, "ls-refs response");
        const error = remoteErrorOf(pkt.data);
        if (error) throw error;
        refs.push(parseLsRefsLine(chompLf(pkt.data)));
      }
    } catch (error) {
      await response.cancel();
      if (error instanceof ProtocolError && error.code === "too-many-lines")
        throw new FetchClientError(
          "too-large",
          `the server lists more than ${this.#limits.maxRefs} refs`,
        );
      if (error instanceof ProtocolError && error.code === "too-many-bytes")
        throw new FetchClientError("too-large", "the server's ref list is too large");
      throw error;
    }
  }

  /**
   * `fetch` with `wants` and `done` (no haves): writes the pack to `sink`
   * as it arrives. The pack is not checked here beyond its signature; the
   * caller indexes it. Returns the pack's length.
   */
  async fetchPack(
    wants: readonly Oid[],
    sink: FetchPackSink,
    options: FetchPackOptions = {},
  ): Promise<{ bytes: number }> {
    if (wants.length === 0) throw new RangeError("a fetch needs at least one want");
    const args = ["ofs-delta"];
    if (!options.onProgress) args.push("no-progress");
    for (const want of wants) args.push(`want ${oidToHex(want)}`);
    args.push("done");
    const response = await this.#post("fetch", args);
    // Side-band framing adds 5 bytes per 65,515 payload bytes; sections add a few lines.
    const framing = Math.ceil(this.#limits.maxPackBytes / SIDEBAND_64K_MAX_PAYLOAD) * 5;
    const reader = new PktLineStreamReader(response.body, {
      maxBytes: this.#limits.maxPackBytes + framing + 1024 * 1024,
      maxLines: Number.MAX_SAFE_INTEGER,
    });
    try {
      for (;;) {
        const pkt = await reader.read();
        if (pkt === undefined)
          throw new ProtocolError("truncated", "the remote end hung up unexpectedly");
        if (pkt.kind !== "data")
          throw new FetchClientError("no-pack", "the fetch response ended without a pack");
        const error = remoteErrorOf(pkt.data);
        if (error) throw error;
        const section = latin1(chompLf(pkt.data));
        if (section === "packfile") return await this.#readPack(reader, sink, options);
        await skipSection(reader, pkt.data);
      }
    } catch (error) {
      await response.cancel();
      if (error instanceof ProtocolError && error.code === "too-many-bytes") throw this.#tooLarge();
      throw error;
    }
  }

  async #readPack(
    reader: PktLineSource,
    sink: FetchPackSink,
    options: FetchPackOptions,
  ): Promise<{ bytes: number }> {
    let bytes = 0;
    let signature = new Uint8Array(0);
    for await (const frame of demultiplexSideband(reader)) {
      if (frame.band === 3) {
        throw new FetchClientError(
          "remote-error",
          `remote error: ${decoder.decode(chompLf(frame.payload))}`,
        );
      }
      if (frame.band === 2) {
        options.onProgress?.(decoder.decode(frame.payload));
        continue;
      }
      if (frame.payload.length === 0) continue;
      bytes += frame.payload.length;
      if (bytes > this.#limits.maxPackBytes) throw this.#tooLarge();
      if (signature.length < 4) {
        signature = concatBytes([signature, frame.payload.subarray(0, 4 - signature.length)]);
        if (signature.length === 4 && latin1(signature) !== "PACK")
          throw new FetchClientError("no-pack", "the fetch response is not a pack");
      }
      await sink.write(frame.payload);
    }
    // Header (12 bytes) and trailer (20 bytes) at least.
    if (bytes < 32) throw new FetchClientError("no-pack", "the fetch response held no pack");
    return { bytes };
  }

  #tooLarge(): FetchClientError {
    return new FetchClientError(
      "too-large",
      `the pack is larger than ${this.#limits.maxPackBytes} bytes`,
    );
  }

  async #post(command: string, args: readonly string[]): Promise<ClientResponse> {
    const body = encodeV2CommandRequest({
      command,
      capabilities: this.#requestCaps,
      args: args.map((arg) => encoder.encode(arg)),
    });
    const response = await this.#transport({
      method: "POST",
      url: `${this.#base}/git-upload-pack`,
      headers: {
        "Content-Type": REQUEST_TYPE,
        Accept: RESULT_TYPE,
        "Git-Protocol": "version=2",
        "User-Agent": `git/${this.#agent}`,
      },
      body,
    });
    await expectResponse(response, RESULT_TYPE);
    return response;
  }
}

async function expectResponse(response: ClientResponse, type: string): Promise<void> {
  if (response.status !== 200) {
    await response.cancel();
    throw new FetchClientError(
      "http-status",
      `the server answered HTTP ${response.status}`,
      response.status,
    );
  }
  if (mediaType(response.contentType) !== type) {
    await response.cancel();
    throw new FetchClientError(
      "not-smart",
      `the server answered ${excerpt(encoder.encode(response.contentType ?? "no content type"))}, not ${type}`,
    );
  }
}

async function readAdvertisement(
  response: ClientResponse,
  limits: FetchClientLimits,
): Promise<Capability[]> {
  await expectResponse(response, ADVERTISEMENT_TYPE);
  const reader = new PktLineStreamReader(response.body, {
    maxBytes: limits.maxAdvertisementBytes,
    maxLines: 10_000,
  });
  try {
    let first = await reader.read();
    // A v0-style service header, which some servers send before the v2 advertisement.
    if (first?.kind === "data" && startsWithAscii(first.data, 0, "# service=")) {
      const flush = await reader.read();
      if (flush?.kind !== "flush")
        throw malformedLine("expected flush after service header", first.data);
      first = await reader.read();
    }
    if (first === undefined)
      throw new ProtocolError("truncated", "the remote end hung up unexpectedly");
    if (first.kind !== "data" || latin1(chompLf(first.data)) !== "version 2") {
      throw new FetchClientError("no-v2", "the server does not speak git protocol version 2");
    }
    return await readV2CapabilityAdvertisement(withFirst(first, reader));
  } catch (error) {
    await response.cancel();
    throw error;
  }
}

/** Skips a response section other than `packfile` up to its delimiter. */
async function skipSection(reader: PktLineSource, header: Uint8Array): Promise<void> {
  for (;;) {
    const pkt = await reader.read();
    if (pkt === undefined)
      throw new ProtocolError("truncated", "the remote end hung up unexpectedly");
    if (pkt.kind === "delim") return;
    if (pkt.kind === "flush" || pkt.kind === "response-end")
      throw new FetchClientError(
        "no-pack",
        `the fetch response ended after ${excerpt(chompLf(header))} without a pack`,
      );
  }
}
