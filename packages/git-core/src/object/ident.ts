import { concatBytes, copyBytes, latin1, latin1Bytes } from "./bytes.js";
import { type FsckMessageId, GitObjectError } from "./fsck.js";

/** An author, committer or tagger line: `Name <email> 1700000000 +0100`. */
export interface Ident {
  /** Raw bytes, without the whitespace before `<`. */
  readonly name: Uint8Array;
  readonly email: Uint8Array;
  /**
   * Seconds since the epoch. Git allows up to 2^63 - 1; above 2^53 this
   * number is rounded, which is fine for ordering. Parsed objects are never
   * re-encoded, so the rounding cannot change an object id.
   */
  readonly timestamp: number;
  /** `+hhmm` or `-hhmm`. */
  readonly timezone: string;
}

const LT = 0x3c;
const GT = 0x3e;
const SPACE = 0x20;
const TAB = 0x09;
const LF = 0x0a;
const MAX_DATE = 2n ** 63n - 1n;

const isDigit = (b: number | undefined) => b !== undefined && b >= 0x30 && b <= 0x39;
const isSpace = (b: number) => b === SPACE || (b >= 0x09 && b <= 0x0d);

/**
 * Parses the ident that starts at `start` and ends at the newline at `end`,
 * with the checks of git's `fsck_ident` in its order. Throws the first error.
 */
export function parseIdent(b: Uint8Array, start: number, end: number): Ident {
  const fail = (id: FsckMessageId, what: string) =>
    new GitObjectError(id, `invalid author/committer line - ${what}`);
  let p = start;
  if (b[p] === LT) throw fail("missingNameBeforeEmail", "missing space before email");
  for (;;) {
    if (p >= end) throw fail("missingEmail", "missing email");
    if (b[p] === GT) throw fail("badName", "bad name");
    if (b[p] === LT) break;
    p++;
  }
  if (b[p - 1] !== SPACE) throw fail("missingSpaceBeforeEmail", "missing space before email");
  const emailStart = ++p;
  for (;;) {
    if (p >= end || b[p] === LT) throw fail("badEmail", "bad email");
    if (b[p] === GT) break;
    p++;
  }
  const emailEnd = p++;
  if (b[p] !== SPACE) throw fail("missingSpaceBeforeDate", "missing space before date");
  p++;
  while (b[p] === SPACE || b[p] === TAB) p++;
  if (!isDigit(b[p])) throw fail("badDate", "bad date");
  if (b[p] === 0x30 && b[p + 1] !== SPACE) throw fail("zeroPaddedDate", "zero-padded date");
  const dateStart = p;
  while (p < end && isDigit(b[p])) p++;
  const digits = latin1(b.subarray(dateStart, p));
  // git reads at most 23 digits and treats more as overflowing.
  if (digits.length > 23 || BigInt(digits) > MAX_DATE) {
    throw fail("badDateOverflow", "date causes integer overflow");
  }
  if (b[p] !== SPACE) throw fail("badDate", "bad date");
  p++;
  const sign = b[p];
  if (
    (sign !== 0x2b && sign !== 0x2d) ||
    !isDigit(b[p + 1]) ||
    !isDigit(b[p + 2]) ||
    !isDigit(b[p + 3]) ||
    !isDigit(b[p + 4]) ||
    p + 5 !== end
  ) {
    throw fail("badTimezone", "bad time zone");
  }
  let nameEnd = emailStart - 1;
  while (nameEnd > start && isSpace(b[nameEnd - 1] as number)) nameEnd--;
  return {
    name: copyBytes(b, start, nameEnd),
    email: copyBytes(b, emailStart, emailEnd),
    timestamp: Number(digits),
    timezone: latin1(b.subarray(p, end)),
  };
}

/** `Name <email> seconds zone`, refusing anything that would not parse back unchanged. */
export function encodeIdent(ident: Ident): Uint8Array<ArrayBuffer> {
  const { name, email, timestamp, timezone } = ident;
  const forbidden = (bytes: Uint8Array) =>
    bytes.some((x) => x === LT || x === GT || x === LF || x === 0);
  if (forbidden(name) || (name.length > 0 && isSpace(name[name.length - 1] as number))) {
    throw new RangeError("an ident name cannot contain '<', '>', LF or NUL, or end in whitespace");
  }
  if (forbidden(email)) throw new RangeError("an ident email cannot contain '<', '>', LF or NUL");
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new RangeError("an ident timestamp must be a whole number of seconds, 0 or more");
  }
  if (!/^[+-]\d{4}$/.test(timezone))
    throw new RangeError("an ident time zone must be +hhmm or -hhmm");
  return concatBytes([name, latin1Bytes(" <"), email, latin1Bytes(`> ${timestamp} ${timezone}`)]);
}
