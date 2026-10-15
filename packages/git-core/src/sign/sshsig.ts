/*
 * SSH signatures (OpenSSH's PROTOCOL.sshsig) as git uses them for signed
 * commits (`gpg.format = ssh`): the signature covers the commit without
 * its `gpgsig` header, in namespace `git`. Only Ed25519 keys are made and
 * checked here; other key types parse but do not verify. Ed25519 through
 * Web Crypto, which Workers and Node both provide; its signatures are
 * deterministic (RFC 8032), so signing the same bytes twice gives the
 * same signature.
 */

import type { Signer } from "../ports/signer.js";

const MAGIC = new TextEncoder().encode("SSHSIG");
const VERSION = 1;
const ED25519 = "ssh-ed25519";
const BEGIN = "-----BEGIN SSH SIGNATURE-----";
const END = "-----END SSH SIGNATURE-----";
/** Line width of the armored signature, as ssh-keygen writes it. */
const ARMOR_WIDTH = 70;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The namespace git signs commits and tags in. */
export const GIT_NAMESPACE = "git";

export class SshSignatureError extends Error {
  override name = "SshSignatureError";
}

export interface SshSignature {
  /** The signer's public key in SSH wire format (`string type, ...`). */
  readonly publicKey: Uint8Array;
  readonly keyType: string;
  readonly namespace: string;
  readonly hashAlgorithm: string;
  /** The signature's own algorithm name and bytes. */
  readonly signatureType: string;
  readonly signature: Uint8Array;
}

/** An Ed25519 public key (32 bytes) in SSH wire format. */
export function ed25519PublicKeyBlob(key: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new RangeError("an Ed25519 public key is 32 bytes");
  return concat(sshString(encoder.encode(ED25519)), sshString(key));
}

/** A public key's fingerprint as ssh-keygen shows it: `SHA256:` and unpadded base64. */
export async function sshFingerprint(publicKeyBlob: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", owned(publicKeyBlob)));
  return `SHA256:${base64(digest).replace(/=+$/, "")}`;
}

/**
 * A public key line (`ssh-ed25519 AAAA... comment`): its type and wire
 * blob. Throws `SshSignatureError` for anything else, or a blob whose
 * type does not match the line's.
 */
export function parseSshPublicKey(line: string): { keyType: string; blob: Uint8Array } {
  const [keyType, data] = line.trim().split(/\s+/);
  if (!keyType || !data) throw new SshSignatureError("not an SSH public key");
  let blob: Uint8Array;
  try {
    blob = fromBase64(data);
  } catch {
    throw new SshSignatureError("the key is not valid base64");
  }
  const type = new WireReader(blob).text();
  if (type !== keyType) throw new SshSignatureError("the key's type does not match its line");
  if (type === ED25519) ed25519KeyOf(blob);
  return { keyType, blob };
}

/** The 32 bytes of an Ed25519 public key blob; `SshSignatureError` for anything else. */
export function ed25519KeyOf(blob: Uint8Array): Uint8Array {
  const reader = new WireReader(blob);
  if (reader.text() !== ED25519) throw new SshSignatureError("not an Ed25519 key");
  const key = reader.bytes();
  if (key.length !== 32 || !reader.done()) throw new SshSignatureError("a malformed Ed25519 key");
  return key;
}

/** What an SSH signature signs: the message's hash, with the namespace (PROTOCOL.sshsig). */
export async function sshSignedData(
  message: Uint8Array,
  namespace: string,
  hashAlgorithm: "sha256" | "sha512" = "sha512",
): Promise<Uint8Array> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(hashAlgorithm === "sha512" ? "SHA-512" : "SHA-256", owned(message)),
  );
  return concat(
    MAGIC,
    sshString(encoder.encode(namespace)),
    sshString(new Uint8Array(0)),
    sshString(encoder.encode(hashAlgorithm)),
    sshString(digest),
  );
}

