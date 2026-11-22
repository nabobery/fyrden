// CI secrets' key hierarchy: account data keys wrapped under the master key,
// secret values sealed under a key derived from the data key and bound to
// their place, per-scope X25519 box keys derived from the data key, and mask
// rows sealed under the master key's mask key.
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import {
  boxKey,
  ciSecretKeys,
  newDataKey,
  openMask,
  openSecretValue,
  sealMask,
  sealSecretValue,
  unwrapDataKey,
  wrapDataKey,
} from "../src/ci/envelope.js";

const newKey = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function sha256Hex8(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest.subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** AES-256-GCM key HKDF-SHA256 (empty salt) derives from `raw` for `info`: the stored format. */
async function derivedAesKey(raw: Uint8Array, info: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", raw.slice(), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(info),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
}

async function aesOpen(key: CryptoKey, ad: string, nonce: string, ciphertext: string) {
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(nonce), additionalData: new TextEncoder().encode(ad) },
      key,
      fromBase64(ciphertext),
    ),
  );
}

function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a value");
  return value;
}

describe("data keys", () => {
  it("are 32 random bytes", () => {
    const a = newDataKey();
    expect(a).toHaveLength(32);
    expect(newDataKey()).not.toEqual(a);
  });

  it("wrap under the current master key and unwrap to the same bytes", async () => {
    const master = newKey();
    const keys = await ciSecretKeys({ CI_SECRETS_KEY: master });
    const at = { accountId: uniqueId("acct"), generation: 3 };
    const dataKey = newDataKey();
    const wrapped = defined(await wrapDataKey(keys, at, dataKey));
    expect(wrapped.masterKeyId).toBe(await sha256Hex8(fromBase64(master)));
    expect(fromBase64(wrapped.nonce)).toHaveLength(12);
    // 32 bytes and a 16-byte tag; the data key's bytes are not in it.
    const wrappedBytes = fromBase64(wrapped.wrapped);
    expect(wrappedBytes).toHaveLength(48);
    expect(wrappedBytes.subarray(0, 32)).not.toEqual(dataKey);
    expect(await unwrapDataKey(keys, at, wrapped)).toEqual(dataKey);
  });

  it("are stored in the documented format: AES-GCM under HKDF(master, wrap info)", async () => {
    const master = newKey();
    const keys = await ciSecretKeys({ CI_SECRETS_KEY: master });
    const at = { accountId: uniqueId("acct"), generation: 2 };
    const dataKey = newDataKey();
    const wrapped = defined(await wrapDataKey(keys, at, dataKey));
    const wrapKey = await derivedAesKey(fromBase64(master), "fyrden-ci-wrap:v1");
    const ad = `fyrden-ci-data-key:v1:${at.accountId}:2:${wrapped.masterKeyId}`;
    expect(await aesOpen(wrapKey, ad, wrapped.nonce, wrapped.wrapped)).toEqual(dataKey);
    // And the value is sealed under HKDF(data key, enc info), bound to its place.
    const secretAt = { accountId: at.accountId, scope: "org", name: "A_NAME", generation: 2 };
    const sealed = await sealSecretValue(dataKey, secretAt, "plain");
    const encKey = await derivedAesKey(dataKey, "fyrden-ci-enc:v1");
    const secretAd = `fyrden-ci-secret:v1:${at.accountId}:org:A_NAME:2`;
    expect(
      new TextDecoder().decode(await aesOpen(encKey, secretAd, sealed.nonce, sealed.ciphertext)),
    ).toBe("plain");
  });

  it("do not unwrap for another account, generation or master key id", async () => {
    const keys = await ciSecretKeys({
      CI_SECRETS_KEY: newKey(),
      CI_SECRETS_KEYS_RETIRED: newKey(),
    });
    const at = { accountId: uniqueId("acct"), generation: 1 };
    const wrapped = defined(await wrapDataKey(keys, at, newDataKey()));
    expect(await unwrapDataKey(keys, { ...at, accountId: uniqueId("acct") }, wrapped)).toBe(
      undefined,
    );
    expect(await unwrapDataKey(keys, { ...at, generation: 2 }, wrapped)).toBeUndefined();
    const otherId = [...keys.byId.keys()].find((id) => id !== wrapped.masterKeyId);
    expect(otherId).toBeDefined();
    expect(
      await unwrapDataKey(keys, at, { ...wrapped, masterKeyId: otherId as string }),
    ).toBeUndefined();
    // Nor once the master key that wrapped it is gone, nor tampered.
    expect(await unwrapDataKey(await ciSecretKeys({}), at, wrapped)).toBeUndefined();
    const tampered = fromBase64(wrapped.wrapped);
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    expect(
      await unwrapDataKey(keys, at, {
        ...wrapped,
        wrapped: btoa(String.fromCharCode(...tampered)),
      }),
    ).toBeUndefined();
    expect(await unwrapDataKey(keys, at, { ...wrapped, nonce: "%%%" })).toBeUndefined();
  });

  it("still unwrap under a master key since retired", async () => {
    const old = newKey();
    const at = { accountId: uniqueId("acct"), generation: 1 };
    const dataKey = newDataKey();
    const wrapped = defined(
      await wrapDataKey(await ciSecretKeys({ CI_SECRETS_KEY: old }), at, dataKey),
    );
    const later = await ciSecretKeys({ CI_SECRETS_KEY: newKey(), CI_SECRETS_KEYS_RETIRED: old });
    expect(await unwrapDataKey(later, at, wrapped)).toEqual(dataKey);
  });

  it("are not wrapped without a current master key", async () => {
    const at = { accountId: uniqueId("acct"), generation: 1 };
    expect(await wrapDataKey(await ciSecretKeys({}), at, newDataKey())).toBeUndefined();
    const misconfigured = await ciSecretKeys({ CI_SECRETS_KEY: newKey(), CI_SECRETS_KEY_NEXT: "" });
    expect(await wrapDataKey(misconfigured, at, newDataKey())).toBeUndefined();
  });

  it("wrap with a fresh nonce each time", async () => {
    const keys = await ciSecretKeys({ CI_SECRETS_KEY: newKey() });
    const at = { accountId: uniqueId("acct"), generation: 1 };
    const dataKey = newDataKey();
    const a = defined(await wrapDataKey(keys, at, dataKey));
    const b = defined(await wrapDataKey(keys, at, dataKey));
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.wrapped).not.toBe(b.wrapped);
  });
});

