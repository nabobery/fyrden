import { concatBytes, latin1Bytes } from "../object/bytes.js";
import { encodePktLine, flushPkt } from "../protocol/pktline.js";
import {
  encodeSideband,
  SIDEBAND_DATA,
  SIDEBAND_ERROR,
  SIDEBAND_PROGRESS,
} from "../protocol/sideband.js";
import type { PushCapabilities, PushCommandState } from "./commands.js";

/*
 * The receive-pack response after the request has been read (git v2.53.0
 * builtin/receive-pack.c `report`, `report_v2`, `cmd_receive_pack`,
 * verified): messages on side-band 2, then the status report (pkt-lines
 * ending in a flush), wrapped in side-band 1 when side-band was asked for,
 * then a final flush when side-band is in use. Every response, refusals
 * included, is sent with HTTP status 200: git discards the body of a
 * response with a status of 300 or more.
 */

export interface PushReport {
  /** Why the pack could not be unpacked; undefined for `unpack ok`. */
  readonly unpackError: string | undefined;
  readonly commands: readonly Pick<PushCommandState, "refName" | "error">[];
}

const encoder = new TextEncoder();

/**
 * The status report: `unpack ok` (or `unpack <reason>`), then `ok <ref>` or
 * `ng <ref> <reason>` per command, then a flush. Without proc-receive
 * rewrites, report-status-v2 has no `option` lines and is the same bytes.
 */
export function encodeStatusReport(report: PushReport): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [encodePktLine(`unpack ${report.unpackError ?? "ok"}\n`)];
  for (const cmd of report.commands) {
    const head = cmd.error === undefined ? "ok " : "ng ";
    const tail = cmd.error === undefined ? "\n" : ` ${cmd.error}\n`;
    parts.push(encodePktLine(concatBytes([latin1Bytes(head), cmd.refName, encoder.encode(tail)])));
  }
  parts.push(flushPkt());
  return concatBytes(parts);
}

/**
 * The whole response body: `messages` (lines without their LF) on side-band
 * 2 when side-band is in use, the status report when the client asked for
 * one, and the closing flush. Without side-band the messages are dropped,
 * as git sends them to its own stderr then.
 */
export function encodePushResponse(
  report: PushReport,
  capabilities: Pick<PushCapabilities, "reportStatus" | "reportStatusV2" | "sideband">,
  messages: readonly string[] = [],
): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  if (capabilities.sideband) {
    for (const line of messages) parts.push(encodeSideband(SIDEBAND_PROGRESS, `${line}\n`));
  }
  if (capabilities.reportStatus || capabilities.reportStatusV2) {
    const status = encodeStatusReport(report);
    parts.push(capabilities.sideband ? encodeSideband(SIDEBAND_DATA, status) : status);
  }
  if (capabilities.sideband) parts.push(flushPkt());
  return concatBytes(parts);
}

/** A progress line on side-band 2 (a keepalive when empty), for a client that asked for side-band. */
export function encodeProgress(text: string): Uint8Array<ArrayBuffer> {
  return encodeSideband(SIDEBAND_PROGRESS, text);
}

/**
 * A fatal error before any report (a malformed request, a server
 * failure): on side-band 3 when the client asked for side-band, which git
 * prints as "remote: <message>" and stops; otherwise an `ERR` packet, which
 * git prints as "remote error: <message>". Sent with status 200.
 */
export function encodeFatalError(message: string, sideband: boolean): Uint8Array<ArrayBuffer> {
  if (sideband) return concatBytes([encodeSideband(SIDEBAND_ERROR, `${message}\n`), flushPkt()]);
  return encodePktLine(`ERR ${message}\n`);
}
