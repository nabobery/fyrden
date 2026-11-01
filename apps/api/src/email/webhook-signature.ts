/*
 * Standard Webhooks signatures (https://www.standardwebhooks.com/), as
 * Resend signs its webhooks: headers `svix-id`, `svix-timestamp` (Unix
 * seconds) and `svix-signature` (space-separated `v1,<base64>` entries,
 * several while a secret rotates), each an HMAC-SHA256 of
 * `<id>.<timestamp>.<body>` keyed by the endpoint's secret
 * (`whsec_<base64>`). A request verifies when any `v1` entry matches and
 * its timestamp is within five minutes of now.
 */

/** How far a signature's timestamp may be from now. */
export const SIGNATURE_TOLERANCE_MS = 5 * 60_000;

/** Signature entries read at most (a rotation has two or three). */
const MAX_SIGNATURES = 8;

const SECRET = /^whsec_([A-Za-z0-9+/]+={0,2})$/;
const SIGNATURE = /^v1,([A-Za-z0-9+/]{43}=)$/;

/** Standard base64's bytes; undefined for any other text. */
function base64Bytes(text: string): Uint8Array | undefined {
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/**
 * A secret's key bytes: `whsec_` and canonical padded standard base64 (what
 * encoding the bytes gives back exactly) of at least 16 bytes; undefined
 * otherwise. The CLI applies the same rule before a deploy.
 */
export function webhookSecretBytes(secret: unknown): Uint8Array | undefined {
  if (typeof secret !== "string") return undefined;
  const text = SECRET.exec(secret)?.[1];
  const raw = text === undefined ? undefined : base64Bytes(text);
  if (!raw || raw.length < 16 || btoa(String.fromCharCode(...raw)) !== text) return undefined;
  return raw;
}

/** A secret's HMAC key, by its text; null when it is not a usable secret (`webhookSecretBytes`). */
export async function webhookKey(secret: string): Promise<CryptoKey | null> {
  const raw = webhookSecretBytes(secret);
  if (!raw) return null;
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
}

/** Whether a request's headers and body (its bytes as received) carry a valid signature at `now`. */
export async function verifyWebhook(
  key: CryptoKey,
  headers: Headers,
  body: Uint8Array,
  now: number,
): Promise<boolean> {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signatures = headers.get("svix-signature");
  if (!id || !timestamp || !signatures || !/^[0-9]{1,12}$/.test(timestamp)) return false;
  if (Math.abs(now - Number(timestamp) * 1000) > SIGNATURE_TOLERANCE_MS) return false;
  const prefix = new TextEncoder().encode(`${id}.${timestamp}.`);
  const content = new Uint8Array(prefix.length + body.length);
  content.set(prefix);
  content.set(body, prefix.length);
  for (const entry of signatures.split(" ").slice(0, MAX_SIGNATURES)) {
    const mac = SIGNATURE.exec(entry)?.[1];
    const bytes = mac === undefined ? undefined : base64Bytes(mac);
    if (bytes?.length === 32 && (await crypto.subtle.verify("HMAC", key, bytes, content)))
      return true;
  }
  return false;
}