describe("secret values", () => {
  const place = () => ({
    accountId: uniqueId("acct"),
    scope: uniqueId("repo"),
    name: "DEPLOY_TOKEN",
    generation: 1,
  });

  it("seal and open to the same text, and the text is not in the ciphertext", async () => {
    const dataKey = newDataKey();
    const at = place();
    const value = `value-${crypto.randomUUID()} ✓`;
    const sealed = await sealSecretValue(dataKey, at, value);
    expect(fromBase64(sealed.nonce)).toHaveLength(12);
    expect(atob(sealed.ciphertext)).not.toContain(value.slice(0, 20));
    expect(await openSecretValue(dataKey, at, sealed)).toBe(value);
    expect(await openSecretValue(dataKey, { ...at, scope: "org" }, sealed)).toBeUndefined();
  });

  it("keep a leading byte order mark", async () => {
    const dataKey = newDataKey();
    const at = place();
    const value = "\uFEFFvalue";
    expect(await openSecretValue(dataKey, at, await sealSecretValue(dataKey, at, value))).toBe(
      value,
    );
    const keys = await ciSecretKeys({ CI_SECRETS_KEY: newKey() });
    const ad = (k: string) => `fyrden-ci-mask:v1:${at.scope}:1:1:secret:${k}`;
    const mask = defined(await sealMask(keys, ad, value));
    expect(await openMask(keys, ad, mask)).toBe(value);
  });

  it("do not open under another name, scope, generation, account or data key", async () => {
    const dataKey = newDataKey();
    const at = place();
    const sealed = await sealSecretValue(dataKey, at, `value-${crypto.randomUUID()}`);
    for (const moved of [
      { ...at, name: "OTHER_TOKEN" },
      { ...at, scope: uniqueId("repo") },
      { ...at, scope: "org" },
      { ...at, generation: 2 },
      { ...at, accountId: uniqueId("acct") },
    ]) {
      expect(await openSecretValue(dataKey, moved, sealed)).toBeUndefined();
    }
    expect(await openSecretValue(newDataKey(), at, sealed)).toBeUndefined();
  });

  it("seal the same value with distinct nonces", async () => {
    const dataKey = newDataKey();
    const at = place();
    const value = `value-${crypto.randomUUID()}`;
    const seals = await Promise.all(
      Array.from({ length: 8 }, () => sealSecretValue(dataKey, at, value)),
    );
    expect(new Set(seals.map((s) => s.nonce)).size).toBe(8);
    expect(new Set(seals.map((s) => s.ciphertext)).size).toBe(8);
  });
});

