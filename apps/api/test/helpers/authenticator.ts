// A virtual passkey authenticator: an ES256 key that answers WebAuthn
// registrations (attestation format none) and sign-ins as a browser
// would hand them to Fyrden.

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** CBOR (the subset WebAuthn uses): integers, byte and text strings, maps. */
function cbor(value: unknown): Uint8Array {
  const head = (major: number, n: number) =>
    n < 24
      ? Uint8Array.of((major << 5) | n)
      : n < 256
        ? Uint8Array.of((major << 5) | 24, n)
        : Uint8Array.of((major << 5) | 25, n >> 8, n & 0xff);
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (value instanceof Uint8Array) return concat(head(2, value.length), value);
  if (typeof value === "string") {
    const bytes = encoder.encode(value);
    return concat(head(3, bytes.length), bytes);
  }
  if (value instanceof Map)
    return concat(head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)]));
  throw new Error("unsupported");
}

/** WebCrypto's ECDSA signature (r and s) as WebAuthn sends it (DER). */
function rawToDer(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let v = bytes.slice(i);
    if ((v[0] as number) & 0x80) v = concat(Uint8Array.of(0), v);
    return concat(Uint8Array.of(0x02, v.length), v);
  };
  const body = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)));
  return concat(Uint8Array.of(0x30, body.length), body);
}

export interface Authenticator {
  readonly credentialId: string;
  /** The browser's answer to registration options (`publicKey`). */
  register(
    options: { challenge: string; rp: { id: string }; user: { id: string } },
    origin: string,
    tweak?: { flags?: number },
  ): Promise<unknown>;
  /** The browser's answer to sign-in options, for this credential. */
  signIn(
    options: { challenge: string; rpId: string },
    origin: string,
    tweak?: { counter?: number; userVerified?: boolean; flags?: number; userHandle?: string },
  ): Promise<unknown>;
}

export async function authenticator(): Promise<Authenticator> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const id = crypto.getRandomValues(new Uint8Array(16));
  const credentialId = base64url(id);
  let counter = 0;
  // The user handle the registration named, returned by every sign-in (a discoverable passkey's).
  let userHandle = "";
  const rpIdHash = async (rpId: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(rpId)));
  const counterBytes = (n: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n);
    return b;
  };
  return {
    credentialId,
    async register(options, origin, tweak = {}) {
      userHandle = options.user.id;
      const clientDataJSON = encoder.encode(
        JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin }),
      );
      const cose = new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, fromBase64url(jwk.x ?? "")],
        [-3, fromBase64url(jwk.y ?? "")],
      ]);
      const authData = concat(
        await rpIdHash(options.rp.id),
        Uint8Array.of(tweak.flags ?? 0x45),
        counterBytes(0),
        new Uint8Array(16),
        Uint8Array.of(0, id.length),
        id,
        cbor(cose),
      );
      const attestationObject = cbor(
        new Map<string, unknown>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authData],
        ]),
      );
      return {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        response: {
          clientDataJSON: base64url(clientDataJSON),
          attestationObject: base64url(attestationObject),
        },
      };
    },
    async signIn(options, origin, tweak = {}) {
      counter = tweak.counter ?? counter + 1;
      const clientDataJSON = encoder.encode(
        JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin }),
      );
      const authData = concat(
        await rpIdHash(options.rpId),
        Uint8Array.of(tweak.flags ?? (tweak.userVerified === false ? 0x01 : 0x05)),
        counterBytes(counter),
      );
      const signed = concat(
        authData,
        new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataJSON)),
      );
      const signature = new Uint8Array(
        await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, signed),
      );
      return {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        response: {
          clientDataJSON: base64url(clientDataJSON),
          authenticatorData: base64url(authData),
          signature: base64url(rawToDer(signature)),
          userHandle: tweak.userHandle ?? userHandle,
        },
      };
    },
  };
}
