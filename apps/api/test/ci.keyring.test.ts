// The keyring both webhook secrets and CI secrets are kept with: `<PREFIX>_KEY`,
// `<PREFIX>_KEY_NEXT` (seals while a rotation is under way) and
// `<PREFIX>_KEYS_RETIRED` (only opens). The webhook behaviour has its own
// tests in webhooks.signing.test.ts.
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import { ciSecretKeys, newDataKey, unwrapDataKey, wrapDataKey } from "../src/ci/envelope.js";
import { keyring } from "../src/crypto/keyring.js";
import { secretKeys } from "../src/webhooks/secrets.js";

const newKey = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

async function idOf(base64: string): Promise<string> {
  const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  return [...digest.subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const at = () => ({ accountId: uniqueId("acct"), generation: 1 });

describe("keyring", () => {
  it("names each key by the first 8 bytes of SHA-256 of its bytes, and imports it as asked", async () => {
    const key = newKey();
    const imported: number[] = [];
    const load = keyring("KEYRING_IDS", async (raw) => {
      imported.push(raw.length);
      return raw.length;
    });
    const keys = await load({ KEYRING_IDS_KEY: key });
    expect(keys.current?.id).toBe(await idOf(key));
    expect(keys.current?.id).toMatch(/^[0-9a-f]{16}$/);
    expect(keys.current?.key).toBe(32);
    expect(imported).toEqual([32]);
    expect([...keys.byId.keys()]).toEqual([await idOf(key)]);
    expect(keys.misconfigured).toBeUndefined();
    // The same values again: the keyring made for them, not a new import.
    expect(await load({ KEYRING_IDS_KEY: key })).toBe(keys);
    expect(imported).toEqual([32]);
  });

  it("is none without its variables", async () => {
    const keys = await ciSecretKeys({});
    expect(keys.current).toBeUndefined();
    expect(keys.byId.size).toBe(0);
    expect(keys.misconfigured).toBeUndefined();
  });

  it("seals with _NEXT during a rotation while the current key still opens", async () => {
    const old = newKey();
    const next = newKey();
    const where = at();
    const dataKey = newDataKey();
    const before = await wrapDataKey(await ciSecretKeys({ CI_SECRETS_KEY: old }), where, dataKey);
    expect(before?.masterKeyId).toBe(await idOf(old));

    const rotating = await ciSecretKeys({ CI_SECRETS_KEY: old, CI_SECRETS_KEY_NEXT: next });
    expect(rotating.current?.id).toBe(await idOf(next));
    expect(rotating.byId.size).toBe(2);
    expect(await unwrapDataKey(rotating, where, before as NonNullable<typeof before>)).toEqual(
      dataKey,
    );
    const during = await wrapDataKey(rotating, where, dataKey);
    expect(during?.masterKeyId).toBe(await idOf(next));

    // The new key promoted alone opens what it sealed.
    const promoted = await ciSecretKeys({ CI_SECRETS_KEY: next });
    expect(await unwrapDataKey(promoted, where, during as NonNullable<typeof during>)).toEqual(
      dataKey,
    );
  });

  it("only opens with a retired key", async () => {
    const old = newKey();
    const current = newKey();
    const where = at();
    const dataKey = newDataKey();
    const wrapped = await wrapDataKey(await ciSecretKeys({ CI_SECRETS_KEY: old }), where, dataKey);
    if (!wrapped) throw new Error("not wrapped");

    const retiredOnly = await ciSecretKeys({ CI_SECRETS_KEYS_RETIRED: `\n${old}\n\n` });
    expect(retiredOnly.current).toBeUndefined();
    expect(retiredOnly.misconfigured).toBeUndefined();
    expect(await wrapDataKey(retiredOnly, where, dataKey)).toBeUndefined();
    expect(await unwrapDataKey(retiredOnly, where, wrapped)).toEqual(dataKey);

    const withCurrent = await ciSecretKeys({
      CI_SECRETS_KEY: current,
      CI_SECRETS_KEYS_RETIRED: [newKey(), old].join("\n"),
    });
    expect(withCurrent.current?.id).toBe(await idOf(current));
    expect(withCurrent.byId.size).toBe(3);
    expect(await unwrapDataKey(withCurrent, where, wrapped)).toEqual(dataKey);
  });

  it("seals nothing while a variable is set but not a 32-byte key; readable keys still open", async () => {
    const good = newKey();
    const where = at();
    const dataKey = newDataKey();
    const wrapped = await wrapDataKey(await ciSecretKeys({ CI_SECRETS_KEY: good }), where, dataKey);
    if (!wrapped) throw new Error("not wrapped");
    const short = btoa("x".repeat(31));
    const cases: Record<string, string>[] = [
      { CI_SECRETS_KEY: good, CI_SECRETS_KEY_NEXT: "" },
      { CI_SECRETS_KEY: good, CI_SECRETS_KEY_NEXT: short },
      { CI_SECRETS_KEY: good, CI_SECRETS_KEY_NEXT: "not base64!" },
      { CI_SECRETS_KEY: "", CI_SECRETS_KEYS_RETIRED: good },
      { CI_SECRETS_KEY: short, CI_SECRETS_KEYS_RETIRED: good },
    ];
    for (const vars of cases) {
      const keys = await ciSecretKeys(vars);
      expect(keys.current).toBeUndefined();
      const bad = vars.CI_SECRETS_KEY === good ? "CI_SECRETS_KEY_NEXT" : "CI_SECRETS_KEY";
      expect(keys.misconfigured).toBe(`${bad} is not a 32-byte base64 key`);
      expect(await wrapDataKey(keys, where, dataKey)).toBeUndefined();
      expect(await unwrapDataKey(keys, where, wrapped)).toEqual(dataKey);
    }
    // Fixed, the key seals again.
    expect((await ciSecretKeys({ CI_SECRETS_KEY: good })).current?.id).toBe(await idOf(good));
  });

  it("treats a key variable bound to a value that is not text as set and invalid", async () => {
    const good = newKey();
    // A JSON variable binding can hold a number or an object instead of text.
    for (const next of [42, { key: good }, null]) {
      const ci = await ciSecretKeys({ CI_SECRETS_KEY: good, CI_SECRETS_KEY_NEXT: next });
      expect(ci.current).toBeUndefined();
      expect(ci.misconfigured).toBe("CI_SECRETS_KEY_NEXT is not a 32-byte base64 key");
      expect(ci.byId.has(await idOf(good))).toBe(true);
      const hooks = await secretKeys({ WEBHOOKS_KEY: good, WEBHOOKS_KEY_NEXT: next });
      expect(hooks.current).toBeUndefined();
      expect(hooks.misconfigured).toBe("WEBHOOKS_KEY_NEXT is not a 32-byte base64 key");
    }
  });

  it("keeps the webhook and CI keyrings apart when read in turn", async () => {
    const webhooksKey = newKey();
    const ciKey = newKey();
    for (let i = 0; i < 2; i++) {
      const webhooks = await secretKeys({ WEBHOOKS_KEY: webhooksKey, CI_SECRETS_KEY: ciKey });
      const ci = await ciSecretKeys({ WEBHOOKS_KEY: webhooksKey, CI_SECRETS_KEY: ciKey });
      expect(webhooks.current?.id).toBe(await idOf(webhooksKey));
      expect(webhooks.current?.key.algorithm.name).toBe("AES-GCM");
      expect(ci.current?.id).toBe(await idOf(ciKey));
    }
  });
});
