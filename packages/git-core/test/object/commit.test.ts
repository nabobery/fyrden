import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Commit, encodeCommit, parseCommit } from "../../src/object/commit.js";
import { GitObjectError } from "../../src/object/fsck.js";
import { oidFromBytes, oidFromHex } from "../../src/object/oid.js";
import { headerArb, identArb, messageArb, oidArb } from "./arbitraries.js";

const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const utf8 = (s: string) => new TextEncoder().encode(s);
const TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const PARENT = "45b983be36b73c0788dc9cbcb76cbb80fc7bb057";
const ID = "A U Thor <author@example.com> 1700000000 +0100";

function commitText({
  tree = `tree ${TREE}\n`,
  parents = "",
  author = `author ${ID}\n`,
  committer = `committer ${ID}\n`,
  rest = "\nmessage\n",
} = {}): Uint8Array {
  return latin1(tree + parents + author + committer + rest);
}

function errorId(body: Uint8Array): string | undefined {
  try {
    parseCommit(body);
    return undefined;
  } catch (e) {
    expect(e).toBeInstanceOf(GitObjectError);
    return (e as GitObjectError).id;
  }
}

const commitArb: fc.Arbitrary<Commit> = fc.record({
  tree: oidArb,
  parents: fc.array(oidArb, { maxLength: 3 }),
  author: identArb,
  committer: identArb,
  headers: fc.array(headerArb, { maxLength: 3 }),
  message: messageArb,
});

describe("encodeCommit and parseCommit", () => {
  it("round-trip any commit", () => {
    fc.assert(
      fc.property(commitArb, (commit) => {
        const parsed = parseCommit(encodeCommit(commit));
        expect(parsed.value).toEqual(commit);
        const nul = commit.message.includes(0);
        expect(parsed.issues).toEqual(nul ? [{ id: "nulInCommit", severity: "warn" }] : []);
      }),
    );
  });

  it("encodes in git's layout", () => {
    const body = encodeCommit({
      tree: oidFromHex(TREE),
      parents: [oidFromHex(PARENT)],
      author: { name: utf8("A U Thor"), email: utf8("a@x"), timestamp: 1, timezone: "+0000" },
      committer: { name: utf8("C"), email: utf8("c@x"), timestamp: 2, timezone: "-0130" },
      headers: [{ key: "gpgsig", value: utf8("-----BEGIN\nline\n-----END") }],
      message: utf8("subject\n\nbody\n"),
    });
    expect(new TextDecoder().decode(body)).toBe(
      `tree ${TREE}\nparent ${PARENT}\nauthor A U Thor <a@x> 1 +0000\ncommitter C <c@x> 2 -0130\n` +
        "gpgsig -----BEGIN\n line\n -----END\n\nsubject\n\nbody\n",
    );
  });

  it("reads the fields git's parser reads", () => {
    const { value } = parseCommit(
      commitText({
        parents: `parent ${PARENT}\nparent ${TREE}\n`,
        author: "author Name  \t <e@x>   \t1700000000 -0800\n",
        rest: "encoding ISO-8859-1\nmergetag object x\n type commit\n\nmsg",
      }),
    );
    expect(value.parents.map((p) => Buffer.from(p).toString("hex"))).toEqual([PARENT, TREE]);
    // Trailing whitespace is not part of the name; extra blanks before the date are allowed.
    expect(value.author).toEqual({
      name: utf8("Name"),
      email: utf8("e@x"),
      timestamp: 1700000000,
      timezone: "-0800",
    });
    expect(value.headers).toEqual([
      { key: "encoding", value: utf8("ISO-8859-1") },
      { key: "mergetag", value: utf8("object x\ntype commit") },
    ]);
    expect(value.message).toEqual(utf8("msg"));
  });

  it("returns fields that do not share memory with a Buffer body", () => {
    const body = Buffer.from(commitText());
    const { value } = parseCommit(body);
    body.fill(0x7a);
    expect(value.author.name).toEqual(utf8("A U Thor"));
    expect(value.message).toEqual(utf8("message\n"));
  });

  it("accepts upper-case hex and a commit with headers but no message", () => {
    const { value } = parseCommit(commitText({ tree: `tree ${TREE.toUpperCase()}\n`, rest: "" }));
    expect(value.tree).toEqual(oidFromHex(TREE));
    expect(value.message).toEqual(new Uint8Array());
  });

  it("refuses to encode what would not parse back unchanged", () => {
    const ok = {
      tree: oidFromHex(TREE),
      parents: [],
      author: { name: utf8("a"), email: utf8("b"), timestamp: 1, timezone: "+0000" },
      committer: { name: utf8("a"), email: utf8("b"), timestamp: 1, timezone: "+0000" },
      headers: [],
      message: new Uint8Array(),
    };
    const bad = [
      { ...ok, author: { ...ok.author, name: utf8("a<b") } },
      { ...ok, author: { ...ok.author, name: utf8("a ") } },
      { ...ok, author: { ...ok.author, name: utf8("a\nb") } },
      { ...ok, author: { ...ok.author, email: utf8("b>") } },
      { ...ok, author: { ...ok.author, timestamp: -1 } },
      { ...ok, author: { ...ok.author, timestamp: 1.5 } },
      { ...ok, author: { ...ok.author, timezone: "+000" } },
      { ...ok, headers: [{ key: "a b", value: utf8("x") }] },
      { ...ok, headers: [{ key: "", value: utf8("x") }] },
      { ...ok, headers: [{ key: "k", value: new Uint8Array([0]) }] },
    ];
    for (const commit of bad) expect(() => encodeCommit(commit)).toThrow(RangeError);
  });
});

