import type { Signer } from "../ports/signer.js";
import { concatBytes, latin1Bytes, startsWithAscii } from "./bytes.js";
import { parseCommit } from "./commit.js";
import { encodeHeader, verifyHeaders } from "./headers.js";
import { encodeIdent, type Ident } from "./ident.js";
import { type Oid, oidToHex } from "./oid.js";

const LF = 0x0a;
const SPACE = 0x20;

/** What a replayed commit gets anew; the rest is the original's. */
export interface Replay {
  readonly tree: Oid;
  readonly parent: Oid;
  readonly committer: Ident;
  /** Signs the replayed commit (a `gpgsig` header); unsigned without one. */
  readonly signer?: Signer;
}

/**
 * A commit replayed onto another parent, as a rebase makes it: the
 * original's `author` line, `encoding` header and message are kept byte for
 * byte (never parsed and written again, so any line git accepted stays as
 * it was); the tree, the one parent and the committer are new, and the
 * signature is made for the new commit. The original's other headers (its
 * signatures, unknown ones) are dropped. Throws a `GitObjectError` when the
 * original is not a valid commit.
 */
export async function replayCommit(original: Uint8Array, replay: Replay): Promise<Uint8Array> {
  parseCommit(original);
  const headersEnd = verifyHeaders(original);
  const lines = headerLines(original, headersEnd);
  const author = lines.find((l) => startsWithAscii(original, l.start, "author "));
  // parseCommit found one.
  if (!author) throw new Error("unreachable: a parsed commit has an author");
  const kept = lines.filter((l) => startsWithAscii(original, l.start, "encoding "));
  const head = concatBytes([
    latin1Bytes(`tree ${oidToHex(replay.tree)}\nparent ${oidToHex(replay.parent)}\n`),
    original.subarray(author.start, author.end),
    latin1Bytes("committer "),
    encodeIdent(replay.committer),
    Uint8Array.of(LF),
    ...kept.map((l) => original.subarray(l.start, l.end)),
  ]);
  // The blank line and the message, or nothing when the original has neither.
  const tail = original.subarray(headersEnd);
  if (!replay.signer) return concatBytes([head, tail]);
  const signature = await replay.signer.sign(concatBytes([head, tail]));
  return concatBytes([head, encodeHeader({ key: "gpgsig", value: signature }), tail]);
}

/** Each header of `body` up to `end`, its continuation lines and final LF included. */
function headerLines(body: Uint8Array, end: number): { start: number; end: number }[] {
  const lines: { start: number; end: number }[] = [];
  for (let p = 0; p < end; ) {
    let next = body.indexOf(LF, p) + 1;
    while (next < end && body[next] === SPACE) next = body.indexOf(LF, next) + 1;
    lines.push({ start: p, end: next });
    p = next;
  }
  return lines;
}
