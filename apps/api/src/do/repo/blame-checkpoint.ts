// The envelope a blame checkpoint is stored in. decodeBlameState can tell
// that a state's bytes hold together, not whose they are: a state from
// another repository decodes fine and would answer with its commit facts. So
// a checkpoint is opened only when its envelope names this repository,
// restore generation, commit, path, engine version and run generation, and
// its hash covers all of it.
//
//   "FBCP" | version (1) | header length (u32) | header (JSON) | SHA-256 (32) | state
//
// The hash is over the header and the state.

/** Whose checkpoint this is: every field must match the run's row. */
export interface CheckpointIdentity {
  readonly repoId: string;
  readonly epochGen: number;
  /** The blamed commit, in hex. */
  readonly commit: string;
  readonly path: string;
  readonly engineVersion: number;
  /** The run's generation: which of its checkpoints this is. */
  readonly generation: number;
}

/** Why a checkpoint wasn't opened. The caller replaces the run, whichever it is. */
export type CheckpointRefusal = "too_large" | "malformed" | "identity" | "hash";

export class BlameCheckpointRefused extends Error {
  override name = "BlameCheckpointRefused";
  constructor(readonly reason: CheckpointRefusal) {
    super(`blame checkpoint refused: ${reason}`);
  }
}

const MAGIC = [0x46, 0x42, 0x43, 0x50]; // "FBCP"
const VERSION = 1;
const PREFIX = MAGIC.length + 1 + 4;
const HASH = 32;
/** A path of 4,096 characters in UTF-8 and the other fields fit well within this. */
const MAX_HEADER = 32 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function header(identity: CheckpointIdentity): Uint8Array {
  // Fixed field order, so a header is the same bytes for the same identity.
  return encoder.encode(
    JSON.stringify([
      identity.repoId,
      identity.epochGen,
      identity.commit,
      identity.path,
      identity.engineVersion,
      identity.generation,
    ]),
  );
}

async function digest(head: Uint8Array, state: Uint8Array): Promise<Uint8Array> {
  const both = new Uint8Array(head.length + state.length);
  both.set(head);
  both.set(state, head.length);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", both));
}

/** A state's bytes in their envelope, for `identity`. */
export async function sealCheckpoint(
  identity: CheckpointIdentity,
  state: Uint8Array,
): Promise<Uint8Array> {
  const head = header(identity);
  if (head.length > MAX_HEADER) throw new RangeError("a checkpoint header too large");
  const hash = await digest(head, state);
  const out = new Uint8Array(PREFIX + head.length + HASH + state.length);
  out.set(MAGIC);
  out[MAGIC.length] = VERSION;
  new DataView(out.buffer).setUint32(MAGIC.length + 1, head.length);
  out.set(head, PREFIX);
  out.set(hash, PREFIX + head.length);
  out.set(state, PREFIX + head.length + HASH);
  return out;
}

/**
 * The state's bytes, when the envelope is whole, names `identity` and its
 * hash matches; else `BlameCheckpointRefused`. A checkpoint over `maxBytes`
 * is refused before anything in it is read.
 */
export async function openCheckpoint(
  identity: CheckpointIdentity,
  bytes: Uint8Array,
  maxBytes: number,
): Promise<Uint8Array> {
  if (bytes.length > maxBytes) throw new BlameCheckpointRefused("too_large");
  if (bytes.length < PREFIX + HASH) throw new BlameCheckpointRefused("malformed");
  if (MAGIC.some((b, k) => bytes[k] !== b) || bytes[MAGIC.length] !== VERSION)
    throw new BlameCheckpointRefused("malformed");
  const headLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.length).getUint32(
    MAGIC.length + 1,
  );
  if (headLength > MAX_HEADER || PREFIX + headLength + HASH > bytes.length)
    throw new BlameCheckpointRefused("malformed");
  const head = bytes.subarray(PREFIX, PREFIX + headLength);
  let fields: unknown;
  try {
    fields = JSON.parse(decoder.decode(head));
  } catch {
    throw new BlameCheckpointRefused("malformed");
  }
  if (!sameIdentity(fields, identity)) throw new BlameCheckpointRefused("identity");
  const stored = bytes.subarray(PREFIX + headLength, PREFIX + headLength + HASH);
  const state = bytes.subarray(PREFIX + headLength + HASH);
  const hash = await digest(head, state);
  if (hash.some((b, k) => b !== stored[k])) throw new BlameCheckpointRefused("hash");
  return state.slice();
}

function sameIdentity(fields: unknown, identity: CheckpointIdentity): boolean {
  const want = JSON.parse(new TextDecoder().decode(header(identity))) as unknown[];
  return (
    Array.isArray(fields) &&
    fields.length === want.length &&
    fields.every((value, k) => value === want[k])
  );
}