describe("parseCommit checks (git's fsck_commit and fsck_ident)", () => {
  it.each([
    ["an empty body", latin1(""), "unterminatedHeader"],
    ["a NUL in the headers", commitText({ committer: `committer ${ID}\0\n` }), "nulInHeader"],
    [
      "headers without a final newline",
      commitText({ committer: `committer ${ID}`, rest: "" }),
      "unterminatedHeader",
    ],
    ["no tree line", commitText({ tree: "" }), "missingTree"],
    ["a short tree id", commitText({ tree: `tree ${TREE.slice(1)}\n` }), "badTreeSha1"],
    ["text after the tree id", commitText({ tree: `tree ${TREE} \n` }), "badTreeSha1"],
    ["a bad parent id", commitText({ parents: `parent ${PARENT}x\n` }), "badParentSha1"],
    ["no author", commitText({ author: "" }), "missingAuthor"],
    ["two authors", commitText({ author: `author ${ID}\nauthor ${ID}\n` }), "multipleAuthors"],
    ["no committer", commitText({ committer: "" }), "missingCommitter"],
    ["a blank line before the author", commitText({ author: `\nauthor ${ID}\n` }), "missingAuthor"],
    [
      "a name starting with '<'",
      commitText({ author: "author <e> 1 +0000\n" }),
      "missingNameBeforeEmail",
    ],
    ["no email", commitText({ author: "author Name 1 +0000\n" }), "missingEmail"],
    ["a '>' in the name", commitText({ author: "author Na>me <e> 1 +0000\n" }), "badName"],
    [
      "no space before the email",
      commitText({ author: "author Name<e> 1 +0000\n" }),
      "missingSpaceBeforeEmail",
    ],
    ["a '<' in the email", commitText({ author: "author Name <e<x> 1 +0000\n" }), "badEmail"],
    ["an unterminated email", commitText({ author: "author Name <e 1 +0000\n" }), "badEmail"],
    [
      "no space before the date",
      commitText({ author: "author Name <e>1 +0000\n" }),
      "missingSpaceBeforeDate",
    ],
    ["no date", commitText({ author: "author Name <e> +0000\n" }), "badDate"],
    ["a zero-padded date", commitText({ author: "author Name <e> 01 +0000\n" }), "zeroPaddedDate"],
    [
      "a date of 2^63",
      commitText({ author: "author Name <e> 9223372036854775808 +0000\n" }),
      "badDateOverflow",
    ],
    [
      "a 30-digit date",
      commitText({ author: `author Name <e> ${"9".repeat(30)} +0000\n` }),
      "badDateOverflow",
    ],
    ["no space after the date", commitText({ author: "author Name <e> 1+0000\n" }), "badDate"],
    ["a short time zone", commitText({ author: "author Name <e> 1 +000\n" }), "badTimezone"],
    [
      "text after the time zone",
      commitText({ author: "author Name <e> 1 +0000 x\n" }),
      "badTimezone",
    ],
    ["a bad committer", commitText({ committer: "committer Name <e> 1 0000\n" }), "badTimezone"],
  ])("rejects %s", (_, body, id) => {
    expect(errorId(body)).toBe(id);
  });

  it("accepts a date of zero and the largest date that fits in 63 bits", () => {
    expect(errorId(commitText({ author: "author N <e> 0 +0000\n" }))).toBeUndefined();
    const max = parseCommit(commitText({ author: "author N <e> 9223372036854775807 +0000\n" }));
    // 2^63 - 1 is not a safe integer; it rounds to 2^63, which only affects ordering.
    expect(max.value.author.timestamp).toBe(2 ** 63);
  });

  it("warns about a NUL in the message, which git allows", () => {
    const parsed = parseCommit(commitText({ rest: "\nmsg\0more" }));
    expect(parsed.issues).toEqual([{ id: "nulInCommit", severity: "warn" }]);
  });

  it("ignores anything after the committer line, as git's fsck does", () => {
    const body = commitText({ rest: " continuation without a header\nweird\n\nmsg" });
    const { value } = parseCommit(body);
    expect(value.headers).toEqual([
      { key: "", value: utf8("continuation without a header") },
      { key: "weird", value: new Uint8Array() },
    ]);
  });

  it("never throws anything but GitObjectError on mutated commits", () => {
    const seed = encodeCommit({
      tree: oidFromHex(TREE),
      parents: [oidFromBytes(new Uint8Array(20).fill(1))],
      author: { name: utf8("a"), email: utf8("b"), timestamp: 5, timezone: "+0100" },
      committer: { name: utf8("c"), email: utf8("d"), timestamp: 6, timezone: "-0100" },
      headers: [{ key: "gpgsig", value: utf8("x\ny") }],
      message: utf8("m\n"),
    });
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { maxLength: 4 }),
        fc.nat(),
        (edits, cut) => {
          const body = seed.slice(0, seed.length - (cut % 8));
          for (const [at, byte] of edits) body[at % body.length] = byte;
          try {
            parseCommit(body);
          } catch (e) {
            expect(e).toBeInstanceOf(GitObjectError);
          }
        },
      ),
    );
  });
});
