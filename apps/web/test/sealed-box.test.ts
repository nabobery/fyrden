// Sealing a value the way `gh secret set` does (libsodium `crypto_box_seal`):
// the web Worker's box is byte for byte Go's for the same ephemeral key, and an
// opener written here independently of the code under test opens it.
import { readFileSync } from "node:fs";
import { hsalsa, xsalsa20poly1305 } from "@noble/ciphers/salsa.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { describe, expect, it } from "vitest";
import { sealBox } from "../app/lib/sealed-box.server.js";

interface Fixture {
  privateKey: string;
  publicKey: string;
  plaintext: string;
  sealed: string;
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../../api/test/fixtures/ci-sealed-box/sealed-box.json", import.meta.url),
    "utf8",
  ),
) as Fixture;

const fromBase64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"));
const utf8 = (text: string) => new TextEncoder().encode(text);

async function sha256(text: string): Promise<Uint8Array> {
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
async function open(seed: Uint8Array, recipientPublicKey: Uint8Array, sealed: Uint8Array) {
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

describe("sealBox", () => {
  const recipientSeed = fromBase64(fixture.privateKey);
  const recipientPublicKey = fromBase64(fixture.publicKey);

  it("makes Go's box for Go's ephemeral key", async () => {
    const ephemeral = await sha256("fyrden ci sealed-box fixture: ephemeral");
    const sealed = await sealBox(recipientPublicKey, utf8(fixture.plaintext), ephemeral);
    expect(Buffer.from(sealed).toString("base64")).toBe(fixture.sealed);
  });

  it.each([0, 1, 49_152])("seals %i bytes that an independent opener opens", async (size) => {
    const message = crypto.getRandomValues(new Uint8Array(size));
    const sealed = await sealBox(recipientPublicKey, message);
    expect(sealed.length).toBe(size + 48);
    expect(await open(recipientSeed, recipientPublicKey, sealed)).toEqual(message);
  });

  it("draws a new ephemeral key for every box", async () => {
    const message = utf8("same value");
    const [a, b] = await Promise.all([
      sealBox(recipientPublicKey, message),
      sealBox(recipientPublicKey, message),
    ]);
    expect(Buffer.from(a.subarray(0, 32)).equals(Buffer.from(b.subarray(0, 32)))).toBe(false);
  });

  it("refuses a recipient key whose shared secret is all zeros", async () => {
    await expect(sealBox(new Uint8Array(32), utf8("value"))).rejects.toThrow();
  });

  it("refuses a recipient key that is not 32 bytes", async () => {
    await expect(sealBox(new Uint8Array(31), utf8("value"))).rejects.toThrow();
  });

  it.skipIf(!process.env.FYRDEN_BENCH)("seal bench: 48 KiB", async () => {
    const message = crypto.getRandomValues(new Uint8Array(49_152));
    for (let i = 0; i < 5; i++) await sealBox(recipientPublicKey, message);
    const runs = 50;
    // biome-ignore lint/style/noRestrictedGlobals: a benchmark run on request; it asserts nothing on time.
    const clock = () => performance.now();
    const start = clock();
    for (let i = 0; i < runs; i++) await sealBox(recipientPublicKey, message);
    console.log(`sealBox 48 KiB: ${((clock() - start) / runs).toFixed(3)} ms per box`);
  });
});
