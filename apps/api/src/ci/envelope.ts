/*
 * CI secrets' keys. The master key (`CI_SECRETS_KEY`, rotated through
 * `CI_SECRETS_KEY_NEXT`, opened by `CI_SECRETS_KEYS_RETIRED`; see
 * docs/operations/ci-secrets.md) never encrypts anything itself: HKDF-SHA256
 * derives from it a wrap key, for account data keys, and a mask key, for the
 * masks of delivered secrets. Each account has random 32-byte data keys, one
 * per generation, stored wrapped. From a data key HKDF derives the key secret
 * values are sealed with and each scope's X25519 box key (the public key
 * clients seal values for). Every HKDF here uses an empty salt.
 *
 * Every AES-256-GCM seal uses a fresh random 96-bit nonce, kept beside the
 * ciphertext, and additional data that binds the ciphertext to its place.
 * Nonces and ciphertexts are base64 text.
 */
import { fromBase64, hex, toBase64 } from "../crypto/bytes.js";
import { type Keyring, keyring } from "../crypto/keyring.js";
import { type BoxRecipient, x25519Recipient } from "./sealed-box.js";

const encoder = new TextEncoder();
// A leading U+FEFF is part of the value, not a byte order mark to drop.
const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
const EMPTY_SALT = new Uint8Array(0);

export interface MasterKey {
  readonly wrap: CryptoKey;
  readonly mask: CryptoKey;
}

export type CiKeyring = Keyring<MasterKey>;

async function hkdfBase(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey", "deriveBits"]);
}

function aesKey(base: CryptoKey, info: string): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: EMPTY_SALT, info: encoder.encode(info) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export const ciSecretKeys = keyring("CI_SECRETS", async (raw): Promise<MasterKey> => {
  const base = await hkdfBase(raw);
  return {
    wrap: await aesKey(base, "fyrden-ci-wrap:v1"),
    mask: await aesKey(base, "fyrden-ci-mask:v1"),
  };
});

interface Sealed {
  readonly nonce: string;
  readonly ciphertext: string;
}

async function seal(key: CryptoKey, additionalData: string, plain: Uint8Array): Promise<Sealed> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(additionalData) },
    key,
    plain.slice(),
  );
  return { nonce: toBase64(nonce), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}

async function open(
  key: CryptoKey,
  additionalData: string,
  sealed: Sealed,
): Promise<Uint8Array | undefined> {
  const nonce = fromBase64(sealed.nonce);
  const ciphertext = fromBase64(sealed.ciphertext);
  if (!nonce || !ciphertext) return undefined;
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(additionalData) },
        key,
        ciphertext,
      ),
    );
  } catch {
    return undefined;
  }
}

export function newDataKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

export interface DataKeyAt {
  readonly accountId: string;
  readonly generation: number;
}

/** A data key as stored: wrapped under the master key `masterKeyId`. */
export interface WrappedDataKey {
  readonly masterKeyId: string;
  readonly nonce: string;
  readonly wrapped: string;
}

const dataKeyAd = (at: DataKeyAt, masterKeyId: string) =>
  `fyrden-ci-data-key:v1:${at.accountId}:${at.generation}:${masterKeyId}`;

/** Wraps `dataKey` under the current master key; undefined when there is none. */
export async function wrapDataKey(
  keys: CiKeyring,
  at: DataKeyAt,
  dataKey: Uint8Array,
): Promise<WrappedDataKey | undefined> {
  const master = keys.current;
  if (!master) return undefined;
  const sealed = await seal(master.key.wrap, dataKeyAd(at, master.id), dataKey);
  return { masterKeyId: master.id, nonce: sealed.nonce, wrapped: sealed.ciphertext };
}

