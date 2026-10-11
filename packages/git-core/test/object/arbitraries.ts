import fc from "fast-check";
import type { Header } from "../../src/object/headers.js";
import type { Ident } from "../../src/object/ident.js";
import { type Oid, oidFromBytes } from "../../src/object/oid.js";

const isSpace = (b: number) => b === 0x20 || (b >= 0x09 && b <= 0x0d);

export const oidArb: fc.Arbitrary<Oid> = fc
  .uint8Array({ minLength: 20, maxLength: 20 })
  .map((b) => oidFromBytes(b));

/** Bytes that git's ident parser reads back unchanged: no '<', '>', LF or NUL. */
const identBytes = fc
  .uint8Array({ maxLength: 16 })
  .map((b) => b.filter((x) => x !== 0x3c && x !== 0x3e && x !== 0x0a && x !== 0));

export const identArb: fc.Arbitrary<Ident> = fc.record({
  // Trailing whitespace is not part of a name.
  name: identBytes.filter((b) => b.length === 0 || !isSpace(b[b.length - 1] as number)),
  email: identBytes,
  timestamp: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
  timezone: fc
    .tuple(fc.constantFrom("+", "-"), fc.integer({ min: 0, max: 9999 }))
    .map(([sign, n]) => `${sign}${String(n).padStart(4, "0")}`),
});

export const headerArb: fc.Arbitrary<Header> = fc.record({
  key: fc.stringMatching(/^[!-~]{1,12}$/),
  value: fc.uint8Array({ maxLength: 40 }).map((b) => b.filter((x) => x !== 0)),
});

export const messageArb = fc.uint8Array({ maxLength: 64 });
