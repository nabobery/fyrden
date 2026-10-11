import { oidToHex } from "../../src/object/oid.js";
import { rangeStreamFromStore } from "../../src/pack-write/verbatim.js";
import { encodeV2CapabilityAdvertisement } from "../../src/protocol/capabilities.js";
import { ProtocolError } from "../../src/protocol/errors.js";
import { encodePktLine, flushPkt, PktLineStreamReader } from "../../src/protocol/pktline.js";
import {
  type LsRefsArgs,
  parseFetchArgs,
  parseLsRefsArgs,
  readV2CommandRequest,
} from "../../src/protocol/v2-command.js";
import { ObjectReader } from "../../src/reader/object-reader.js";
import { UploadPackError } from "../../src/upload-pack/errors.js";
import { type FetchPlan, planFetch } from "../../src/upload-pack/fetch.js";
import { peelRefTips } from "../../src/upload-pack/peel.js";
import { renderFetchResponse, uploadPackErrorPacket } from "../../src/upload-pack/response.js";
import {
  appendRequestLog,
  type LoadedUploadPackRepo,
  openUploadPackRepo,
} from "./upload-pack-repo.js";

/*
 * git's upload-pack over a stateful connection (what `git-upload-pack`
 * speaks on stdin and stdout, and what git's `ext::` remote helper
 * connects to), protocol version 2 only, served by the engine from a
 * repository directory. Test support: the request handling here stands in
 * for the Worker and the Durable Object.
 *
 * The protocol version comes from GIT_PROTOCOL, as for `git upload-pack`
 * (git's `ext::` helper passes the environment through but does not set
 * it; the test sets it, as an HTTP client's `Git-Protocol` header would).
 */

export const V2_ONLY_MESSAGE =
  "Fyrden serves fetch and clone over git protocol version 2 only. Use git 2.26 or later and do not set protocol.version to 0 or 1.";

const ADVERTISED = {
  commands: ["ls-refs", "fetch"],
  capabilities: ["agent", "ls-refs", "fetch", "object-format"],
};