/** An SSH signature, armored as ssh-keygen writes it (without a final newline). */
export function armorSshSignature(sig: SshSignature): Uint8Array {
  const blob = concat(
    MAGIC,
    uint32(VERSION),
    sshString(sig.publicKey),
    sshString(encoder.encode(sig.namespace)),
    sshString(new Uint8Array(0)),
    sshString(encoder.encode(sig.hashAlgorithm)),
    sshString(concat(sshString(encoder.encode(sig.signatureType)), sshString(sig.signature))),
  );
  const text = base64(blob);
  const lines = [BEGIN];
  for (let at = 0; at < text.length; at += ARMOR_WIDTH)
    lines.push(text.slice(at, at + ARMOR_WIDTH));
  lines.push(END);
  return encoder.encode(lines.join("\n"));
}

/** Reads an armored SSH signature. Throws `SshSignatureError` when it is not one. */
export function parseSshSignature(armored: Uint8Array): SshSignature {
  let text: string;
  try {
    text = decoder.decode(armored);
  } catch {
    throw new SshSignatureError("the signature is not text");
  }
  // As OpenSSH's sshsig_dearmor: the header first; base64 lines; a line break, then the footer.
  const header = text.match(/^-----BEGIN SSH SIGNATURE-----\r?\n/);
  const end = text.indexOf(`\n${END}`);
  if (!header || end < header[0].length - 1)
    throw new SshSignatureError("not an armored SSH signature");
  // As OpenSSH's b64_pton, ASCII whitespace inside the base64 is skipped.
  const body = text.slice(header[0].length, end + 1).replace(/[\t\n\v\f\r ]/g, "");
  const blob = strictBase64(body);
  const reader = new WireReader(blob);
  if (!equal(reader.raw(MAGIC.length), MAGIC)) throw new SshSignatureError("bad signature magic");
  if (reader.uint32() !== VERSION) throw new SshSignatureError("unknown signature version");
  const publicKey = reader.bytes();
  const namespace = reader.text();
  reader.bytes(); // reserved
  const hashAlgorithm = reader.text();
  const inner = new WireReader(reader.bytes());
  const signatureType = inner.text();
  const signature = inner.bytes();
  if (!reader.done() || !inner.done())
    throw new SshSignatureError("trailing bytes in the signature");
  const keyType = new WireReader(publicKey).text();
  return { publicKey, keyType, namespace, hashAlgorithm, signatureType, signature };
}

export type SshVerification =
  | { readonly ok: true; readonly publicKey: Uint8Array; readonly fingerprint: string }
  | { readonly ok: false; readonly reason: string; readonly fingerprint?: string };

/**
 * Whether `armored` is a valid SSH signature of `message` in `namespace`,
 * by the key it names (who that key belongs to is the caller's question).
 */
export async function verifySshSignature(
  message: Uint8Array,
  armored: Uint8Array,
  namespace: string = GIT_NAMESPACE,
): Promise<SshVerification> {
  let sig: SshSignature;
  try {
    sig = parseSshSignature(armored);
  } catch (error) {
    if (error instanceof SshSignatureError) return { ok: false, reason: "malformed_signature" };
    throw error;
  }
  const fingerprint = await sshFingerprint(sig.publicKey);
  if (sig.namespace !== namespace) return { ok: false, reason: "wrong_namespace", fingerprint };
  if (sig.hashAlgorithm !== "sha512" && sig.hashAlgorithm !== "sha256")
    return { ok: false, reason: "unknown_hash", fingerprint };
  if (sig.keyType !== ED25519 || sig.signatureType !== ED25519)
    return { ok: false, reason: "unsupported_key", fingerprint };
  let raw: Uint8Array;
  try {
    raw = ed25519KeyOf(sig.publicKey);
  } catch (error) {
    if (error instanceof SshSignatureError)
      return { ok: false, reason: "malformed_signature", fingerprint };
    throw error;
  }
  if (sig.signature.length !== 64) return { ok: false, reason: "malformed_signature", fingerprint };
  const imported = await crypto.subtle.importKey("raw", owned(raw), { name: "Ed25519" }, false, [
    "verify",
  ]);
  const data = await sshSignedData(message, sig.namespace, sig.hashAlgorithm);
  const valid = await crypto.subtle.verify(
    { name: "Ed25519" },
    imported,
    owned(sig.signature),
    owned(data),
  );
  return valid
    ? { ok: true, publicKey: sig.publicKey, fingerprint }
    : { ok: false, reason: "invalid", fingerprint };
}

