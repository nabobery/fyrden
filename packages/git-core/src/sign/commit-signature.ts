import { GIT_NAMESPACE, type SshVerification, verifySshSignature } from "./sshsig.js";

const LF = 0x0a;
const SPACE = 0x20;
const encoder = new TextEncoder();
/** The signature header of a SHA-1 repository's commits; any other `gpgsig*` header is another's. */
const GPGSIG = encoder.encode("gpgsig");

/** Longest signature read; a longer one is not a signature git makes. Proposed. */
export const MAX_SIGNATURE_BYTES = 64 * 1024;

export type SignedCommit =
  | { readonly kind: "unsigned" }
  | { readonly kind: "oversized" }
  | { readonly kind: "signed"; readonly payload: Uint8Array; readonly signature: Uint8Array };

/**
 * Walks the lines of `body` as git 2.53's `parse_buffer_signed_by_header`
 * does for a SHA-1 repository, telling `to` where each part goes: the
 * signature (a `gpgsig ` header's value, or a continuation line's after its
 * space, while in a signature) or the payload (everything else, but other
 * `gpgsig*` headers and their continuation lines; from the first empty
 * line, the rest at once). Keeps nothing per line.
 */
function walk(
  body: Uint8Array,
  to: (part: "signature" | "payload", from: number, end: number) => void,
): void {
  let inSignature = false;
  let otherSignature = false;
  for (let line = 0; line < body.length; ) {
    let next = body.indexOf(LF, line);
    next = next < 0 ? body.length : next + 1;
    let sig = -1;
    if (inSignature && body[line] === SPACE) sig = line + 1;
    else if (startsWith(body, line, GPGSIG) && body[line + GPGSIG.length] === SPACE) {
      sig = line + GPGSIG.length + 1;
      otherSignature = false;
    } else if (startsWith(body, line, GPGSIG)) otherSignature = true;
    else if (otherSignature && body[line] !== SPACE) otherSignature = false;
    if (sig >= 0) {
      to("signature", sig, next);
      inSignature = true;
    } else {
      // The end of the headers: the rest is the message.
      if (body[line] === LF) next = body.length;
      if (!otherSignature) to("payload", line, next);
      inSignature = false;
    }
    line = next;
  }
}

/**
 * A commit's signature and what it signs, as git splits them (see `walk`).
 * `body` is the commit object's content, without the object header. A
 * signature longer than `maxSignatureBytes` is not read.
 */
export function splitSignedCommit(
  body: Uint8Array,
  maxSignatureBytes: number = MAX_SIGNATURE_BYTES,
): SignedCommit {
  let signatureBytes = 0;
  let payloadBytes = 0;
  let signed = false;
  walk(body, (part, from, end) => {
    if (part === "payload") payloadBytes += end - from;
    else {
      signed = true;
      signatureBytes += end - from;
    }
  });
  if (!signed) return { kind: "unsigned" };
  if (signatureBytes > maxSignatureBytes) return { kind: "oversized" };
  const signature = new Uint8Array(signatureBytes);
  const payload = new Uint8Array(payloadBytes);
  let sigAt = 0;
  let payAt = 0;
  walk(body, (part, from, end) => {
    if (part === "signature") {
      signature.set(body.subarray(from, end), sigAt);
      sigAt += end - from;
    } else {
      payload.set(body.subarray(from, end), payAt);
      payAt += end - from;
    }
  });
  return { kind: "signed", payload, signature };
}

/** Whether a commit carries a valid SSH signature, and by which key (see `verifySshSignature`). */
export async function verifyCommitSignature(
  body: Uint8Array,
): Promise<SshVerification | { readonly ok: false; readonly reason: "unsigned" | "oversized" }> {
  const split = splitSignedCommit(body);
  if (split.kind !== "signed") return { ok: false, reason: split.kind };
  return verifySshSignature(split.payload, split.signature, GIT_NAMESPACE);
}

function startsWith(body: Uint8Array, at: number, prefix: Uint8Array): boolean {
  if (at + prefix.length > body.length) return false;
  for (let i = 0; i < prefix.length; i++) if (body[at + i] !== prefix[i]) return false;
  return true;
}
