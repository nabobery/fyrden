import { afterEach, describe, expect, it } from "vitest";
import { parseCommit } from "../../src/object/commit.js";
import { parseTag } from "../../src/object/tag.js";

/*
 * A commit or tag of about 2 MiB (under the object cap, and tiny once
 * compressed) can carry a million header lines. Parsing it on the push
 * path must not allocate per line: the extra headers are read only when a
 * caller asks for them, and then each header's value is built in one copy.
 * Allocations are counted by wrapping `subarray` and `Uint8Array.of`, which
 * per-line parsing used for every line.
 */

const TWO_MIB = 2 * 1024 * 1024;
const enc = (s: string) => new TextEncoder().encode(s);
const IDENT = "A <a@b.c> 1700000000 +0000";
const TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

let restore: (() => void) | undefined;
afterEach(() => restore?.());

/** Counts typed-array views and `Uint8Array.of` arrays made while it is installed. */
function countArrays(): { readonly count: () => number } {
  let count = 0;
  const proto = Uint8Array.prototype;
  const subarray = proto.subarray;
  const of = Uint8Array.of;
  proto.subarray = function (this: Uint8Array, ...args: [number?, number?]) {
    count++;
    return subarray.apply(this, args);
  } as typeof proto.subarray;
  Uint8Array.of = ((...items: number[]) => {
    count++;
    return of.apply(Uint8Array, items);
  }) as typeof Uint8Array.of;
  restore = () => {
    proto.subarray = subarray;
    Uint8Array.of = of;
    restore = undefined;
  };
  return { count: () => count };
}

/** How many times `line` fits after `head` in about 2 MiB. */
const fit = (head: string, line: string) => Math.floor((TWO_MIB - head.length) / line.length);

/** `head` then `line` repeated to about 2 MiB, then a message. */
function big(head: string, line: string): Uint8Array {
  return enc(`${head}${line.repeat(fit(head, line))}\nmessage\n`);
}

describe("header parsing allocations", () => {
  const head = `tree ${TREE}\nauthor ${IDENT}\ncommitter ${IDENT}\nx-big first\n`;
  const continuation = big(head, " c\n");
  const tiny = big(`tree ${TREE}\nauthor ${IDENT}\ncommitter ${IDENT}\n`, "k\n");

  it("a commit with a million continuation lines parses with a bounded number of arrays", () => {
    expect(continuation.length).toBeGreaterThan(TWO_MIB - 16);
    const counter = countArrays();
    const commit = parseCommit(continuation).value;
    expect(commit.parents).toEqual([]);
    expect(counter.count()).toBeLessThan(64);
    // Asked for, the header is still built in one pass, not per line.
    const [header] = commit.headers;
    expect(header?.key).toBe("x-big");
    // "first", then LF and "c" for each continuation line.
    expect(header?.value.length).toBe("first".length + 2 * fit(head, " c\n"));
    expect(counter.count()).toBeLessThan(64);
  });

  it("a commit or tag with a million tiny headers parses with a bounded number of arrays", () => {
    const counter = countArrays();
    parseCommit(tiny);
    parseTag(big(`object ${TREE}\ntype tree\ntag t\ntagger ${IDENT}\n`, "k\n"));
    expect(counter.count()).toBeLessThan(64);
  });
});
