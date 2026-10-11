import {
  chompLf,
  encodeReceivePackRequest,
  oidFromHex,
  PktLineReader,
  ProtocolError,
  zeroOid,
} from "@fyrden/git-core";

/*
 * A chunked upload or an import is pushed through the receive-pack path:
 * the server writes the command section a git client would have sent (the
 * "head"), and the pack follows it. Ref names, compare-and-set, fsck,
 * connectivity, re-authorization and the commit are then exactly a push's.
 */

/** One requested ref update; ids are 40 lowercase hex, null for none. */
export interface RefUpdateSpec {
  readonly ref: string;
  readonly old: string | null;
  readonly new: string | null;
}

/**
 * What the head asks for: git's status report (parsed back by
 * `readPushReport`), all-or-nothing, and offset deltas.
 */
const CAPABILITIES = [
  { name: "report-status" },
  { name: "atomic" },
  { name: "ofs-delta" },
  { name: "agent", value: "fyrden" },
] as const;

const encoder = new TextEncoder();

/** The receive-pack command section for `updates`. Throws RangeError for an update git could not send. */
export function buildCommandHead(updates: readonly RefUpdateSpec[]): Uint8Array {
  if (updates.length === 0) throw new RangeError("no ref updates");
  return encodeReceivePackRequest({
    shallow: [],
    commands: updates.map((u) => ({
      oldOid: u.old === null ? zeroOid() : oidFromHex(u.old),
      newOid: u.new === null ? zeroOid() : oidFromHex(u.new),
      refName: encoder.encode(u.ref),
    })),
    capabilities: CAPABILITIES,
    pushOptions: undefined,
  });
}

/** Why a ref update cannot be sent, or undefined when it can. */
export function refUpdateProblem(update: RefUpdateSpec): string | undefined {
  // A JSON string can hold a lone surrogate, which would be encoded lossily.
  if (!update.ref.isWellFormed()) return "ref name must be valid UTF-8";
  if (/[\0\n]/.test(update.ref)) return "ref name contains a NUL or a newline";
  if (update.old === null && update.new === null) return "an update needs an old or a new value";
  return undefined;
}

export interface RefOutcome {
  readonly ref: string;
  readonly status: "ok" | "rejected";
  readonly reason?: string;
}

export type PushReportSummary =
  | { readonly ok: true; readonly refs: RefOutcome[] }
  /** The whole push failed: `unpack` error, a fatal `ERR`, or refusals. */
  | { readonly ok: false; readonly error: string; readonly refs: RefOutcome[] };

const decoder = new TextDecoder();

/**
 * Reads the response of a push made with `buildCommandHead`'s capabilities
 * (report-status without side-band): `unpack ok|<error>`, then `ok <ref>`
 * or `ng <ref> <reason>` per command, or a single `ERR <message>`.
 */
export function readPushReport(bytes: Uint8Array): PushReportSummary {
  const reader = new PktLineReader(bytes);
  const refs: RefOutcome[] = [];
  let unpack: string | undefined;
  try {
    for (;;) {
      const pkt = reader.read();
      if (pkt === undefined || pkt.kind === "flush") break;
      if (pkt.kind !== "data") continue;
      const line = decoder.decode(chompLf(pkt.data));
      if (line.startsWith("ERR ")) return { ok: false, error: line.slice(4), refs };
      if (line.startsWith("unpack ")) unpack = line.slice(7);
      else if (line.startsWith("ok ")) refs.push({ ref: line.slice(3), status: "ok" });
      else if (line.startsWith("ng ")) {
        const rest = line.slice(3);
        const space = rest.indexOf(" ");
        refs.push({
          ref: space < 0 ? rest : rest.slice(0, space),
          status: "rejected",
          ...(space < 0 ? {} : { reason: rest.slice(space + 1) }),
        });
      }
    }
  } catch (error) {
    if (!(error instanceof ProtocolError)) throw error;
    return { ok: false, error: "the server's push report could not be read", refs };
  }
  if (unpack !== undefined && unpack !== "ok") {
    return { ok: false, error: `unpack failed: ${unpack}`, refs };
  }
  const rejected = refs.filter((r) => r.status === "rejected");
  if (refs.length === 0) return { ok: false, error: "the push report was empty", refs };
  return rejected.length === 0
    ? { ok: true, refs }
    : {
        ok: false,
        error: rejected.map((r) => `${r.ref}: ${r.reason ?? "rejected"}`).join("; "),
        refs,
      };
}