describe("box keys", () => {
  it("are the same for the same data key and scope", async () => {
    const dataKey = newDataKey();
    const scope = uniqueId("repo");
    const a = await boxKey(dataKey, 1, scope);
    const b = await boxKey(dataKey, 1, scope);
    expect(a.key).toBe(b.key);
    expect(a.keyId).toBe(b.keyId);
    expect(a.publicKey).toHaveLength(32);
    expect(fromBase64(a.key)).toEqual(a.publicKey);
  });

  it("differ across scopes and data keys", async () => {
    const dataKey = newDataKey();
    const scope = uniqueId("repo");
    const keys = await Promise.all([
      boxKey(dataKey, 1, scope),
      boxKey(dataKey, 1, uniqueId("repo")),
      boxKey(dataKey, 1, "org"),
      boxKey(newDataKey(), 1, scope),
    ]);
    expect(new Set(keys.map((k) => k.key)).size).toBe(4);
  });

  it("are named <generation>.<first 8 bytes of SHA-256 of the public key, hex>", async () => {
    const key = await boxKey(newDataKey(), 7, uniqueId("repo"));
    expect(key.keyId).toBe(`7.${await sha256Hex8(key.publicKey)}`);
    expect(key.keyId).toMatch(/^7\.[0-9a-f]{16}$/);
    // Base64 with padding, as GitHub serves a public key.
    expect(key.key).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });
});

describe("mask rows", () => {
  it("seal under the current master key and open with the same additional data", async () => {
    const keys = await ciSecretKeys({ CI_SECRETS_KEY: newKey() });
    const keyId = defined(keys.current).id;
    const run = uniqueId("run");
    const ad = (k: string) => `fyrden-ci-mask:v1:${run}:1:1:secret:${k}`;
    const value = `mask-${crypto.randomUUID()}`;
    const sealed = defined(await sealMask(keys, ad, value));
    expect(sealed.masterKeyId).toBe(keyId);
    expect(fromBase64(sealed.nonce)).toHaveLength(12);
    expect(atob(sealed.ciphertext)).not.toContain(value);
    expect(await openMask(keys, ad, sealed)).toBe(value);
    expect(await openMask(keys, (k) => `${ad(k)}x`, sealed)).toBeUndefined();
    const again = defined(await sealMask(keys, ad, value));
    expect(again.nonce).not.toBe(sealed.nonce);
  });

  it("open under a retired key and are not sealed without a current one", async () => {
    const old = newKey();
    const run = uniqueId("run");
    const ad = (k: string) => `fyrden-ci-mask:v1:${run}:1:1:secret:${k}`;
    const sealed = defined(await sealMask(await ciSecretKeys({ CI_SECRETS_KEY: old }), ad, "v"));
    const retired = await ciSecretKeys({ CI_SECRETS_KEYS_RETIRED: old });
    expect(await openMask(retired, ad, sealed)).toBe("v");
    expect(await sealMask(retired, ad, "v")).toBeUndefined();
  });

  it("are not opened by the wrap key: the master key's two purposes differ", async () => {
    const keys = await ciSecretKeys({ CI_SECRETS_KEY: newKey() });
    const at = { accountId: uniqueId("acct"), generation: 1 };
    const keyId = defined(keys.current).id;
    const wrapped = defined(await wrapDataKey(keys, at, newDataKey()));
    // The same nonce, ciphertext and additional data, read as a mask row.
    const asMask = { masterKeyId: keyId, nonce: wrapped.nonce, ciphertext: wrapped.wrapped };
    const ad = (k: string) => `fyrden-ci-data-key:v1:${at.accountId}:${at.generation}:${k}`;
    expect(await openMask(keys, ad, asMask)).toBeUndefined();
  });
});
