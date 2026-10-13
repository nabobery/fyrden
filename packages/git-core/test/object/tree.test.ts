import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { GitObjectError } from "../../src/object/fsck.js";
import { type Oid, oidFromBytes, oidFromHex, zeroOid } from "../../src/object/oid.js";
import {
  encodeTree,
  FILE_MODES,
  parseTree,
  type TreeEntry,
  treeEntries,
} from "../../src/object/tree.js";

const utf8 = (s: string) => new TextEncoder().encode(s);
const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const OID = oidFromHex("45b983be36b73c0788dc9cbcb76cbb80fc7bb057");

/** One raw tree entry: mode text, name bytes, NUL, 20-byte oid. */
function rawEntry(mode: string, name: Uint8Array | string, oid: Oid = OID): Uint8Array {
  const n = typeof name === "string" ? utf8(name) : name;
  return new Uint8Array([...latin1(mode), 0x20, ...n, 0, ...oid]);
}
const rawTree = (...entries: Uint8Array[]) => new Uint8Array(entries.flatMap((e) => [...e]));
const issueIds = (body: Uint8Array) => parseTree(body).issues.map((i) => i.id);

const nameArb = fc
  .uint8Array({ minLength: 1, maxLength: 24 })
  .filter((n) => !n.includes(0) && !n.includes(0x2f));
const modeArb = fc.constantFrom(...Object.values(FILE_MODES));
const entryArb = fc.record({
  mode: modeArb,
  name: nameArb,
  oid: fc.uint8Array({ minLength: 20, maxLength: 20 }).map((b) => oidFromBytes(b)),
});

describe("encodeTree and parseTree", () => {
  it("round-trip any set of uniquely named entries, in git's order", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(entryArb, { selector: (e) => Buffer.from(e.name).toString("latin1") }),
        (entries) => {
          const parsed = parseTree(encodeTree(entries));
          expect(parsed.value).toHaveLength(entries.length);
          expect(new Set(parsed.value.map((e) => Buffer.from(e.name).toString("hex")))).toEqual(
            new Set(entries.map((e) => Buffer.from(e.name).toString("hex"))),
          );
          // Encoding sorts, so a parse never reports an ordering problem.
          const errors = parsed.issues.filter((i) => i.severity === "error");
          expect(errors).toEqual([]);
          expect(encodeTree(parsed.value)).toEqual(encodeTree(entries));
        },
      ),
    );
  });

  it("sorts a directory as if its name ended in '/'", () => {
    const entries: TreeEntry[] = [
      { mode: FILE_MODES.tree, name: utf8("a"), oid: OID },
      { mode: FILE_MODES.file, name: utf8("a.c"), oid: OID },
      { mode: FILE_MODES.file, name: utf8("a0"), oid: OID },
    ];
    const names = parseTree(encodeTree(entries)).value.map((e) => new TextDecoder().decode(e.name));
    expect(names).toEqual(["a.c", "a", "a0"]);
  });

  it("writes canonical mode text: 40000 for trees, never zero-padded", () => {
    const body = encodeTree([{ mode: FILE_MODES.tree, name: utf8("d"), oid: OID }]);
    expect(body).toEqual(rawEntry("40000", "d"));
  });

  it("refuses to encode duplicate names, a non-standard mode, or an unusable name", () => {
    const file = { mode: FILE_MODES.file, name: utf8("a"), oid: OID };
    expect(() => encodeTree([file, { ...file, mode: FILE_MODES.tree }])).toThrow(RangeError);
    expect(() => encodeTree([{ ...file, mode: 0o100664 }])).toThrow(RangeError);
    expect(() => encodeTree([{ ...file, name: new Uint8Array() }])).toThrow(RangeError);
    expect(() => encodeTree([{ ...file, name: utf8("a/b") }])).toThrow(RangeError);
    expect(() => encodeTree([{ ...file, name: new Uint8Array([0x61, 0]) }])).toThrow(RangeError);
  });

  it("returns names that do not share memory with a Buffer body", () => {
    const body = Buffer.from(rawEntry("100644", "abc"));
    const [entry] = parseTree(body).value;
    body.fill(0x7a);
    expect(entry?.name).toEqual(utf8("abc"));
    expect(entry?.oid).toEqual(OID);
  });

  it("parses the empty tree", () => {
    expect(parseTree(new Uint8Array())).toEqual({ value: [], issues: [] });
  });
});

