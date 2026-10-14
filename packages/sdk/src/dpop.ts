/**
 * DPoP (RFC 9449): a key of the client's own, and a signed proof for each
 * request naming its method, URL and (at the API) the access token, so a
 * token bound to the key is useless to anyone without it.
 */

import { base64url } from "./base64url.js";

const encoder = new TextEncoder();

const part = (value: unknown) => base64url(encoder.encode(JSON.stringify(value)));

const sha256 = async (text: string) =>
  base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));

export interface DpopKey {
  /** The key's thumbprint (RFC 7638), which a bound token names (`cnf.jkt`). */
  readonly jkt: string;
  /** A proof for `method` on `url` (its query and fragment left out) and, at the API, `accessToken`. */
  proof(method: string, url: string | URL, accessToken?: string): Promise<string>;
}

/**
 * A new ES256 key whose private half never leaves WebCrypto (it cannot be
 * exported), and its proofs.
 */
export async function createDpopKey(): Promise<DpopKey> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ])) as { privateKey: InstanceType<typeof CryptoKey>; publicKey: InstanceType<typeof CryptoKey> };
  const { x, y } = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as {
    x?: string;
    y?: string;
  };
  const jwk = { kty: "EC", crv: "P-256", x, y };
  // The thumbprint's members in lexicographic order (RFC 7638).
  const jkt = await sha256(JSON.stringify({ crv: "P-256", kty: "EC", x, y }));
  return {
    jkt,
    async proof(method, url, accessToken) {
      const at = new URL(url);
      const payload: Record<string, unknown> = {
        jti: crypto.randomUUID(),
        htm: method.toUpperCase(),
        htu: `${at.origin}${at.pathname}`,
        iat: Math.floor(Date.now() / 1000),
        ...(accessToken !== undefined && { ath: await sha256(accessToken) }),
      };
      const signingInput = `${part({ typ: "dpop+jwt", alg: "ES256", jwk })}.${part(payload)}`;
      // WebCrypto's ECDSA signature is r || s, as JWS wants it.
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        pair.privateKey,
        encoder.encode(signingInput),
      );
      return `${signingInput}.${base64url(new Uint8Array(signature))}`;
    },
  };
}
