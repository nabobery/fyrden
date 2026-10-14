/**
 * WebAuthn (passkeys) verification on WebCrypto: a registration's
 * attestation (format `none` only: Fyrden asks for no attestation) and a
 * sign-in's assertion. Keys are ES256, EdDSA (Ed25519) or RS256; user
 * presence and verification are required; the client data must name this
 * origin and the challenge issued; a signature counter that does not move
 * forward (a cloned authenticator) is refused.
 */

export const COSE_ALGS = { ES256: -7, EdDSA: -8, RS256: -257 } as const;
export type CoseAlg = (typeof COSE_ALGS)[keyof typeof COSE_ALGS];

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;
const FLAG_ED = 0x80;
/** Bits the spec reserves (RFU1, RFU2): zero. */
const FLAGS_RESERVED = 0x02 | 0x20;
/** A credential id's length (WebAuthn: 1 to 1023 bytes). */
const MAX_CREDENTIAL_ID = 1023;

export class WebAuthnError extends Error {}

const fail = (message: string): never => {
  throw new WebAuthnError(message);
};

// ---- encodings --------------------------------------------------------------

export function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecode(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) fail("not base64url");
  let binary: string;
  try {
    binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return fail("not base64url");
  }
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

const sha256 = async (bytes: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * A CBOR item (RFC 8949) from `bytes` at `at`: unsigned and negative
 * integers, byte and text strings, arrays, maps and simple values; no
 * indefinite lengths, tags or floats (WebAuthn's structures use none).
 */
export function decodeCbor(bytes: Uint8Array, at = 0, depth = 0): { value: unknown; next: number } {
  try {
    return decodeItem(bytes, at, depth);
  } catch (error) {
    // Any malformed input (a length past the end, text that is not UTF-8) is the caller's to refuse.
    if (error instanceof WebAuthnError) throw error;
    throw new WebAuthnError("the CBOR is malformed");
  }
}

function decodeItem(
  bytes: Uint8Array,
  at: number,
  depth: number,
): { value: unknown; next: number } {
  if (depth > 16) fail("CBOR nested too deeply");
  const head = bytes[at];
  if (head === undefined) fail("CBOR ends early");
  const major = (head as number) >> 5;
  const info = (head as number) & 0x1f;
  let length: number;
  let pos = at + 1;
  if (info < 24) length = info;
  else if (info === 24) length = bytes[pos++] ?? fail("CBOR ends early");
  else if (info === 25) {
    if (pos + 2 > bytes.length) fail("CBOR ends early");
    length = ((bytes[pos] ?? 0) << 8) | (bytes[pos + 1] ?? 0);
    pos += 2;
  } else if (info === 26) {
    if (pos + 4 > bytes.length) fail("CBOR ends early");
    length = new DataView(bytes.buffer, bytes.byteOffset + pos, 4).getUint32(0);
    pos += 4;
  } else return fail("unsupported CBOR length");
  if (pos > bytes.length) fail("CBOR ends early");
  switch (major) {
    case 0:
      return { value: length, next: pos };
    case 1:
      return { value: -1 - length, next: pos };
    case 2:
    case 3: {
      if (pos + length > bytes.length) fail("CBOR ends early");
      const slice = bytes.slice(pos, pos + length);
      return {
        value:
          major === 2
            ? slice
            : new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(slice),
        next: pos + length,
      };
    }
    case 4: {
      const items: unknown[] = [];
      let next = pos;
      for (let i = 0; i < length; i++) {
        const item = decodeItem(bytes, next, depth + 1);
        items.push(item.value);
        next = item.next;
      }
      return { value: items, next };
    }
    case 5: {
      const map = new Map<unknown, unknown>();
      let next = pos;
      for (let i = 0; i < length; i++) {
        const key = decodeItem(bytes, next, depth + 1);
        const value = decodeItem(bytes, key.next, depth + 1);
        if (map.has(key.value)) fail("CBOR map key repeated");
        map.set(key.value, value.value);
        next = value.next;
      }
      return { value: map, next };
    }
    case 7:
      if (info === 20) return { value: false, next: pos };
      if (info === 21) return { value: true, next: pos };
      if (info === 22) return { value: null, next: pos };
      return fail("unsupported CBOR simple value");
    default:
      return fail("unsupported CBOR item");
  }
}

// ---- keys -------------------------------------------------------------------

/** A COSE public key (RFC 9053) as a JWK, with its algorithm. */
export function coseToJwk(cose: unknown): { jwk: JsonWebKey; alg: CoseAlg } {
  if (!(cose instanceof Map)) return fail("the public key is not a COSE key");
  const kty = cose.get(1);
  const alg = cose.get(3);
  // A field of the length its key type has (an RSA modulus of 2048 to 4096 bits).
  const bytes = (label: number, min: number, max = min) => {
    const value = cose.get(label);
    if (!(value instanceof Uint8Array)) return fail("the COSE key is incomplete");
    if (value.length < min || value.length > max) return fail("the COSE key is malformed");
    return base64urlEncode(value);
  };
  if (alg === COSE_ALGS.ES256 && kty === 2 && cose.get(-1) === 1)
    return { jwk: { kty: "EC", crv: "P-256", x: bytes(-2, 32), y: bytes(-3, 32) }, alg };
  if (alg === COSE_ALGS.EdDSA && kty === 1 && cose.get(-1) === 6)
    return { jwk: { kty: "OKP", crv: "Ed25519", x: bytes(-2, 32) }, alg };
  if (alg === COSE_ALGS.RS256 && kty === 3)
    return { jwk: { kty: "RSA", n: bytes(-1, 256, 512), e: bytes(-2, 1, 8) }, alg };
  return fail("the key's algorithm is not supported (ES256, EdDSA, RS256)");
}

const ALGORITHMS: Record<
  CoseAlg,
  {
    importKey: Parameters<SubtleCrypto["importKey"]>[2];
    verify: Parameters<SubtleCrypto["verify"]>[0];
  }
> = {
  [COSE_ALGS.ES256]: {
    importKey: { name: "ECDSA", namedCurve: "P-256" },
    verify: { name: "ECDSA", hash: "SHA-256" },
  },
  [COSE_ALGS.EdDSA]: { importKey: { name: "Ed25519" }, verify: { name: "Ed25519" } },
  [COSE_ALGS.RS256]: {
    importKey: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    verify: { name: "RSASSA-PKCS1-v1_5" },
  },
};

/** The key to verify with; one WebCrypto refuses (no point on the curve, say) is refused as such. */
export async function importPublicKey(jwk: JsonWebKey, alg: CoseAlg): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey("jwk", jwk, ALGORITHMS[alg].importKey, false, ["verify"]);
  } catch {
    return fail("the public key is not a valid key");
  }
}

