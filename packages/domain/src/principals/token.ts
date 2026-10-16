/**
 * Fyrden token strings: `fyrden_<type>_<random><checksum>`.
 *
 * The random part is 30 base62 characters (~178 bits). The checksum is the
 * CRC32 of the prefix and random part, as 6 base62 characters, so secret
 * scanners can recognise a leaked token without a database lookup. Only the
 * SHA-256 of a token is ever stored.
 */

/**
 * `oat`: an access token issued by the authorization server (a token
 * exchange's delegated token, an OAuth client's); `ort`: its refresh
 * token; `ses`: a human's session (a cookie).
 */
export const TOKEN_TYPES = ["git", "pat", "ist", "run", "job", "oat", "ort", "ses"] as const;
export type TokenType = (typeof TOKEN_TYPES)[number];

export type ParsedToken =
  | { ok: true; type: TokenType }
  | { ok: false; reason: "malformed" | "bad_checksum" };

/** Fills a buffer of `n` bytes from a cryptographically secure source. */
export type RandomBytes = (n: number) => Uint8Array;

export const secureRandomBytes: RandomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const RANDOM_LENGTH = 30;
const CHECKSUM_LENGTH = 6;
// 248 = 62 * 4: bytes at or above it would bias the modulo, so they are dropped.
const UNBIASED_LIMIT = 248;
const MAX_DRAWS = 16;

// Every token pattern below is built from these, so a new token type or
// length is parsed, redacted and leak-checked alike.
const PREFIX_SOURCE = `fyrden_(${TOKEN_TYPES.join("|")})_`;
const BODY_SOURCE = `[0-9A-Za-z]{${RANDOM_LENGTH + CHECKSUM_LENGTH}}`;

const TOKEN_PATTERN = new RegExp(
  `^${PREFIX_SOURCE}([0-9A-Za-z]{${RANDOM_LENGTH}})([0-9A-Za-z]{${CHECKSUM_LENGTH}})$`,
);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function checksum(body: string): string {
  let value = crc32(new TextEncoder().encode(body));
  let out = "";
  for (let i = 0; i < CHECKSUM_LENGTH; i++) {
    out = BASE62.charAt(value % 62) + out;
    value = Math.floor(value / 62);
  }
  return out;
}

function randomBase62(length: number, randomBytes: RandomBytes): string {
  let out = "";
  for (let draw = 0; draw < MAX_DRAWS && out.length < length; draw++) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= UNBIASED_LIMIT) continue;
      out += BASE62.charAt(byte % 62);
      if (out.length === length) break;
    }
  }
  if (out.length < length) throw new Error("random source returned too few usable bytes");
  return out;
}

export function generateToken(type: TokenType, randomBytes: RandomBytes): string {
  const body = `fyrden_${type}_${randomBase62(RANDOM_LENGTH, randomBytes)}`;
  return body + checksum(body);
}

export function parseToken(token: string): ParsedToken {
  const match = TOKEN_PATTERN.exec(token);
  if (!match) return { ok: false, reason: "malformed" };
  const body = token.slice(0, token.length - CHECKSUM_LENGTH);
  if (checksum(body) !== match[3]) return { ok: false, reason: "bad_checksum" };
  return { ok: true, type: match[1] as TokenType };
}

/** Lowercase hex SHA-256, the only form in which tokens are stored. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// --- Detecting tokens in text (log redaction and leak checks) ---

/** A Fyrden token in plain text. */
export const TOKEN_IN_TEXT = new RegExp(PREFIX_SOURCE + BODY_SOURCE, "g");
const TOKEN_PREFIX = new RegExp(PREFIX_SOURCE);
/** A webhook signing secret in plain text (`whsec_` and its base64 bytes). */
export const WEBHOOK_SECRET_IN_TEXT = /whsec_[A-Za-z0-9+/]{16,}={0,2}/g;
const WEBHOOK_SECRET_PREFIX = /whsec_/;
/** Runs of base64 or base64url characters long enough to hide a token prefix. */
export const BASE64_RUN = /[A-Za-z0-9+/_-]{16,}={0,2}/g;

/**
 * Decodes ASCII percent-escapes and leaves everything else (including
 * malformed or non-ASCII escapes) as is, so one bad escape cannot stop the
 * rest of the text from being decoded.
 */
export function decodeAsciiPercent(text: string): string {
  return text.replace(/%([0-7][0-9A-Fa-f])/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function decodeBase64(text: string): string | undefined {
  const normalised = text.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return atob(normalised);
  } catch {
    return undefined;
  }
}

/**
 * True when a base64 or base64url run decodes, at any of the four possible
 * alignments, to text containing a token prefix. The run may carry other
 * characters before the encoded token (`trace_<base64>`) or after it
 * (`<base64>AA`), so each alignment decodes only whole 4-character groups.
 */
export function base64RunHasToken(run: string): boolean {
  // A loop, not /=+$/: that regex backtracks quadratically on a long run
  // of '=' that does not end the string. Today's callers pass runs with at
  // most two, but the function must stay linear for any caller.
  let end = run.length;
  while (end > 0 && run.charCodeAt(end - 1) === 0x3d) end--;
  const body = run.slice(0, end);
  for (let offset = 0; offset < 4 && offset < body.length; offset++) {
    const aligned = body.slice(offset);
    const decoded = decodeBase64(aligned.slice(0, aligned.length - (aligned.length % 4)));
    if (decoded && (TOKEN_PREFIX.test(decoded) || WEBHOOK_SECRET_PREFIX.test(decoded))) return true;
  }
  return false;
}

/** True when text contains a token or a webhook secret in plain, percent-encoded or base64 form. */
export function mentionsToken(text: string): boolean {
  const decoded = decodeAsciiPercent(text);
  if (new RegExp(TOKEN_IN_TEXT.source).test(decoded)) return true;
  if (new RegExp(WEBHOOK_SECRET_IN_TEXT.source).test(decoded)) return true;
  return (decoded.match(BASE64_RUN) ?? []).some(base64RunHasToken);
}