/** A Web Crypto key, as this package's libraries type it. */
type PrivateKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/** PKCS #8 wrapping of a 32-byte Ed25519 seed (RFC 8410). */
const PKCS8_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

/** An Ed25519 key pair from its 32-byte seed (the private key), for signing. */
export async function ed25519FromSeed(
  seed: Uint8Array,
): Promise<{ privateKey: PrivateKey; publicKey: Uint8Array }> {
  if (seed.length !== 32) throw new RangeError("an Ed25519 seed is 32 bytes");
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    owned(concat(PKCS8_ED25519_PREFIX, seed)),
    { name: "Ed25519" },
    true,
    ["sign"],
  );
  // The public half, from the private key's JWK (`x`).
  const jwk = (await crypto.subtle.exportKey("jwk", privateKey)) as { x?: string };
  if (!jwk.x) throw new Error("the key has no public half");
  return { privateKey, publicKey: fromBase64(jwk.x.replace(/-/g, "+").replace(/_/g, "/")) };
}

/** A commit signer with an Ed25519 key: SSH signatures in namespace `git`. */
export function sshCommitSigner(key: { privateKey: PrivateKey; publicKey: Uint8Array }): Signer {
  const publicKey = ed25519PublicKeyBlob(key.publicKey);
  return {
    async sign(payload) {
      const data = await sshSignedData(payload, GIT_NAMESPACE, "sha512");
      const signature = new Uint8Array(
        await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, owned(data)),
      );
      return armorSshSignature({
        publicKey,
        keyType: ED25519,
        namespace: GIT_NAMESPACE,
        hashAlgorithm: "sha512",
        signatureType: ED25519,
        signature,
      });
    },
  };
}

class WireReader {
  #at = 0;
  constructor(private readonly buf: Uint8Array) {}

  uint32(): number {
    if (this.#at + 4 > this.buf.length) throw new SshSignatureError("truncated");
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.#at, 4);
    this.#at += 4;
    return view.getUint32(0);
  }

  raw(length: number): Uint8Array {
    if (this.#at + length > this.buf.length) throw new SshSignatureError("truncated");
    const out = this.buf.subarray(this.#at, this.#at + length);
    this.#at += length;
    return out;
  }

  bytes(): Uint8Array {
    return this.raw(this.uint32());
  }

  text(): string {
    try {
      return decoder.decode(this.bytes());
    } catch (error) {
      if (error instanceof SshSignatureError) throw error;
      throw new SshSignatureError("a name is not text");
    }
  }

  done(): boolean {
    return this.#at === this.buf.length;
  }
}

function uint32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
}

function sshString(bytes: Uint8Array): Uint8Array {
  return concat(uint32(bytes.length), bytes);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** `bytes` on an ArrayBuffer of their own, as Web Crypto takes them. */
function owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Canonical padded base64 only (whole groups, padding where due, no stray bits), as OpenSSH reads it. */
function strictBase64(text: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text))
    throw new SshSignatureError("the signature is not base64");
  const bytes = fromBase64(text);
  if (base64(bytes) !== text) throw new SshSignatureError("the signature is not canonical base64");
  return bytes;
}

function fromBase64(text: string): Uint8Array {
  const padded = text + "=".repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}
