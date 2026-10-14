import { splitSignedCommit, verifySshSignature } from "@fyrden/git-core";

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

/** The signature check of a commit (its object content, without the header). */
export async function checkSignature(body: Uint8Array): Promise<SignatureCheck> {
  const split = splitSignedCommit(body);
  if (split.kind === "unsigned")
    return { reason: "unsigned", key: null, signature: null, payload: null };
  // Too long to be a signature git makes: not read, not shown.
  if (split.kind === "oversized")
    return { reason: "malformed_signature", key: null, signature: null, payload: null };
  const signature = text.decode(split.signature);
  const payload = text.decode(split.payload);
  // An OpenPGP signature: a format not checked here.
  if (signature.startsWith("-----BEGIN PGP SIGNATURE-----"))
    return { reason: "unknown_signature_type", key: null, signature, payload };
  const result = await verifySshSignature(split.payload, split.signature);
  if (result.ok) return { reason: "signed", key: result.fingerprint, signature, payload };
  const reason =
    result.reason === "unsupported_key" || result.reason === "unknown_hash"
      ? "unknown_signature_type"
      : result.reason === "malformed_signature"
        ? "malformed_signature"
        : "invalid";
  return { reason, key: null, signature, payload };
}