/** An ECDSA signature as WebAuthn sends it (DER) in WebCrypto's form (r and s, 32 bytes each). */
function derToRaw(der: Uint8Array): Uint8Array {
  const read = (at: number): { value: Uint8Array; next: number } => {
    if (der[at] !== 0x02) fail("the signature is not DER");
    const length = der[at + 1] ?? 0;
    let value = der.slice(at + 2, at + 2 + length);
    while (value.length > 32 && value[0] === 0) value = value.slice(1);
    if (value.length > 32) fail("the signature is not P-256");
    const padded = new Uint8Array(32);
    padded.set(value, 32 - value.length);
    return { value: padded, next: at + 2 + length };
  };
  if (der[0] !== 0x30) fail("the signature is not DER");
  const r = read(2);
  const s = read(r.next);
  const raw = new Uint8Array(64);
  raw.set(r.value, 0);
  raw.set(s.value, 32);
  return raw;
}

// ---- ceremonies -------------------------------------------------------------

export interface Expected {
  readonly challenge: string;
  readonly origin: string;
  readonly rpId: string;
}

interface AuthData {
  readonly flags: number;
  readonly signCount: number;
  readonly credential?: { readonly id: Uint8Array; readonly publicKey: unknown };
}

/**
 * Authenticator data for `ceremony`: this site's, with the user present and
 * verified, no reserved bit, a backup state only on a backup-eligible
 * credential, attested credential data on a registration only, and
 * extension data (when flagged) consumed exactly: nothing else after.
 */