export interface ServeIo {
  readonly input: AsyncIterable<Uint8Array>;
  write(bytes: Uint8Array): Promise<void>;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** The highest `version=` in a GIT_PROTOCOL value, as git's server reads it; 0 when unset. */
export function protocolVersion(value: string | undefined): number {
  let version = 0;
  for (const param of (value ?? "").split(":")) {
    const match = /^version=([0-9]+)$/.exec(param);
    if (match) version = Math.max(version, Number(match[1]));
  }
  return version;
}

/**
 * Serves one connection. Returns the process exit code. `load` opens the
 * repository directory (default: the upload-pack directory format).
 */
export async function serveUploadPack(
  service: string,
  dir: string,
  io: ServeIo,
  load: (dir: string) => Promise<LoadedUploadPackRepo> = openUploadPackRepo,
): Promise<number> {
  if (service !== "git-upload-pack") {
    await io.write(uploadPackErrorPacket(`unsupported service ${service}`));
    return 1;
  }
  if (protocolVersion(io.env.GIT_PROTOCOL) !== 2) {
    await io.write(uploadPackErrorPacket(V2_ONLY_MESSAGE));
    return 1;
  }
  const framing = io.env.FYRDEN_UPLOAD_PACK_FRAMING === "stored" ? "stored" : "transport";
  await io.write(
    encodeV2CapabilityAdvertisement([
      { name: "agent", value: "fyrden-test" },
      { name: "ls-refs", value: "unborn" },
      { name: "fetch", value: "shallow" },
      { name: "object-format", value: "sha1" },
    ]),
  );
  const loaded = await load(dir);
  const reader = new PktLineStreamReader(io.input);
  for (;;) {
    let request: Awaited<ReturnType<typeof readV2CommandRequest>>;
    try {
      request = await readV2CommandRequest(reader, ADVERTISED);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      await io.write(uploadPackErrorPacket(error.message));
      return 1;
    }
    if (request === undefined) return 0;
    try {
      if (request.command === "ls-refs") {
        await io.write(await lsRefs(loaded, parseLsRefsArgs(request.args)));
        continue;
      }
      const args = parseFetchArgs(request.args);
      const before = { reads: loaded.packStore.reads, bytes: loaded.packStore.bytes };
      const writesBefore = loaded.packStore.writes;
      const plan = await planFetch(loaded.repository, args, {
        framing,
        stats: loaded.stats,
      });
      await appendRequestLog(dir, {
        command: "fetch",
        plan: plan.pack?.kind,
        cached: plan.pack?.cached,
        objectCount: plan.pack?.objectCount,
        planStoreReads: loaded.packStore.reads - before.reads,
        planStoreBytes: loaded.packStore.bytes - before.bytes,
        materialisedWrites: loaded.packStore.writes - writesBefore,
        transportReads: transportReads(plan),
        leasePacks: plan.leasePacks.length,
      });
      const read = rangeStreamFromStore(loaded.packStore);
      for await (const chunk of renderFetchResponse(plan.parts, read)) await io.write(chunk);
    } catch (error) {
      if (!(error instanceof UploadPackError || error instanceof ProtocolError)) throw error;
      await appendRequestLog(dir, {
        command: request.command,
        planStoreReads: 0,
        planStoreBytes: 0,
        materialisedWrites: 0,
        transportReads: 0,
        leasePacks: 0,
        error: error.message,
      });
      await io.write(uploadPackErrorPacket(error.message));
      return 1;
    }
  }
}

/** Ranged reads the transport makes: one per pack part, one per stitched segment. */
function transportReads(plan: FetchPlan): number {
  let reads = 0;
  for (const part of plan.parts) {
    if (part.kind === "pack") reads++;
    else if (part.kind === "stitched") reads += part.plan.segments.length;
  }
  return reads;
}

const encoder = new TextEncoder();

function startsWith(name: Uint8Array, prefix: Uint8Array): boolean {
  return prefix.length <= name.length && prefix.every((b, i) => name[i] === b);
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return a.length - b.length;
}

/** `ls-refs` as git v2.53.0 ls-refs.c answers it (the Worker has its own copy). */
async function lsRefs(loaded: LoadedUploadPackRepo, args: LsRefsArgs): Promise<Uint8Array> {
  const { refs, commitGraph, view, packStore, zlib, memory } = loaded.repository;
  const matches = (name: string) =>
    args.refPrefixes.length === 0 ||
    args.refPrefixes.some((p) => startsWith(encoder.encode(name), p));
  const listed = [...refs.refs]
    .filter(([name]) => matches(name))
    .sort(([a], [b]) => compareBytes(encoder.encode(a), encoder.encode(b)));
  const headOid = refs.head === null ? undefined : refs.refs.get(refs.head);
  const objects = await ObjectReader.open({ view, packStore, zlib, memory });
  let peeled: Awaited<ReturnType<typeof peelRefTips>>;
  try {
    peeled = args.peel
      ? await peelRefTips(
          [...listed.map(([, oid]) => oid), ...(headOid ? [headOid] : [])],
          commitGraph,
          objects,
        )
      : new Map();
  } finally {
    objects.release();
  }
  const attributes = (hex: string) => {
    const tip = peeled.get(hex);
    return tip?.type === "tag" ? ` peeled:${oidToHex(tip.target)}` : "";
  };
  const parts: Uint8Array[] = [];
  if (refs.head !== null && matches("HEAD")) {
    const symref = args.symrefs ? ` symref-target:${refs.head}` : "";
    if (headOid) {
      const hex = oidToHex(headOid);
      parts.push(encodePktLine(`${hex} HEAD${symref}${attributes(hex)}\n`));
    } else if (args.unborn && args.symrefs) parts.push(encodePktLine(`unborn HEAD${symref}\n`));
  }
  for (const [name, oid] of listed) {
    const hex = oidToHex(oid);
    parts.push(encodePktLine(`${hex} ${name}${attributes(hex)}\n`));
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}
