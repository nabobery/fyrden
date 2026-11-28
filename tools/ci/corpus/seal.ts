import { createPublicKey, diffieHellman, generateKeyPairSync } from "node:crypto";
import { hsalsa, xsalsa20poly1305 } from "@noble/ciphers/salsa.js";
import { blake2b } from "@noble/hashes/blake2.js";

const littleEndianWords = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Uint32Array.from({ length: bytes.length / 4 }, (_, i) => view.getUint32(i * 4, true));
};

/** libsodium's `crypto_box_seal` of `message` for `recipient`, as `gh secret set` makes it. */
export function sealedBox(recipient: Uint8Array, message: string): Uint8Array {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const epk = Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url");
  const peer = createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: Buffer.from(recipient).toString("base64url") },
    format: "jwk",
  });
  const shared = new Uint8Array(diffieHellman({ privateKey, publicKey: peer }));
  const words = new Uint32Array(8);
  hsalsa(
    littleEndianWords(new TextEncoder().encode("expand 32-byte k")),
    littleEndianWords(shared),
    new Uint32Array(4),
    words,
  );
  const key = new Uint8Array(32);
  const keyView = new DataView(key.buffer);
  for (const [i, w] of words.entries()) keyView.setUint32(i * 4, w, true);
  const nonceInput = new Uint8Array(64);
  nonceInput.set(epk);
  nonceInput.set(recipient, 32);
  const box = xsalsa20poly1305(key, blake2b(nonceInput, { dkLen: 24 })).encrypt(
    new TextEncoder().encode(message),
  );
  const sealed = new Uint8Array(32 + box.length);
  sealed.set(epk);
  sealed.set(box, 32);
  return sealed;
}