async function parseAuthData(
  data: Uint8Array,
  rpId: string,
  ceremony: "create" | "get",
): Promise<AuthData> {
  if (data.length < 37) fail("the authenticator data is too short");
  if (!equalBytes(data.slice(0, 32), await sha256(new TextEncoder().encode(rpId))))
    fail("the authenticator data is for another site");
  const flags = data[32] as number;
  if (!(flags & FLAG_UP) || !(flags & FLAG_UV))
    fail("the user was not present and verified on the authenticator");
  if (flags & FLAGS_RESERVED) fail("the authenticator data sets a reserved flag");
  if (flags & FLAG_BS && !(flags & FLAG_BE)) fail("a backed-up credential must be backup-eligible");
  if (Boolean(flags & FLAG_AT) !== (ceremony === "create"))
    fail("attested credential data belongs to a registration only");
  const signCount = new DataView(data.buffer, data.byteOffset + 33, 4).getUint32(0);
  let at = 37;
  let credential: AuthData["credential"];
  if (flags & FLAG_AT) {
    if (data.length < 55) fail("the attested credential data is too short");
    const idLength = ((data[53] as number) << 8) | (data[54] as number);
    if (idLength < 1 || idLength > MAX_CREDENTIAL_ID)
      fail("the credential id's length is not allowed");
    const id = data.slice(55, 55 + idLength);
    if (id.length !== idLength) fail("the credential id is cut short");
    const key = decodeCbor(data, 55 + idLength);
    credential = { id, publicKey: key.value };
    at = key.next;
  }
  if (flags & FLAG_ED) {
    const extensions = decodeCbor(data, at);
    if (!(extensions.value instanceof Map)) fail("the extension data is not a map");
    at = extensions.next;
  }
  if (at !== data.length) fail("the authenticator data has bytes past its end");
  return credential ? { flags, signCount, credential } : { flags, signCount };
}

function checkClientData(clientDataJSON: Uint8Array, type: string, expected: Expected): void {
  let data: unknown;
  try {
    data = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(clientDataJSON),
    );
  } catch {
    throw new WebAuthnError("the client data is not JSON");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data))
    fail("the client data is not a JSON object");
  const { type: kind, challenge, origin, crossOrigin } = data as Record<string, unknown>;
  if (kind !== type) fail(`the client data is not a ${type}`);
  if (challenge !== expected.challenge) fail("the challenge is not the one issued");
  if (origin !== expected.origin) fail("the ceremony ran on another origin");
  if (crossOrigin === true) fail("the ceremony ran in a cross-origin frame");
}

/** A registration (navigator.credentials.create): the new credential's id, key and counter. */
export async function verifyRegistration(
  response: {
    readonly clientDataJSON: string;
    readonly attestationObject: string;
    readonly rawId: string;
  },
  expected: Expected,
): Promise<{ id: string; jwk: JsonWebKey; alg: CoseAlg; signCount: number }> {
  checkClientData(base64urlDecode(response.clientDataJSON), "webauthn.create", expected);
  const attestation = decodeCbor(base64urlDecode(response.attestationObject)).value;
  if (!(attestation instanceof Map)) return fail("the attestation is not a CBOR map");
  if (attestation.get("fmt") !== "none") fail("only attestation format none is taken");
  const authData = attestation.get("authData");
  if (!(authData instanceof Uint8Array)) return fail("the attestation has no authenticator data");
  const parsed = await parseAuthData(authData, expected.rpId, "create");
  if (!parsed.credential) return fail("the authenticator data names no credential");
  const id = base64urlEncode(parsed.credential.id);
  if (id !== response.rawId) fail("the credential id differs from the one returned");
  const { jwk, alg } = coseToJwk(parsed.credential.publicKey);
  // The key must import: a malformed one is refused now, not at sign-in.
  await importPublicKey(jwk, alg);
  return { id, jwk, alg, signCount: parsed.signCount };
}

/** A sign-in (navigator.credentials.get) with a stored credential: its new counter. */
export async function verifyAssertion(
  response: {
    readonly clientDataJSON: string;
    readonly authenticatorData: string;
    readonly signature: string;
  },
  credential: { readonly jwk: JsonWebKey; readonly alg: CoseAlg; readonly signCount: number },
  expected: Expected,
): Promise<{ signCount: number }> {
  const clientDataJSON = base64urlDecode(response.clientDataJSON);
  checkClientData(clientDataJSON, "webauthn.get", expected);
  const authData = base64urlDecode(response.authenticatorData);
  const parsed = await parseAuthData(authData, expected.rpId, "get");
  const signed = new Uint8Array(authData.length + 32);
  signed.set(authData, 0);
  signed.set(await sha256(clientDataJSON), authData.length);
  const algorithm = ALGORITHMS[credential.alg];
  const key = await importPublicKey(credential.jwk, credential.alg);
  let signature = base64urlDecode(response.signature);
  if (credential.alg === COSE_ALGS.ES256) signature = derToRaw(signature);
  if (!(await crypto.subtle.verify(algorithm.verify, key, signature, signed)))
    fail("the signature does not verify");
  // A counter that does not move forward means a copy of the authenticator (when it counts).
  if (
    (parsed.signCount > 0 || credential.signCount > 0) &&
    parsed.signCount <= credential.signCount
  )
    fail("the authenticator's counter went backwards");
  return { signCount: parsed.signCount };
}
