import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { GitObjectError } from "../../src/object/fsck.js";
import { OBJECT_TYPES } from "../../src/object/object.js";
import { oidFromHex } from "../../src/object/oid.js";
import { encodeTag, parseTag, type Tag } from "../../src/object/tag.js";
import { isValidRefname } from "../../src/refs/refname.js";
import { headerArb, identArb, messageArb, oidArb } from "./arbitraries.js";

const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const utf8 = (s: string) => new TextEncoder().encode(s);
const OBJECT = "45b983be36b73c0788dc9cbcb76cbb80fc7bb057";
const ID = "T Agger <t@example.com> 1700000000 +0000";

function tagText({
  object = `object ${OBJECT}\n`,
  type = "type commit\n",
  tag = "tag v1.0\n",
  tagger = `tagger ${ID}\n`,
  rest = "\nrelease\n",
} = {}): Uint8Array {
  return latin1(object + type + tag + tagger + rest);
}

function errorId(body: Uint8Array): string | undefined {
  try {
    parseTag(body);
    return undefined;
  } catch (e) {
    expect(e).toBeInstanceOf(GitObjectError);
    return (e as GitObjectError).id;
  }
}

const tagArb: fc.Arbitrary<Tag> = fc.record({
  object: oidArb,
  type: fc.constantFrom(...OBJECT_TYPES),
  name: fc
    .uint8Array({ minLength: 1, maxLength: 16 })
    .map((b) => b.filter((x) => x !== 0x0a && x !== 0))
    .filter((b) => b.length > 0),
  tagger: fc.option(identArb, { nil: null }),
  // A "tagger" header would read back as the tagger line.
  headers: fc.array(
    headerArb.filter((h) => h.key !== "tagger"),
    { maxLength: 2 },
  ),
  message: messageArb,
});

describe("encodeTag and parseTag", () => {
  it("round-trip any tag", () => {
    fc.assert(
      fc.property(tagArb, (tag) => {
        const parsed = parseTag(encodeTag(tag));
        expect(parsed.value).toEqual(tag);
        const refname = new Uint8Array([...utf8("refs/tags/"), ...tag.name]);
        expect(parsed.issues.map((i) => i.id)).toEqual([
          ...(isValidRefname(refname) ? [] : ["badTagName"]),
          ...(tag.tagger ? [] : ["missingTaggerEntry"]),
        ]);
      }),
    );
  });

  it("encodes in git's layout, signature last", () => {
    const body = encodeTag({
      object: oidFromHex(OBJECT),
      type: "commit",
      name: utf8("v1.0"),
      tagger: { name: utf8("T"), email: utf8("t@x"), timestamp: 9, timezone: "+0000" },
      headers: [],
      message: utf8("release\n-----BEGIN PGP SIGNATURE-----\n"),
    });
    expect(new TextDecoder().decode(body)).toBe(
      `object ${OBJECT}\ntype commit\ntag v1.0\ntagger T <t@x> 9 +0000\n\nrelease\n-----BEGIN PGP SIGNATURE-----\n`,
    );
  });

  it("refuses a first header named tagger when there is no tagger line", () => {
    const tag: Tag = {
      object: oidFromHex(OBJECT),
      type: "tree",
      name: utf8("v"),
      tagger: null,
      headers: [{ key: "tagger", value: utf8("N <e> 1 +0000") }],
      message: new Uint8Array(),
    };
    expect(() => encodeTag(tag)).toThrow(RangeError);
    // Later, or with a tagger line, it is just a header.
    const tagger = { name: utf8("T"), email: utf8("t"), timestamp: 1, timezone: "+0000" };
    expect(parseTag(encodeTag({ ...tag, tagger })).value.headers).toEqual(tag.headers);
  });

  it("refuses to encode an empty name or one with LF", () => {
    const tag: Tag = {
      object: oidFromHex(OBJECT),
      type: "blob",
      name: utf8("v"),
      tagger: null,
      headers: [],
      message: new Uint8Array(),
    };
    expect(() => encodeTag({ ...tag, name: new Uint8Array() })).toThrow(RangeError);
    expect(() => encodeTag({ ...tag, name: utf8("a\nb") })).toThrow(RangeError);
  });
});

describe("parseTag checks (git's fsck_tag_standalone)", () => {
  it.each([
    ["an empty body", latin1(""), "unterminatedHeader"],
    ["no object line", tagText({ object: "" }), "missingObject"],
    ["a bad object id", tagText({ object: `object ${OBJECT.slice(2)}\n` }), "badObjectSha1"],
    ["no type line", tagText({ type: "" }), "missingTypeEntry"],
    ["an unknown type", tagText({ type: "type commits\n" }), "badType"],
    ["an empty type", tagText({ type: "type \n" }), "badType"],
    ["no tag line", tagText({ tag: "" }), "missingTagEntry"],
    ["a bad tagger", tagText({ tagger: "tagger Name <e> 1 +00\n" }), "badTimezone"],
    ["a NUL in the headers", tagText({ tag: "tag v\0\n" }), "nulInHeader"],
  ])("rejects %s", (_, body, id) => {
    expect(errorId(body)).toBe(id);
  });

  it("reports a name that is not a valid ref name (badTagName, info)", () => {
    const parsed = parseTag(tagText({ tag: "tag v1..0\n" }));
    expect(parsed.issues).toEqual([{ id: "badTagName", severity: "info" }]);
  });

  it("allows the early tags that have no tagger (missingTaggerEntry, info)", () => {
    const parsed = parseTag(tagText({ tagger: "" }));
    expect(parsed.value.tagger).toBeNull();
    expect(parsed.issues).toEqual([{ id: "missingTaggerEntry", severity: "info" }]);
  });

  it("reads gpgsig and unknown headers after the tagger, which git ignores", () => {
    const { value } = parseTag(
      tagText({ rest: "gpgsig-sha256 -----BEGIN\n sig\n -----END\nx-extra y\n\nmsg" }),
    );
    expect(value.headers).toEqual([
      { key: "gpgsig-sha256", value: utf8("-----BEGIN\nsig\n-----END") },
      { key: "x-extra", value: utf8("y") },
    ]);
    expect(value.message).toEqual(utf8("msg"));
    expect(value.name).toEqual(utf8("v1.0"));
    expect(value.type).toBe("commit");
  });

  it("never throws anything but GitObjectError on mutated tags", () => {
    const seed = tagText({ rest: "gpgsig a\n b\n\nmsg\n" });
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { maxLength: 4 }),
        fc.nat(),
        (edits, cut) => {
          const body = seed.slice(0, seed.length - (cut % 8));
          for (const [at, byte] of edits) body[at % body.length] = byte;
          try {
            parseTag(body);
          } catch (e) {
            expect(e).toBeInstanceOf(GitObjectError);
          }
        },
      ),
    );
  });
});