describe("parseTree structure (git's decode_tree_entry: badTree)", () => {
  it.each([
    ["an empty mode", rawEntry("", "a")],
    ["a non-octal mode", rawEntry("10064x", "a")],
    ["an 8 in the mode", rawEntry("100648", "a")],
    ["an empty name", rawEntry("100644", "")],
    ["a truncated object id", rawEntry("100644", "a").subarray(0, 28)],
    ["no space after the mode", latin1("100644")],
    ["trailing bytes after the last entry", rawTree(rawEntry("100644", "a"), latin1("1"))],
    ["a missing NUL", rawTree(latin1("100644 a"), OID)],
  ])("rejects %s", (_, body) => {
    const error = (() => {
      try {
        parseTree(body);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(GitObjectError);
    expect((error as GitObjectError).id).toBe("badTree");
  });

  it("takes a name up to the first NUL, as git's strlen does", () => {
    // "a" NUL then 20 bytes, the first of which is not NUL: still one entry.
    const parsed = parseTree(rawEntry("100644", "a"));
    expect(parsed.value).toEqual([{ mode: 0o100644, name: utf8("a"), oid: OID }]);
  });
});

describe("parseTree checks (git's fsck_tree)", () => {
  it("reports nothing for a well-formed tree", () => {
    expect(
      issueIds(rawTree(rawEntry("100644", "a"), rawEntry("40000", "b"), rawEntry("160000", "c"))),
    ).toEqual([]);
  });

  it("flags zero-padded modes but reads them as their value", () => {
    const parsed = parseTree(rawEntry("040000", "d"));
    expect(parsed.value[0]?.mode).toBe(0o40000);
    expect(parsed.issues).toEqual([{ id: "zeroPaddedFilemode", severity: "warn" }]);
  });

  it("allows the historical 100664 mode and reports other modes as badFilemode (info)", () => {
    expect(issueIds(rawEntry("100664", "a"))).toEqual([]);
    expect(parseTree(rawEntry("100600", "a")).issues).toEqual([
      { id: "badFilemode", severity: "info" },
    ]);
  });

  it("truncates an over-long mode to 16 bits and reports nothing, as git does", () => {
    // 0o1100644 mod 2^16 is 0o100644: git reads a regular file.
    const parsed = parseTree(rawEntry("1100644", "a"));
    expect(parsed.value[0]?.mode).toBe(0o100644);
    expect(parsed.issues).toEqual([]);
  });

  it("finds unsorted entries", () => {
    expect(issueIds(rawTree(rawEntry("100644", "b"), rawEntry("100644", "a")))).toEqual([
      "treeNotSorted",
    ]);
    // A directory sorts as "a/", after "a.c".
    expect(issueIds(rawTree(rawEntry("40000", "a"), rawEntry("100644", "a.c")))).toEqual([
      "treeNotSorted",
    ]);
  });

  it("finds duplicates, including a file and directory of one name separated by other entries", () => {
    expect(issueIds(rawTree(rawEntry("100644", "a"), rawEntry("100644", "a")))).toEqual([
      "duplicateEntries",
    ]);
    expect(
      issueIds(
        rawTree(
          rawEntry("100644", "foo"),
          rawEntry("100644", "foo.bar"),
          rawEntry("100644", "foo.bar.baz"),
          rawEntry("40000", "foo.bar"),
          rawEntry("40000", "foo"),
        ),
      ),
    ).toEqual(["duplicateEntries"]);
  });

  it("reports a null object id, a '/' in a name, '.', '..' and over-long names", () => {
    expect(issueIds(rawEntry("100644", "a", zeroOid()))).toEqual(["nullSha1"]);
    expect(issueIds(rawEntry("100644", "a/b"))).toEqual(["fullPathname"]);
    expect(issueIds(rawEntry("40000", "."))).toEqual(["hasDot"]);
    expect(issueIds(rawEntry("40000", ".."))).toEqual(["hasDotdot"]);
    expect(issueIds(rawEntry("100644", "x".repeat(4097)))).toEqual(["largePathname"]);
    expect(issueIds(rawEntry("100644", "x".repeat(4096)))).toEqual([]);
  });

  it.each([
    ".git",
    ".GIT",
    ".Git",
    "git~1",
    "GIT~1",
    ".git.",
    ".git ",
    ".git. .",
    ".git:stream",
    "git~1:x",
    // HFS+ ignores these code points when comparing names.
    ".g‌it",
    "﻿.git",
    ".gi⁪t",
    // NTFS treats a backslash as a separator.
    "a\\.git",
    "a\\git~1\\b",
  ])("flags %j as .git (hasDotgit)", (name) => {
    expect(issueIds(rawEntry("40000", name))).toEqual(["hasDotgit"]);
  });

  it("flags .git followed by invalid UTF-8, which git's HFS check reads as the end", () => {
    expect(issueIds(rawEntry("40000", new Uint8Array([...utf8(".git"), 0xff])))).toEqual([
      "hasDotgit",
    ]);
  });

  it.each([".gitx", ".git~1", "git~2", "xgit", ".gitignore", "git", ".gi", "a\\b", ".gét"])(
    "does not flag %j",
    (name) => {
      expect(issueIds(rawEntry("40000", name))).toEqual([]);
    },
  );

  it("reports each finding once per tree, in git's order", () => {
    expect(
      issueIds(
        rawTree(
          rawEntry("040000", ".git"),
          rawEntry("100600", "a/b", zeroOid()),
          rawEntry("100644", "."),
        ),
      ),
    ).toEqual([
      "nullSha1",
      "fullPathname",
      "hasDot",
      "hasDotgit",
      "zeroPaddedFilemode",
      "badFilemode",
      "treeNotSorted",
    ]);
  });
});

describe("parseTree under mutation", () => {
  it("never throws anything but GitObjectError", () => {
    const seed = rawTree(
      rawEntry("100644", "a.c"),
      rawEntry("40000", "a"),
      rawEntry("120000", "z"),
    );
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { maxLength: 4 }),
        fc.nat(),
        (edits, cut) => {
          const body = seed.slice(0, seed.length - (cut % 30));
          for (const [at, byte] of edits) if (body.length > 0) body[at % body.length] = byte;
          try {
            parseTree(body);
          } catch (e) {
            expect(e).toBeInstanceOf(GitObjectError);
          }
        },
      ),
    );
  });
});