/** The data key's bytes; undefined when its master key is gone or it does not open here. */
export async function unwrapDataKey(
  keys: CiKeyring,
  at: DataKeyAt,
  wrapped: WrappedDataKey,
): Promise<Uint8Array | undefined> {
  const master = keys.byId.get(wrapped.masterKeyId);
  if (!master) return undefined;
  const raw = await open(master.key.wrap, dataKeyAd(at, wrapped.masterKeyId), {
    nonce: wrapped.nonce,
    ciphertext: wrapped.wrapped,
  });
  return raw?.length === 32 ? raw : undefined;
}

/** Where a secret value lives; `scope` is `org` or the repository id, `name` as stored. */
export interface SecretAt {
  readonly accountId: string;
  readonly scope: string;
  readonly name: string;
  readonly generation: number;
}

export interface SealedValue {
  readonly nonce: string;
  readonly ciphertext: string;
}

const secretAd = (at: SecretAt) =>
  `fyrden-ci-secret:v1:${at.accountId}:${at.scope}:${at.name}:${at.generation}`;

async function encKey(dataKey: Uint8Array): Promise<CryptoKey> {
  return aesKey(await hkdfBase(dataKey.slice()), "fyrden-ci-enc:v1");
}

export async function sealSecretValue(
  dataKey: Uint8Array,
  at: SecretAt,
  value: string,
): Promise<SealedValue> {
  return seal(await encKey(dataKey), secretAd(at), encoder.encode(value));
}

/** The secret's value; undefined when it does not open for this place and data key. */
export async function openSecretValue(
  dataKey: Uint8Array,
  at: SecretAt,
  sealed: SealedValue,
): Promise<string | undefined> {
  const plain = await open(await encKey(dataKey), secretAd(at), sealed);
  return plain && decoder.decode(plain);
}

/** A scope's box key: what clients seal secret values for. */
export interface BoxKey extends BoxRecipient {
  /** `<generation>.<first 8 bytes of SHA-256 of the public key, hex>`. */
  readonly keyId: string;
  /** The public key in base64, as GitHub serves it. */
  readonly key: string;
}

/**
 * The box key of `scope` (`org` or a repository id) for a data key: its private
 * key is HKDF(dataKey, `fyrden-ci-box:v1:<scope>`), derived again on each call
 * and never stored.
 */
export async function boxKey(
  dataKey: Uint8Array,
  generation: number,
  scope: string,
): Promise<BoxKey> {
  const seed = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: EMPTY_SALT,
        info: encoder.encode(`fyrden-ci-box:v1:${scope}`),
      },
      await hkdfBase(dataKey.slice()),
      256,
    ),
  );
  const recipient = await x25519Recipient(seed);
  seed.fill(0);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", recipient.publicKey.slice()));
  return {
    ...recipient,
    keyId: `${generation}.${hex(digest.subarray(0, 8))}`,
    key: toBase64(recipient.publicKey),
  };
}

/** A mask row's value, sealed under the mask key of master key `masterKeyId`. */
export interface SealedMask {
  readonly masterKeyId: string;
  readonly nonce: string;
  readonly ciphertext: string;
}

export type MaskAdditionalData = (masterKeyId: string) => string;

/**
 * Seals a mask value under the current master key's mask key, bound to
 * `additionalData(masterKeyId)`; undefined without a current key.
 */
export async function sealMask(
  keys: CiKeyring,
  additionalData: MaskAdditionalData,
  value: string,
): Promise<SealedMask | undefined> {
  const master = keys.current;
  if (!master) return undefined;
  return {
    masterKeyId: master.id,
    ...(await seal(master.key.mask, additionalData(master.id), encoder.encode(value))),
  };
}

/** The mask value; undefined when its master key is gone or it does not open. */
export async function openMask(
  keys: CiKeyring,
  additionalData: MaskAdditionalData,
  sealed: SealedMask,
): Promise<string | undefined> {
  const master = keys.byId.get(sealed.masterKeyId);
  if (!master) return undefined;
  const plain = await open(master.key.mask, additionalData(sealed.masterKeyId), sealed);
  return plain && decoder.decode(plain);
}
