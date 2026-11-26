// Opening libsodium sealed boxes (`crypto_box_seal`), as `gh secret set` makes
// them: a box from Go's nacl/box.SealAnonymous opens, and anything altered,
// short, low-order or for another key does not.
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { hsalsa, xsalsa20poly1305 } from "@noble/ciphers/salsa.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { afterAll, describe, expect, it } from "vitest";
import { boxKey, newDataKey } from "../src/ci/envelope.js";
import {
  type BoxRecipient,
  openSealedBox,
  x25519Algorithm,
  x25519Recipient,
} from "../src/ci/sealed-box.js";
import fixture from "./fixtures/ci-sealed-box/sealed-box.json";

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const decode = (bytes: Uint8Array | undefined) =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);

/** A sealed box made independently of the code under test (noble and WebCrypto only). */
async function seal(recipientPublicKey: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const ephemeral = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const epk = new Uint8Array(
    (await crypto.subtle.exportKey("raw", ephemeral.publicKey)) as ArrayBuffer,
  );
  const recipient = await crypto.subtle.importKey(
    "raw",
    recipientPublicKey,
    { name: "X25519" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(x25519Algorithm(recipient), ephemeral.privateKey, 256),
  );
  return sealWith(epk, shared, recipientPublicKey, message);
}

function sealWith(
  epk: Uint8Array,
  shared: Uint8Array,
  recipientPublicKey: Uint8Array,
  message: Uint8Array,
): Uint8Array {
  const words = (bytes: Uint8Array) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return Uint32Array.from({ length: bytes.length / 4 }, (_, i) => view.getUint32(i * 4, true));
  };
  const out = new Uint32Array(8);
  hsalsa(
    words(new TextEncoder().encode("expand 32-byte k")),
    words(shared),
    new Uint32Array(4),
    out,
  );
  const key = new Uint8Array(32);
  const keyView = new DataView(key.buffer);
  for (const [i, w] of out.entries()) keyView.setUint32(i * 4, w, true);
  const nonceInput = new Uint8Array(64);
  nonceInput.set(epk);
  nonceInput.set(recipientPublicKey, 32);
  const nonce = blake2b(nonceInput, { dkLen: 24 });
  const box = xsalsa20poly1305(key, nonce).encrypt(message);
  const sealed = new Uint8Array(32 + box.length);
  sealed.set(epk);
  sealed.set(box, 32);
  return sealed;
}

async function fixtureRecipient(): Promise<BoxRecipient> {
  return x25519Recipient(fromBase64(fixture.privateKey));
}

describe("sealed boxes", () => {
  it("open a box made by Go's nacl/box.SealAnonymous", async () => {
    const recipient = await fixtureRecipient();
    expect(recipient.publicKey).toEqual(fromBase64(fixture.publicKey));
    expect(decode(await openSealedBox(recipient, fromBase64(fixture.sealed)))).toBe(
      fixture.plaintext,
    );
  });

  it("refuse the box with any one byte flipped", async () => {
    const recipient = await fixtureRecipient();
    const sealed = fromBase64(fixture.sealed);
    for (let i = 0; i < sealed.length; i++) {
      const tampered = sealed.slice();
      tampered[i] = (tampered[i] ?? 0) ^ 0x01;
      expect(await openSealedBox(recipient, tampered), `byte ${i}`).toBeUndefined();
    }
  });

  it("refuse a box for another key", async () => {
    const other = await x25519Recipient(crypto.getRandomValues(new Uint8Array(32)));
    expect(await openSealedBox(other, fromBase64(fixture.sealed))).toBeUndefined();
  });

  it("refuse input shorter than the 48 bytes of overhead, and open an empty value at 48", async () => {
    const recipient = await fixtureRecipient();
    const sealed = fromBase64(fixture.sealed);
    for (const length of [0, 1, 31, 32, 47]) {
      expect(await openSealedBox(recipient, sealed.subarray(0, length))).toBeUndefined();
    }
    const empty = await seal(recipient.publicKey, new Uint8Array(0));
    expect(empty).toHaveLength(48);
    expect(await openSealedBox(recipient, empty)).toEqual(new Uint8Array(0));
  });

  it("refuse a low-order ephemeral key, even with a box made for its all-zero shared secret", async () => {
    const recipient = await fixtureRecipient();
    // u = 0 and u = 1 are points of small order: X25519 with either gives 32 zero bytes,
    // whatever the private key, so anyone can make a box that would open.
    const one = new Uint8Array(32);
    one[0] = 1;
    for (const epk of [new Uint8Array(32), one]) {
      const forged = sealWith(epk, new Uint8Array(32), recipient.publicKey, new Uint8Array([1]));
      expect(await openSealedBox(recipient, forged)).toBeUndefined();
    }
  });

  it("open a 48 KiB value sealed for a box key derived from a data key", async () => {
    const key = await boxKey(newDataKey(), 1, uniqueId("repo"));
    const value = new Uint8Array(48 * 1024);
    crypto.getRandomValues(value);
    const sealed = await seal(fromBase64(key.key), value);
    expect(sealed).toHaveLength(value.length + 48);
    expect(await openSealedBox(key, sealed)).toEqual(value);
    const other = await boxKey(newDataKey(), 1, uniqueId("repo"));
    expect(await openSealedBox(other, sealed)).toBeUndefined();
  });
});

/*
 * The time opening a 48 KiB sealed box takes, beside AES-GCM over the same
 * bytes, for the Free plan's CPU budget. It prints and asserts nothing about
 * time, so it runs only on request:
 *
 *   FYRDEN_BENCH=1 pnpm --filter @fyrden/api exec vitest run test/ci.sealed-box.test.ts --silent=false
 */
const benchLines: string[] = [];
afterAll(() => {
  // After the log capture has given console back.
  for (const line of benchLines) console.log(line);
});

describe.runIf((env as { FYRDEN_BENCH?: string }).FYRDEN_BENCH)("sealed box bench (48 KiB)", () => {
  it("prints the time to open a sealed box and to decrypt AES-GCM", async () => {
    // biome-ignore lint/style/noRestrictedGlobals: a benchmark run on request; it asserts nothing on time.
    const clock = () => performance.now();
    const key = await boxKey(newDataKey(), 1, uniqueId("repo"));
    const value = crypto.getRandomValues(new Uint8Array(48 * 1024));
    const sealed = await seal(key.publicKey, value);
    const aes = (await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ])) as CryptoKey;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, value);
    // A Workers clock may advance only across I/O, so each batch ends with one, timed alone too.
    const io = () => fetch("data:,");
    const runs = 50;
    const perRun = async (run: () => Promise<unknown>) => {
      await run();
      let start = clock();
      await io();
      const ioTime = clock() - start;
      start = clock();
      for (let i = 0; i < runs; i++) await run();
      await io();
      return (clock() - start - ioTime) / runs;
    };
    const sealedBox = await perRun(() => openSealedBox(key, sealed));
    const aesGcm = await perRun(() =>
      crypto.subtle.decrypt({ name: "AES-GCM", iv }, aes, encrypted),
    );
    benchLines.push(
      `48 KiB, mean of ${runs}: sealed box open ${sealedBox.toFixed(3)} ms, AES-GCM decrypt ${aesGcm.toFixed(3)} ms`,
    );
    expect(await openSealedBox(key, sealed)).toEqual(value);
  });
});
