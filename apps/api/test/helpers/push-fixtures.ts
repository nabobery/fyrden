// What the push fixtures (test/setup/push-fixtures.ts, run by Node before
// the workerd suites) hand the tests, and how a test turns them into the
// request body `git push` sends. Ids are hex; packs are hex. No Node or
// workerd imports.
import { fromHex } from "./git-oracle.js";

/**
 * History: c1 -> c2 -> c3 on main, tag v1 (annotated) -> c2, c4 on a side
 * branch from c1; `lone` (child of c2) whose tree is only in
 * packLoneWithTree, and `child` of `lone`.
 */
export interface PushFixtures {
  readonly c1: string;
  readonly c2: string;
  readonly c3: string;
  readonly c4: string;
  readonly tag: string;
  readonly lone: string;
  readonly child: string;
  /** Every object of c1 and c2. */
  readonly packC2: string;
  /** c3 as a thin pack against c2 (deltas on objects only the repository has). */
  readonly packC3ThinOnC2: string;
  /** c4 and its objects, thin against c1. */
  readonly packC4OnC1: string;
  /** The annotated tag object alone (its target is c2). */
  readonly packTagOnC2: string;
  /** The `lone` commit without its tree. */
  readonly packLoneWithoutTree: string;
  /** The `lone` commit with its tree and blob. */
  readonly packLoneWithTree: string;
  /** `child`, its tree and blob, without its parent `lone`. */
  readonly packChildWithoutParent: string;
  /** A pack with no objects (what git sends when the remote has everything). */
  readonly packEmpty: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    pushFixtures: PushFixtures;
  }
}

export const ZERO = "0".repeat(40);

export interface PushCommand {
  readonly old: string;
  readonly new: string;
  readonly ref: string;
}

const encoder = new TextEncoder();

function pkt(text: string): Uint8Array {
  const data = encoder.encode(text);
  const out = new Uint8Array(data.length + 4);
  out.set(encoder.encode((data.length + 4).toString(16).padStart(4, "0")));
  out.set(data, 4);
  return out;
}

const FLUSH = encoder.encode("0000");

/** The capabilities git 2.53 asks for on a push to a server that offers them. */
export const GIT_PUSH_CAPS = ["report-status-v2", "side-band-64k", "quiet", "object-format=sha1"];

/**
 * A receive-pack request body as git's send-pack writes it: the commands
 * (capabilities after a NUL on the first), a flush, the push options and a
 * flush when given, then the pack (hex) unless every command is a deletion.
 */
export function pushBody(
  commands: readonly PushCommand[],
  options: { caps?: readonly string[]; pack?: string; pushOptions?: readonly string[] } = {},
): Uint8Array {
  const caps = [...(options.caps ?? GIT_PUSH_CAPS)];
  if (options.pushOptions) caps.push("push-options");
  const parts: Uint8Array[] = commands.map((cmd, i) =>
    pkt(`${cmd.old} ${cmd.new} ${cmd.ref}${i === 0 ? `\0${caps.join(" ")}` : ""}\n`),
  );
  parts.push(FLUSH);
  if (options.pushOptions) {
    for (const option of options.pushOptions) parts.push(pkt(`${option}\n`));
    parts.push(FLUSH);
  }
  if (options.pack !== undefined) parts.push(fromHex(options.pack));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The status report inside a response, demultiplexed from side-band 1 when needed. */
export function reportLines(response: Uint8Array): { report: string[]; progress: string[] } {
  const decoder = new TextDecoder();
  const packets = (bytes: Uint8Array) => {
    const out: Uint8Array[] = [];
    let at = 0;
    while (at + 4 <= bytes.length) {
      const length = Number.parseInt(decoder.decode(bytes.subarray(at, at + 4)), 16);
      if (length < 4) {
        out.push(new Uint8Array(0));
        at += 4;
        continue;
      }
      out.push(bytes.subarray(at + 4, at + length));
      at += length;
    }
    return out;
  };
  const progress: string[] = [];
  const primary: Uint8Array[] = [];
  let sideband = false;
  const top = packets(response);
  if (top.some((p) => p.length > 0 && p[0] !== undefined && p[0] <= 3)) sideband = true;
  if (!sideband) {
    return { report: top.map((p) => (p.length ? decoder.decode(p) : "0000")), progress };
  }
  for (const p of top) {
    if (p.length === 0) continue;
    const band = p[0];
    if (band === 1) primary.push(p.subarray(1));
    else progress.push(decoder.decode(p.subarray(1)));
  }
  const joined = new Uint8Array(primary.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of primary) {
    joined.set(p, at);
    at += p.length;
  }
  return { report: packets(joined).map((p) => (p.length ? decoder.decode(p) : "0000")), progress };
}
