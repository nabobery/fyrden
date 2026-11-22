/*
 * Webhook secrets: made here (32 random bytes, `whsec_` + base64, the
 * Standard Webhooks form), shown once, and kept sealed: AES-256-GCM with a
 * random 12-byte nonce, its additional data binding the repository, the
 * hook and the key, so a sealed secret copied to another hook or
 * repository does not open. The key is the Worker secret `WEBHOOKS_KEY`
 * (32 bytes, base64; `fyrden deploy` makes one when there is none). A
 * rotation sets the new key as `WEBHOOKS_KEY_NEXT`, which then seals while
 * the old one still opens, until every secret is sealed again and the new
 * key becomes `WEBHOOKS_KEY` (see docs/operations/webhooks.md); keys in
 * `WEBHOOKS_KEYS_RETIRED` (one per line) only open.
 *
 * Deliveries are signed as Standard Webhooks v1 says: HMAC-SHA256 of
 * `<webhook-id>.<webhook-timestamp>.<body>` with the secret's bytes, given
 * as `v1,<base64>`, one per secret (two while a secret is being rotated).
 */

import { fromBase64, toBase64 } from "../crypto/bytes.js";
import { type Keyring, keyring } from "../crypto/keyring.js";

const SECRET_PREFIX = "whsec_";
const encoder = new TextEncoder();

/** A secret as a hook keeps it. */
export interface SealedSecret {
  readonly keyId: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly createdAt: number;
}

/** The keys secrets are sealed with: the current one (if set), and the retired ones. */
export type SecretKeys = Keyring<CryptoKey>;

/** The deployment's keys; a value that is not a 32-byte key is left out. */
export const secretKeys = keyring("WEBHOOKS", (raw) =>
  crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
);

/** A new secret: 32 random bytes, `whsec_` + base64. */
export function newSecret(): string {
  return SECRET_PREFIX + toBase64(crypto.getRandomValues(new Uint8Array(32)));
}

/** What binds a sealed secret to its place. */
const additionalData = (repoId: string, hookId: number, keyId: string) =>
  encoder.encode(`fyrden-webhook-secret:v1:${repoId}:${hookId}:${keyId}`);

/** Seals `secret` for the hook with the current key; undefined without one. */
export async function sealSecret(
  keys: SecretKeys,
  at: { readonly repoId: string; readonly hookId: number },
  secret: string,
  now: number,
): Promise<SealedSecret | undefined> {
  const key = keys.current;
  if (!key) return undefined;
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: additionalData(at.repoId, at.hookId, key.id) },
    key.key,
    encoder.encode(secret),
  );
  return {
    keyId: key.id,
    nonce: toBase64(nonce),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
    createdAt: now,
  };
}

/** Opens a sealed secret of the hook; undefined when its key is gone or it does not open. */
export async function openSecret(
  keys: SecretKeys,
  at: { readonly repoId: string; readonly hookId: number },
  sealed: SealedSecret,
): Promise<string | undefined> {
  const key = keys.byId.get(sealed.keyId);
  const nonce = fromBase64(sealed.nonce);
  const ciphertext = fromBase64(sealed.ciphertext);
  if (!key || !nonce || !ciphertext) return undefined;
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: additionalData(at.repoId, at.hookId, sealed.keyId),
      },
      key.key,
      ciphertext,
    );
    return new TextDecoder().decode(plain);
  } catch {
    return undefined;
  }
}

/** The value of a delivery's `webhook-signature` header: one `v1,` signature per secret. */
export async function signature(
  secrets: readonly string[],
  message: { readonly id: string; readonly timestamp: number; readonly body: Uint8Array },
): Promise<string> {
  const prefix = encoder.encode(`${message.id}.${message.timestamp}.`);
  // Copied once, not spread element by element (a body is up to 192 KiB).
  const signed = new Uint8Array(prefix.length + message.body.length);
  signed.set(prefix);
  signed.set(message.body, prefix.length);
  const parts: string[] = [];
  for (const secret of secrets) {
    const raw = fromBase64(
      secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : "",
    );
    if (!raw) continue;
    const key = await crypto.subtle.importKey(
      "raw",
      raw,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    parts.push(`v1,${toBase64(new Uint8Array(await crypto.subtle.sign("HMAC", key, signed)))}`);
  }
  return parts.join(" ");
}
