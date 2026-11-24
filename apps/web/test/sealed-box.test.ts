// Sealing a value the way `gh secret set` does (libsodium `crypto_box_seal`):
// the web Worker's box is byte for byte Go's for the same ephemeral key, and an
// opener written for the tests (helpers/sealed-box.ts) opens it.
import { describe, expect, it } from "vitest";
import { sealBox } from "../app/lib/sealed-box.server.js";
import { fixture, fromBase64, open, sha256, utf8 } from "./helpers/sealed-box.js";

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
