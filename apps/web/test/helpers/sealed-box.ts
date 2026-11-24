// Go's sealed-box known answer (the API's fixture) and an opener written from
// libsodium's description, independent of the code under test.
import { readFileSync } from "node:fs";
import { hsalsa, xsalsa20poly1305 } from "@noble/ciphers/salsa.js";
import { blake2b } from "@noble/hashes/blake2.js";

export interface Fixture {
  privateKey: string;
  publicKey: string;
  plaintext: string;
  sealed: string;
}

export const fixture = JSON.parse(
  readFileSync(
    new URL("../../../api/test/fixtures/ci-sealed-box/sealed-box.json", import.meta.url),
    "utf8",
  ),
) as Fixture;

export const fromBase64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"));
export const utf8 = (text: string) => new TextEncoder().encode(text);

export async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(text)));
}

async function x25519Private(seed: Uint8Array): Promise<CryptoKey> {
  const prefix = Buffer.from("302e020100300506032b656e04220420", "hex");
  return crypto.subtle.importKey(
    "pkcs8",
    Buffer.concat([prefix, Buffer.from(seed)]),
    { name: "X25519" },
    false,
    ["deriveBits"],
  );
}

/** `crypto_box_seal_open`, written for this test from libsodium's description. */
export async function open(seed: Uint8Array, recipientPublicKey: Uint8Array, sealed: Uint8Array) {
  const epk = sealed.slice(0, 32);
  const peer = await crypto.subtle.importKey("raw", epk, { name: "X25519" }, false, []);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "X25519", public: peer } as unknown as AlgorithmIdentifier,
      await x25519Private(seed),
      256,
    ),
  );
  const words = (bytes: Uint8Array) => new Uint32Array(bytes.slice().buffer);
  const key = new Uint32Array(8);
  hsalsa(words(utf8("expand 32-byte k")), words(shared), new Uint32Array(4), key);
  const nonce = blake2b(new Uint8Array([...epk, ...recipientPublicKey]), { dkLen: 24 });
  return xsalsa20poly1305(new Uint8Array(key.buffer), nonce).decrypt(sealed.subarray(32));
}
