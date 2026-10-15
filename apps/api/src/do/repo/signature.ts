import { parseCommit, splitSignedCommit, verifySshSignature } from "@fyrden/git-core";
import type { SignedFact } from "../../signing/verification.js";

/**
 * What a commit's signature says on its own: whether it is a valid SSH
 * signature, and by which key (`key`, its fingerprint). Who the key
 * belongs to, and so whether the commit counts as verified, is decided
 * from the platform's and the users' keys (see `resolveVerification`).
 */
export interface SignatureCheck {
  readonly reason:
    | "unsigned"
    | "signed"
    | "invalid"
    | "malformed_signature"
    | "unknown_signature_type";
  /** The signing key's fingerprint (`SHA256:...`), when the signature is valid. */
  readonly key: string | null;
  /** The armored signature and the signed payload, as GitHub shows them. */
  readonly signature: string | null;
  readonly payload: string | null;
}

const text = new TextDecoder();
const PGP_ARMOR = new TextEncoder().encode("-----BEGIN PGP SIGNATURE-----");

type Verdict = Pick<SignatureCheck, "reason" | "key">;

/** What a commit's signature says, from its bytes alone (nothing decoded to text). */
async function verdictOf(split: ReturnType<typeof splitSignedCommit>): Promise<Verdict> {
  if (split.kind === "unsigned") return { reason: "unsigned", key: null };
  // Too long to be a signature git makes: not read.
  if (split.kind === "oversized") return { reason: "malformed_signature", key: null };
  // An OpenPGP signature: a format not checked here.
  if (PGP_ARMOR.every((byte, i) => split.signature[i] === byte))
    return { reason: "unknown_signature_type", key: null };
  const result = await verifySshSignature(split.payload, split.signature);
  if (result.ok) return { reason: "signed", key: result.fingerprint };
  const reason =
    result.reason === "unsupported_key" || result.reason === "unknown_hash"
      ? "unknown_signature_type"
      : result.reason === "malformed_signature"
        ? "malformed_signature"
        : "invalid";
  return { reason, key: null };
}

/** The signature check of a commit (its object content, without the header). */
export async function checkSignature(body: Uint8Array): Promise<SignatureCheck> {
  const split = splitSignedCommit(body);
  const verdict = await verdictOf(split);
  if (split.kind !== "signed") return { ...verdict, signature: null, payload: null };
  return {
    ...verdict,
    signature: text.decode(split.signature),
    payload: text.decode(split.payload),
  };
}

/**
 * A commit's signature check and its committer email (for the rulesets):
 * nothing shown, so the signed payload is never decoded to text (a large
 * message would take several times its size as a string).
 */
export async function factOf(body: Uint8Array): Promise<SignedFact> {
  const verdict = await verdictOf(splitSignedCommit(body));
  return {
    ...verdict,
    committerEmail: text.decode(parseCommit(body).value.committer.email),
  };
}
