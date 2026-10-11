import { afterEach, describe, expect, it, vi } from "vitest";
import { oidFromHex } from "../../src/object/oid.js";
import { parseTag } from "../../src/object/tag.js";
import { PushFsck } from "../../src/receive-pack/fsck.js";
import { isValidRefname } from "../../src/refs/refname.js";

/*
 * A tag name is attacker-sized: a push can carry a tag object whose name is
 * tens of MiB of one repeated byte, which compresses to almost nothing. The
 * name is checked as bytes, never spread into an ordinary array or turned
 * into a string, and a finding quotes only a short excerpt of it.
 */

afterEach(() => vi.restoreAllMocks());

const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const HEAD = latin1(`object ${"4".repeat(40)}\ntype commit\ntag `);
const TAIL = latin1("\ntagger T <t@x> 1 +0000\n\nmsg\n");

function tagWithName(name: Uint8Array): Uint8Array {
  const body = new Uint8Array(HEAD.length + name.length + TAIL.length);
  body.set(HEAD);
  body.set(name, HEAD.length);
  body.set(TAIL, HEAD.length + name.length);
  return body;
}

/** Counts typed-array iterations over more than `bytes` elements (spreads, for-of, Array.from). */
function spyLargeIterations(bytes: number): () => number {
  const proto = Object.getPrototypeOf(Uint8Array.prototype) as Iterable<number> & {
    length: number;
  };
  const original = proto[Symbol.iterator];
  let large = 0;
  vi.spyOn(proto, Symbol.iterator).mockImplementation(function (this: Uint8Array) {
    if (this.length > bytes) large++;
    return original.call(this);
  });
  return () => large;
}

describe("parseTag with a long name", () => {
  const MiB = 1024 * 1024;

  it("checks a 2 MiB name without iterating it into an array", () => {
    const name = new Uint8Array(2 * MiB).fill(0x61);
    const body = tagWithName(name);
    const large = spyLargeIterations(64 * 1024);
    const parsed = parseTag(body);
    expect(large()).toBe(0);
    expect(parsed.issues).toEqual([]);
    expect(parsed.value.name).toEqual(name);
  });

  it("quotes a short excerpt of an invalid long name in the push warning", () => {
    const name = new Uint8Array(2 * MiB).fill(0x61);
    name[name.length - 1] = 0x2e; // a trailing '.' is not allowed
    const fsck = new PushFsck();
    const large = spyLargeIterations(64 * 1024);
    fsck.check(oidFromHex("5".repeat(40)), "tag", tagWithName(name));
    expect(large()).toBe(0);
    expect(fsck.warnings.map((f) => f.id)).toEqual(["badTagName"]);
    expect(fsck.warnings[0]?.message.length).toBeLessThan(400);
  });

  it.each(["@", "a.", ".a", "a/b", "a//b", "a@{b", "x.lock", "a..b", "v1.0", "é", "@x"])(
    "agrees with the prefixed ref name check for %j",
    (text) => {
      const name = latin1(text);
      const full = new Uint8Array([...latin1("refs/tags/"), ...name]);
      expect(parseTag(tagWithName(name)).issues.map((i) => i.id)).toEqual(
        isValidRefname(full) ? [] : ["badTagName"],
      );
    },
  );
});
