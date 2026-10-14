import type { RandomBytes } from "./principals/token.js";

/**
 * Prefixed ULIDs: `<prefix>_<26 Crockford base32 chars>`. The first 10
 * characters encode the creation time in milliseconds, so ids sort by time.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_TIME = 2 ** 48 - 1;

export type Clock = () => number;

export function ulid(now: number, randomBytes: RandomBytes): string {
  if (!Number.isInteger(now) || now < 0 || now > MAX_TIME)
    throw new RangeError(`invalid ULID time ${now}`);
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  // 80 random bits = 16 characters of 5 bits each, taken from 10 bytes.
  const bytes = randomBytes(10);
  let random = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      random += CROCKFORD.charAt((buffer >> bits) & 31);
    }
    buffer &= (1 << bits) - 1;
  }
  return time + random;
}

export const ID_PREFIXES = [
  "usr",
  "org",
  "agt",
  "ins",
  "tok",
  "rep",
  "net",
  "key",
  "trf",
  "grt",
  "cli",
  "ses",
] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

export type IdFactory = (prefix: IdPrefix) => string;

export function createIdFactory(clock: Clock, randomBytes: RandomBytes): IdFactory {
  return (prefix) => `${prefix}_${ulid(clock(), randomBytes)}`;
}

const ID_PATTERN = new RegExp(`^(${ID_PREFIXES.join("|")})_[${CROCKFORD}]{26}$`);

export function isId(value: string, prefix?: IdPrefix): boolean {
  return ID_PATTERN.test(value) && (prefix === undefined || value.startsWith(`${prefix}_`));
}
