/*
 * Opening libsodium sealed boxes (`crypto_box_seal_open`), the form `gh secret
 * set` seals a value in (Go's nacl/box.SealAnonymous): the sender's ephemeral
 * X25519 public key (32 bytes), then `crypto_box` of the value under the nonce
 * BLAKE2b-192(ephemeral public key || recipient public key), 48 bytes of
 * overhead in all (verified: https://doc.libsodium.org/public-key_cryptography/sealed_boxes).
 * X25519 runs in WebCrypto; Workers has no HSalsa20, XSalsa20-Poly1305 or
 * BLAKE2b (verified: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/),
 * so those come from @noble/ciphers and @noble/hashes.
 */
import { hsalsa, xsalsa20poly1305 } from "@noble/ciphers/salsa.js";
import { blake2b } from "@noble/hashes/blake2.js";

/** The bytes a sealed box adds to its value: the ephemeral public key and the Poly1305 tag. */
export const SEALED_BOX_OVERHEAD = 48;

export interface BoxRecipient {
  readonly publicKey: Uint8Array;
  /** An X25519 private key usable for `deriveBits`. */
  readonly privateKey: CryptoKey;
}

function hexBytes(text: string): Uint8Array {
  return Uint8Array.from(text.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

/** PKCS#8 for an X25519 private key (RFC 8410), before its 32 raw bytes. */
const PKCS8_X25519_PREFIX = hexBytes("302e020100300506032b656e04220420");
/** The X25519 base point, u = 9. */
const BASE_POINT = Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 9 : 0));
const SIGMA = new TextEncoder().encode("expand 32-byte k");

/** The recipient whose private key is the X25519 scalar `seed` (32 bytes, clamped by X25519). */
export async function x25519Recipient(seed: Uint8Array): Promise<BoxRecipient> {
  if (seed.length !== 32) throw new Error("an X25519 private key is 32 bytes");
  const pkcs8 = new Uint8Array(PKCS8_X25519_PREFIX.length + 32);
  pkcs8.set(PKCS8_X25519_PREFIX);
  pkcs8.set(seed, PKCS8_X25519_PREFIX.length);
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "X25519" }, false, [
    "deriveBits",
  ]);
  pkcs8.fill(0);
  return { publicKey: await x25519(privateKey, BASE_POINT), privateKey };
}

/**
 * The value inside `sealed` when it was sealed for `recipient`; undefined when
 * it is shorter than the overhead, was altered, or was sealed for another key.
 */
export async function openSealedBox(
  recipient: BoxRecipient,
  sealed: Uint8Array,
): Promise<Uint8Array | undefined> {
  if (sealed.length < SEALED_BOX_OVERHEAD) return undefined;
  try {
    const ephemeral = sealed.slice(0, 32);
    const shared = await x25519(recipient.privateKey, ephemeral);
    // A low-order ephemeral key gives an all-zero shared secret, which anyone can compute.
    if (shared.every((b) => b === 0)) return undefined;
    const key = beforenm(shared);
    const nonceInput = new Uint8Array(64);
    nonceInput.set(ephemeral);
    nonceInput.set(recipient.publicKey, 32);
    const nonce = blake2b(nonceInput, { dkLen: 24 });
    return xsalsa20poly1305(key, nonce).decrypt(sealed.subarray(32));
  } catch {
    return undefined;
  }
}

async function x25519(privateKey: CryptoKey, publicKey: Uint8Array): Promise<Uint8Array> {
  const peer = await crypto.subtle.importKey(
    "raw",
    publicKey.slice(),
    { name: "X25519" },
    false,
    [],
  );
  return new Uint8Array(await crypto.subtle.deriveBits(x25519Algorithm(peer), privateKey, 256));
}

/**
 * X25519 `deriveBits` parameters. The generated Workers types spell the peer's
 * field `$public`; the runtime reads `public`, as WebCrypto names it (measured:
 * the sealed-box tests open Go-made boxes with it).
 */
export function x25519Algorithm(peer: CryptoKey): SubtleCryptoDeriveKeyAlgorithm {
  return { name: "X25519", public: peer } as SubtleCryptoDeriveKeyAlgorithm;
}

/**
 * NaCl's `crypto_box_beforenm`: HSalsa20 of the shared secret with a zero
 * input. noble's `hsalsa` reads and writes host-order word views of the bytes,
 * as its own XSalsa20 passes them.
 */
function beforenm(shared: Uint8Array): Uint8Array {
  const words = (bytes: Uint8Array) => new Uint32Array(bytes.slice().buffer);
  const key = new Uint32Array(8);
  hsalsa(words(SIGMA), words(shared), new Uint32Array(4), key);
  return new Uint8Array(key.buffer);
}
