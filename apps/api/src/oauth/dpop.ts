import { base64url } from "./params.js";

/**
 * DPoP proofs (RFC 9449): a JWT a client signs with its own key for each
 * request, naming the method and URL (and, at a resource, the access
 * token's hash). A token issued against a proof is bound to the key's
 * thumbprint (`jkt`) and accepted only with a fresh proof by that key,
 * never as a bearer token. ES256 and EdDSA (Ed25519) keys, checked with
 * WebCrypto; each proof's `jti` is taken once (replay refused) while it is
 * fresh.
 */

/** Proposed. */
export const DPOP_POLICY = {
  /** How far a proof's `iat` may be from now, either way. */
  maxSkewMs: 60 * 1000,
  /** The largest proof read. */
  maxProofBytes: 4096,
};

export const DPOP_ALGS = ["ES256", "EdDSA"] as const;

type Jwk = { kty?: unknown; crv?: unknown; x?: unknown; y?: unknown; d?: unknown };

export type DpopCheck =
  | { ok: true; jkt: string; jti: string; iat: number }
  | { ok: false; reason: string };

const decoder = new TextDecoder();

function fromBase64url(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function jsonPart(part: string): Record<string, unknown> | undefined {
  const bytes = fromBase64url(part);
  if (!bytes) return undefined;
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The key's RFC 7638 SHA-256 thumbprint, base64url: its required members, in order. */
export async function jwkThumbprint(jwk: Jwk): Promise<string> {
  const members =
    jwk.kty === "EC"
      ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }
      : { crv: jwk.crv, kty: jwk.kty, x: jwk.x };
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(members)),
  );
  return base64url(new Uint8Array(digest));
}

/** The public key a proof's header names, for its algorithm; undefined for any other. */
async function importKey(alg: unknown, jwk: Jwk): Promise<CryptoKey | undefined> {
  if (jwk.d !== undefined) return undefined; // a private key is never sent
  try {
    if (
      alg === "ES256" &&
      jwk.kty === "EC" &&
      jwk.crv === "P-256" &&
      typeof jwk.x === "string" &&
      typeof jwk.y === "string"
    )
      return await crypto.subtle.importKey(
        "jwk",
        { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
    if (alg === "EdDSA" && jwk.kty === "OKP" && jwk.crv === "Ed25519" && typeof jwk.x === "string")
      return await crypto.subtle.importKey(
        "jwk",
        { kty: "OKP", crv: "Ed25519", x: jwk.x },
        { name: "Ed25519" },
        false,
        ["verify"],
      );
  } catch {
    return undefined;
  }
  return undefined;
}

/** A request URL as a proof's `htu` names it: no query, no fragment. */
export function htuOf(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
}

/** base64url SHA-256 of an access token (a proof's `ath` at a resource). */
export async function accessTokenHash(token: string): Promise<string> {
  return base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))),
  );
}

/**
 * Checks a proof for `method` and `url` at `now` (and, at a resource, that
 * it names `accessToken`): its form, key, signature and claims. The `jti`
 * is not recorded here (`takeJti`).
 */
export async function checkProof(
  proof: string,
  request: { readonly method: string; readonly url: string; readonly now: number },
  accessToken?: string,
): Promise<DpopCheck> {
  const fail = (reason: string): DpopCheck => ({ ok: false, reason });
  if (proof.length > DPOP_POLICY.maxProofBytes) return fail("the proof is too long");
  const parts = proof.split(".");
  if (parts.length !== 3) return fail("the proof is not a JWT");
  const [h = "", p = "", sig = ""] = parts;
  const header = jsonPart(h);
  const claims = jsonPart(p);
  const signature = fromBase64url(sig);
  if (!header || !claims || !signature) return fail("the proof is malformed");
  if (header.typ !== "dpop+jwt") return fail("the proof's typ is not dpop+jwt");
  const jwk = header.jwk as Jwk | undefined;
  if (typeof jwk !== "object" || jwk === null) return fail("the proof names no key");
  const key = await importKey(header.alg, jwk);
  if (!key) return fail("the proof's key or algorithm is not supported (ES256, EdDSA)");
  const algorithm =
    header.alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "Ed25519" };
  const valid = await crypto.subtle.verify(
    algorithm,
    key,
    signature,
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!valid) return fail("the proof's signature does not verify");
  const { jti, htm, htu, iat, ath } = claims;
  if (typeof jti !== "string" || jti.length === 0 || jti.length > 128)
    return fail("the proof has no usable jti");
  if (htm !== request.method) return fail("the proof's htm is not this request's method");
  if (typeof htu !== "string" || htu !== htuOf(request.url))
    return fail("the proof's htu is not this request's URL");
  if (typeof iat !== "number" || Math.abs(request.now - iat * 1000) > DPOP_POLICY.maxSkewMs)
    return fail("the proof is not fresh");
  if (accessToken !== undefined && ath !== (await accessTokenHash(accessToken)))
    return fail("the proof's ath is not this access token's");
  return { ok: true, jkt: await jwkThumbprint(jwk), jti, iat: iat * 1000 };
}

/**
 * Takes a proof's `jti` for its key, once: false when it was taken before
 * (a replay). Kept while the proof could be fresh.
 */
export async function takeJti(
  env: Env,
  check: { jkt: string; jti: string; iat: number },
): Promise<boolean> {
  const taken = await env.DIRECTORY.prepare(
    `INSERT INTO dpop_proofs (jkt, jti, expires_at) VALUES (?, ?, ?)
     ON CONFLICT (jkt, jti) DO NOTHING`,
  )
    .bind(check.jkt, check.jti, check.iat + 2 * DPOP_POLICY.maxSkewMs)
    .run();
  return (taken.meta.changes ?? 0) > 0;
}
