// DPoP proofs (RFC 9449) as a client makes them: an ES256 key of its own,
// and a signed JWT per request naming the method, URL and access token.

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const part = (value: unknown) => base64url(encoder.encode(JSON.stringify(value)));

export interface DpopKey {
  /** A proof for `method` on `url` (and, at a resource, `accessToken`). */
  proof(
    method: string,
    url: string,
    accessToken?: string,
    claims?: Record<string, unknown>,
  ): Promise<string>;
  /** The key's RFC 7638 thumbprint (`dpop_jkt`). */
  readonly jkt: string;
}

export async function dpopKey(): Promise<DpopKey> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const publicJwk = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
  const thumbprint = base64url(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        encoder.encode(JSON.stringify({ crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y })),
      ),
    ),
  );
  return {
    jkt: thumbprint,
    async proof(method, url, accessToken, claims = {}) {
      const u = new URL(url);
      const payload: Record<string, unknown> = {
        jti: crypto.randomUUID(),
        htm: method,
        htu: `${u.origin}${u.pathname}`,
        iat: Math.floor(Date.now() / 1000),
        ...claims,
      };
      if (accessToken !== undefined)
        payload.ath = base64url(
          new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(accessToken))),
        );
      const signingInput = `${part({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk })}.${part(payload)}`;
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          pair.privateKey,
          encoder.encode(signingInput),
        ),
      );
      return `${signingInput}.${base64url(signature)}`;
    },
  };
}
