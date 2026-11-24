/*
 * Sealing a value for an Actions secret, the form `gh secret set` sends
 * (libsodium `crypto_box_seal`, Go's nacl/box.SealAnonymous): an ephemeral
 * X25519 public key, then `crypto_box` of the value under the nonce
 * BLAKE2b-192(ephemeral public key || recipient public key)
 * (verified: https://doc.libsodium.org/public-key_cryptography/sealed_boxes).
 * X25519 runs in WebCrypto; HSalsa20, XSalsa20-Poly1305 and BLAKE2b come from
 * @noble/ciphers and @noble/hashes, as in the API's opener.
 */
import { hsalsa, xsalsa20poly1305 } from "@noble/ciphers/salsa.js";
import { blake2b } from "@noble/hashes/blake2.js";

/** PKCS#8 for an X25519 private key (RFC 8410), before its 32 raw bytes. */
const PKCS8_X25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);
/** The X25519 base point, u = 9. */
const BASE_POINT = Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 9 : 0));
const SIGMA = new TextEncoder().encode("expand 32-byte k");

/**
 * `message` sealed for `recipientPublicKey` (32 bytes). `ephemeralPrivateKey`
 * fixes the ephemeral key for a known-answer test; production callers omit it
 * so every box draws a fresh one.
 */
export async function sealBox(
  recipientPublicKey: Uint8Array,
  message: Uint8Array,
  ephemeralPrivateKey?: Uint8Array,
): Promise<Uint8Array> {
  if (recipientPublicKey.length !== 32) throw new Error("an X25519 public key is 32 bytes");
  const ephemeral = await ephemeralKeyPair(ephemeralPrivateKey);
  const shared = await x25519(ephemeral.privateKey, recipientPublicKey);
  // A low-order recipient key gives an all-zero shared secret, which anyone can compute.
  if (shared.every((b) => b === 0)) throw new Error("the recipient public key is low-order");
  const key = beforenm(shared);
  shared.fill(0);
  const nonceInput = new Uint8Array(64);
  nonceInput.set(ephemeral.publicKey);
  nonceInput.set(recipientPublicKey, 32);
  const box = xsalsa20poly1305(key, blake2b(nonceInput, { dkLen: 24 })).encrypt(message);
  key.fill(0);
  const sealed = new Uint8Array(32 + box.length);
  sealed.set(ephemeral.publicKey);
  sealed.set(box, 32);
  return sealed;
}

async function ephemeralKeyPair(
  seed: Uint8Array | undefined,
): Promise<{ privateKey: CryptoKey; publicKey: Uint8Array }> {
  if (seed === undefined) {
    const pair = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const raw = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
    return { privateKey: pair.privateKey, publicKey: new Uint8Array(raw) };
  }
  if (seed.length !== 32) throw new Error("an X25519 private key is 32 bytes");
  const pkcs8 = new Uint8Array(PKCS8_X25519_PREFIX.length + 32);
  pkcs8.set(PKCS8_X25519_PREFIX);
  pkcs8.set(seed, PKCS8_X25519_PREFIX.length);
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "X25519" }, false, [
    "deriveBits",
  ]);
  pkcs8.fill(0);
  return { privateKey, publicKey: await x25519(privateKey, BASE_POINT) };
}

async function x25519(privateKey: CryptoKey, publicKey: Uint8Array): Promise<Uint8Array> {
  const peer = await crypto.subtle.importKey(
    "raw",
    publicKey.slice(),
    { name: "X25519" },
    false,
    [],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "X25519", public: peer } as SubtleCryptoDeriveKeyAlgorithm,
      privateKey,
      256,
    ),
  );
}

/**
 * NaCl's `crypto_box_beforenm`: HSalsa20 of the shared secret with a zero
 * input. noble's `hsalsa` reads and writes host-order word views of the bytes.
 */
function beforenm(shared: Uint8Array): Uint8Array {
  const words = (bytes: Uint8Array) => new Uint32Array(bytes.slice().buffer);
  const key = new Uint32Array(8);
  hsalsa(words(SIGMA), words(shared), new Uint32Array(4), key);
  return new Uint8Array(key.buffer);
}
