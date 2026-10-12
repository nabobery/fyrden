import { type Capability, encodePktLine } from "@fyrden/git-core";
import { API_VERSION } from "../rest/mount.js";

/** Sent as `agent=` in every advertisement. */
export const AGENT = `fyrden/${API_VERSION}`;

export type GitService = "git-upload-pack" | "git-receive-pack";

export function isGitService(value: string | undefined): value is GitService {
  return value === "git-upload-pack" || value === "git-receive-pack";
}

/** Content types of git's smart HTTP protocol (gitprotocol-http, "Smart Clients"). */
export const contentType = {
  advertisement: (service: GitService) => `application/x-${service}-advertisement`,
  request: (service: GitService) => `application/x-${service}-request`,
  result: (service: GitService) => `application/x-${service}-result`,
};

/** The headers `git http-backend` sends so no proxy caches a response (http-backend.c `hdr_nocache`). */
export const NO_CACHE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  Expires: "Fri, 01 Jan 1980 00:00:00 GMT",
  Pragma: "no-cache",
  "Cache-Control": "no-cache, max-age=0, must-revalidate",
});

/**
 * Commands and capabilities advertised for protocol v2 upload-pack. git
 * v2.53.0 advertises `fetch=shallow wait-for-done` and `server-option`
 * too; Fyrden leaves out the features it does not implement (no
 * `wait-for-done`, `filter`, `server-option`, `object-info` or `bundle-uri`).
 */
export const UPLOAD_PACK_V2_COMMANDS = ["ls-refs", "fetch"] as const;
export const UPLOAD_PACK_V2_CAPABILITIES: readonly Capability[] = Object.freeze([
  { name: "agent", value: AGENT },
  { name: "ls-refs", value: "unborn" },
  { name: "fetch", value: "shallow" },
  { name: "object-format", value: "sha1" },
]);

/** What a command request may name, for `readV2CommandRequest`. */
export const UPLOAD_PACK_V2_ADVERTISED = Object.freeze({
  commands: [...UPLOAD_PACK_V2_COMMANDS],
  capabilities: UPLOAD_PACK_V2_CAPABILITIES.map((c) => c.name),
});

/**
 * Capabilities of the receive-pack advertisement, in the order git v2.53.0
 * `receive-pack` writes them (receive-pack.c `show_ref`) with
 * `receive.advertisePushOptions` on.
 */
export const RECEIVE_PACK_CAPABILITIES: readonly Capability[] = Object.freeze([
  { name: "report-status" },
  { name: "report-status-v2" },
  { name: "delete-refs" },
  { name: "side-band-64k" },
  { name: "quiet" },
  { name: "atomic" },
  { name: "ofs-delta" },
  { name: "push-options" },
  { name: "object-format", value: "sha1" },
  { name: "agent", value: AGENT },
]);

/**
 * The protocol version a `Git-Protocol` header asks for: colon-separated
 * `key=value` parameters, the highest known `version=` wins, as in git's
 * `determine_protocol_version_server` (protocol.c). No header means 0.
 */
export function requestedProtocolVersion(header: string | undefined): 0 | 1 | 2 {
  let version: 0 | 1 | 2 = 0;
  for (const param of (header ?? "").split(":")) {
    const value = param.startsWith("version=") ? param.slice("version=".length) : undefined;
    if ((value === "1" || value === "2") && Number(value) > version)
      version = Number(value) as 1 | 2;
  }
  return version;
}

/** An `ERR` packet: git clients stop with "remote error: <message>". */
export function errPacket(message: string): Uint8Array<ArrayBuffer> {
  return encodePktLine(`ERR ${message}\n`);
}

export const V2_ONLY_MESSAGE =
  "Fyrden serves fetch and clone over git protocol version 2 only. Use git 2.26 or later and do not set protocol.version to 0 or 1.";

/** The parts, joined into one buffer. */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
