/*
 * A deployment's keys for one purpose, read from three Worker variables named
 * by a prefix: `<PREFIX>_KEY` (32 bytes, base64), `<PREFIX>_KEY_NEXT` (while a
 * rotation is under way it seals, and `<PREFIX>_KEY` still opens what it
 * sealed) and `<PREFIX>_KEYS_RETIRED` (base64 keys, one per line, that only
 * open). A key's id is the first 8 bytes of SHA-256 of its bytes, in hex.
 */
import { fromBase64, hex } from "./bytes.js";

export interface KeyringKey<K> {
  readonly id: string;
  readonly key: K;
}

/** The keys values are sealed with: the current one (if set), and every one that opens. */
export interface Keyring<K> {
  readonly current: KeyringKey<K> | undefined;
  readonly byId: ReadonlyMap<string, KeyringKey<K>>;
  /** A key variable that is set but is not a 32-byte key: nothing is sealed until it is fixed. */
  readonly misconfigured?: string;
}

/**
 * The loader of the keyring under `prefix`, each key's 32 raw bytes imported by
 * `importRaw`. It keeps, per isolate, the keyring made for the variables'
 * current values.
 */
export function keyring<K>(
  prefix: string,
  importRaw: (raw: Uint8Array<ArrayBuffer>) => Promise<K>,
): (env: object) => Promise<Keyring<K>> {
  const names = {
    key: `${prefix}_KEY`,
    next: `${prefix}_KEY_NEXT`,
    retired: `${prefix}_KEYS_RETIRED`,
  };
  let cache: { readonly from: string; readonly value: Promise<Keyring<K>> } | undefined;

  async function keyOf(text: string): Promise<KeyringKey<K> | undefined> {
    const raw = fromBase64(text.trim());
    if (raw?.length !== 32) return undefined;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
    return { id: hex(digest.subarray(0, 8)), key: await importRaw(raw) };
  }

  async function load(
    key: string | undefined,
    next: string | undefined,
    retired: string | undefined,
  ): Promise<Keyring<K>> {
    const byId = new Map<string, KeyringKey<K>>();
    const current = key !== undefined ? await keyOf(key) : undefined;
    const upcoming = next !== undefined ? await keyOf(next) : undefined;
    // A key set but unreadable seals nothing (never the old key in its place, which would make a
    // rotation look done); the readable ones still open. Set means present, an empty value included.
    const misconfigured =
      next !== undefined && !upcoming
        ? `${names.next} is not a 32-byte base64 key`
        : key !== undefined && !current
          ? `${names.key} is not a 32-byte base64 key`
          : undefined;
    for (const k of [current, upcoming]) if (k) byId.set(k.id, k);
    for (const line of (retired ?? "").split("\n")) {
      if (!line.trim()) continue;
      const k = await keyOf(line);
      if (k && !byId.has(k.id)) byId.set(k.id, k);
    }
    return {
      current: misconfigured ? undefined : (upcoming ?? current),
      byId,
      ...(misconfigured && { misconfigured }),
    };
  }

  return (env) => {
    const vars = env as Readonly<Record<string, unknown>>;
    // A binding that is not text (a JSON variable) reads as an empty value, never as absent: an
    // invalid `_KEY` or `_KEY_NEXT` seals nothing, and an invalid retired list holds no keys.
    const value = (name: string) => {
      const v = vars[name];
      return v === undefined ? undefined : typeof v === "string" ? v : "";
    };
    const key = value(names.key);
    const next = value(names.next);
    const retired = value(names.retired);
    // Absent and empty are different settings (an empty one is misconfigured).
    const from = JSON.stringify([key ?? null, next ?? null, retired ?? null]);
    if (cache?.from !== from) cache = { from, value: load(key, next, retired) };
    return cache.value;
  };
}