describe("treeEntries", () => {
  it("yields what parseTree returns, or throws where it throws, under mutation", () => {
    const seed = rawTree(
      rawEntry("100644", "a.c"),
      rawEntry("40000", "a"),
      rawEntry("120000", "z"),
      rawEntry("160000", "sub"),
    );
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { maxLength: 4 }),
        fc.nat(),
        (edits, cut) => {
          const body = seed.slice(0, seed.length - (cut % 40));
          for (const [at, byte] of edits) if (body.length > 0) body[at % body.length] = byte;
          let parsed: TreeEntry[] | GitObjectError;
          try {
            parsed = parseTree(body).value;
          } catch (e) {
            parsed = e as GitObjectError;
          }
          if (parsed instanceof GitObjectError) {
            expect(() => [...treeEntries(body)]).toThrow(GitObjectError);
            return;
          }
          const lazy = [...treeEntries(body)];
          expect(lazy.map((e) => [e.mode, [...e.name], [...e.oid]])).toEqual(
            parsed.map((e) => [e.mode, [...e.name], [...e.oid]]),
          );
        },
      ),
    );
  });

  it("reads entries one at a time, so a caller can stop early", () => {
    const body = rawTree(rawEntry("100644", "a"), rawEntry("100644", "b"));
    const first = treeEntries(body).next();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value?.name)).toBe("a");
  });
});
