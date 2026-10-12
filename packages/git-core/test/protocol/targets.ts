import {
  readRefAdvertisement,
  readV2CapabilityAdvertisement,
} from "../../src/protocol/capabilities.js";
import {
  type PktLineLimits,
  PktLineReader,
  type PktLineSource,
  PktLineStreamReader,
} from "../../src/protocol/pktline.js";
import {
  type ReceivePackRequestOptions,
  readReceivePackRequest,
} from "../../src/protocol/receive-pack-request.js";
import { demultiplexSideband } from "../../src/protocol/sideband.js";
import {
  type FetchArgsOptions,
  parseFetchArgs,
  parseLsRefsArgs,
  readV2CommandRequest,
  type V2Advertised,
} from "../../src/protocol/v2-command.js";
import { chunked } from "./helpers.js";

/** The parsers a corpus case or fuzz input can be fed to. */
export const TARGETS = [
  "pkt-line",
  "sideband",
  "v2-request",
  "receive-pack",
  "ref-advertisement",
  "v2-advertisement",
] as const;
export type Target = (typeof TARGETS)[number];

export interface TargetLimits extends PktLineLimits, FetchArgsOptions {
  readonly maxCommands?: number;
  readonly maxShallow?: number;
  readonly maxPushOptions?: number;
}

/** The commands and capabilities Fyrden's upload-pack is to advertise (a Proposed set). */
export const FYRDEN_V2: V2Advertised = {
  commands: ["ls-refs", "fetch"],
  capabilities: ["agent", "server-option", "object-format"],
};

async function drain(source: PktLineSource): Promise<void> {
  while ((await source.read()) !== undefined) {}
}

/** Every v2 request in the input, with each command's arguments parsed, until the session ends. */
async function v2Session(source: PktLineSource, limits: TargetLimits): Promise<void> {
  for (;;) {
    const request = await readV2CommandRequest(source, FYRDEN_V2);
    if (!request) return;
    if (request.command === "fetch") parseFetchArgs(request.args, limits);
    else parseLsRefsArgs(request.args);
  }
}

async function receivePack(source: PktLineSource, limits: TargetLimits): Promise<void> {
  const options: ReceivePackRequestOptions = { pushOptionsAdvertised: true, ...limits };
  await readReceivePackRequest(source, options);
}

async function sideband(source: PktLineSource): Promise<void> {
  for await (const _ of demultiplexSideband(source)) {
  }
}

const RUN: Record<Target, (source: PktLineSource, limits: TargetLimits) => Promise<unknown>> = {
  "pkt-line": drain,
  sideband,
  "v2-request": v2Session,
  "receive-pack": receivePack,
  "ref-advertisement": readRefAdvertisement,
  "v2-advertisement": readV2CapabilityAdvertisement,
};

/** Feeds `bytes` to a target from a buffer, or from a stream cut at `cuts` when given. */
export function runTarget(
  target: Target,
  bytes: Uint8Array,
  limits: TargetLimits = {},
  cuts?: readonly number[],
): Promise<unknown> {
  const source = cuts
    ? new PktLineStreamReader(chunked(bytes, cuts), limits)
    : new PktLineReader(bytes, limits);
  return RUN[target](source, limits);
}
