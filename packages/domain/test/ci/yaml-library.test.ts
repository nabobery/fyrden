// The `yaml` library's behaviour that the workflow parser depends on, or
// works around, pinned so an upgrade that changes any of it fails here
// first. Each case names what the parser does with the fact.

import { describe, expect, it } from "vitest";
import {
  Composer,
  type Document,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  Parser,
  type Scalar,
} from "yaml";

/** The options the workflow parser composes with. */
const OPTIONS = {
  version: "1.2",
  uniqueKeys: false,
  resolveKnownTags: false,
  prettyErrors: false,
} as const;

/** Tokens, then one document per document token (at least one), as the parser composes them. */
function compose(text: string) {
  const lines = new LineCounter();
  const tokens = [...new Parser(lines.addNewLine).parse(text)];
  const docs: Document.Parsed[] = [...new Composer(OPTIONS).compose(tokens, true, text.length)];
  return { tokens, docs, lines };
}

function first(text: string): Document.Parsed {
  const doc = compose(text).docs[0];
  if (!doc) throw new Error("no document");
  return doc;
}

/** The value of the root mapping's entry `key`. */
function entryValue(doc: Document.Parsed, key: string) {
  if (!isMap(doc.contents)) throw new Error("root is not a mapping");
  const pair = doc.contents.items.find((p) => isScalar(p.key) && p.key.value === key);
  if (!pair) throw new Error(`no key ${key}`);
  return pair.value;
}

describe("the yaml library as the workflow parser uses it", () => {
  it("resolves YAML 1.2 core scalars: `on`, `yes` and `off` stay strings", () => {
    const doc = first("on: push\na: yes\nb: off\nc: true\nd: 0755\ne: 0x10\nf: 1.0\ng: ~\n");
    expect(doc.errors).toEqual([]);
    expect(doc.toJS()).toEqual({
      on: "push",
      a: "yes",
      b: "off",
      c: true,
      d: 755,
      e: 16,
      f: 1,
      g: null,
    });
  });

  it("keeps each scalar's source text, so env values can be passed on as written", () => {
    const doc = first("a: 1.0\nb: 0x10\nc: 'quoted'\n");
    expect((entryValue(doc, "a") as Scalar).source).toBe("1.0");
    expect((entryValue(doc, "b") as Scalar).source).toBe("0x10");
    expect((entryValue(doc, "c") as Scalar).source).toBe("quoted");
  });

  it("gives block and escaped scalars their decoded text as source, not the YAML slice", () => {
    const doc = first('a: |\n  hello\n  world\nb: >-\n  hello\n  world\nc: "x\\ny"\n');
    expect((entryValue(doc, "a") as Scalar).source).toBe("hello\nworld\n");
    expect((entryValue(doc, "b") as Scalar).source).toBe("hello world");
    expect((entryValue(doc, "c") as Scalar).source).toBe("x\ny");
  });

  it("rounds an unsafe integer, which the parser must refuse itself", () => {
    expect((entryValue(first("a: 9007199254740993\n"), "a") as Scalar).value).toBe(
      9007199254740992,
    );
  });

  it("reports no duplicate keys with uniqueKeys off, so the parser checks them itself", () => {
    const doc = first("a: 1\na: 2\n");
    expect([...doc.errors, ...doc.warnings]).toEqual([]);
    expect(isMap(doc.contents) && doc.contents.items.length).toBe(2);
  });

  it("treats `<<` as an ordinary key under 1.2 (merge off), so the parser names it", () => {
    const doc = first("a: &x {b: 1}\nc:\n  <<: *x\n");
    expect([...doc.errors, ...doc.warnings]).toEqual([]);
    const c = entryValue(doc, "c");
    expect(isMap(c) && isScalar(c.items[0]?.key) && c.items[0].key.value).toBe("<<");
  });

  it("leaves aliases unresolved and unchecked, so the parser resolves and bounds them", () => {
    // A cycle, a forward reference and a missing anchor all compose without a diagnostic.
    for (const text of ["a: &a [*a, *a]\n", "a: *b\nb: &b 1\n", "a: *missing\n"]) {
      const doc = first(text);
      expect([...doc.errors, ...doc.warnings]).toEqual([]);
    }
    const a = entryValue(first("a: *missing\n"), "a");
    expect(isAlias(a) && a.source).toBe("missing");
  });

  it("does not count aliases while composing (maxAliasCount applies only to toJS)", () => {
    const text = `a: &x 1\nb: [${Array(150).fill("*x").join(", ")}]\n`;
    const doc = first(text);
    expect([...doc.errors, ...doc.warnings]).toEqual([]);
    expect(() => doc.toJS()).toThrow(ReferenceError);
  });

  it("lets a %YAML 1.1 directive override the version, so directive tokens are checked raw", () => {
    const doc = first("%YAML 1.1\n---\non: push\n");
    expect([...doc.errors, ...doc.warnings]).toEqual([]);
    expect(doc.toJS()).toEqual({ true: "push" });
  });

  it("hides some directives from the composed document; the tokens keep every one", () => {
    const text = "%YAML 1.1\n%YAML 1.2\n%TAG !! tag:yaml.org,2002:\n---\non: push\n";
    const { tokens, docs } = compose(text);
    expect(docs[0]?.directives?.yaml.version).toBe("1.2");
    const directives = tokens.flatMap((t) =>
      t.type === "directive" ? [{ offset: t.offset, source: t.source }] : [],
    );
    expect(directives).toEqual([
      { offset: 0, source: "%YAML 1.1" },
      { offset: 10, source: "%YAML 1.2" },
      { offset: 20, source: "%TAG !! tag:yaml.org,2002:" },
    ]);
  });

  it("reports an unknown %YAML version only as a warning", () => {
    const doc = first("%YAML 1.3\n---\non: push\n");
    expect(doc.errors).toEqual([]);
    expect(doc.warnings.map((w) => w.code)).toEqual(["BAD_DIRECTIVE"]);
  });

  it("leaves collection tags unresolved with a positioned warning, keeping the tag", () => {
    for (const tag of ["!!omap [{k: x}]", "!!set {A: null}", "!!pairs [{k: x}]", "!custom x"]) {
      const doc = first(`a: ${tag}\n`);
      expect(doc.errors).toEqual([]);
      expect(doc.warnings.map((w) => [w.code, w.pos[0]])).toEqual([["TAG_RESOLVE_FAILED", 3]]);
    }
    expect(entryValue(first("a: !!omap [{k: x}]\n"), "a")?.tag).toBe("tag:yaml.org,2002:omap");
  });

  it("resolves a core tag without a warning but keeps it, so the walk refuses tagged nodes", () => {
    const doc = first("a: !!str x\n");
    expect([...doc.errors, ...doc.warnings]).toEqual([]);
    expect(entryValue(doc, "a")?.tag).toBe("tag:yaml.org,2002:str");
  });

  it("yields a document for empty, comment-only and directive-only text, diagnostics kept", () => {
    for (const text of ["", "# only a comment\n"]) {
      const { docs } = compose(text);
      expect(docs).toHaveLength(1);
      expect(docs[0]?.contents).toBeNull();
    }
    const doc = first("%BOGUS x\n");
    expect(doc.errors.map((e) => e.code)).toEqual(["MISSING_CHAR"]);
    expect(doc.warnings.map((w) => w.code)).toEqual(["BAD_DIRECTIVE"]);
  });

  it("gives one document token per document, so the parser counts them itself", () => {
    const { tokens, docs } = compose("a: 1\n---\nb: 2\n");
    expect(tokens.filter((t) => t.type === "document")).toHaveLength(2);
    expect(docs).toHaveLength(2);
    expect(docs[0]?.errors).toEqual([]);
  });

  it("maps offsets to lines and UTF-16 columns, which the parser converts to code points", () => {
    const text = 'a: "\u{1F600}"\nb:\n  - x\n';
    const { docs, lines } = compose(text);
    const b = docs[0] && entryValue(docs[0], "b");
    if (!isSeq(b)) throw new Error("b is not a sequence");
    const x = b.items[0];
    if (!isScalar(x) || !x.range) throw new Error("no range");
    expect(lines.linePos(x.range[0])).toEqual({ line: 3, col: 5 });
    // After the emoji (two UTF-16 units, one code point) on line 1.
    expect(lines.linePos(text.indexOf('"', 5))).toEqual({ line: 1, col: 7 });
  });

  it("gives ranges as [start, value end, node end] with a BOM and CRLF counted in offsets", () => {
    const doc = first("\uFEFFa: x # comment\r\nb: y\r\n");
    expect(entryValue(doc, "a")?.range).toEqual([4, 5, 17]);
    expect(entryValue(doc, "b")?.range).toEqual([20, 21, 23]);
  });

  it("positions syntax errors by offset", () => {
    const { docs, lines } = compose("a:\n\t- x\n");
    const error = docs[0]?.errors[0];
    expect(error?.code).toBe("TAB_AS_INDENT");
    expect(error?.pos).toEqual([3, 4]);
    expect(lines.linePos(3)).toEqual({ line: 2, col: 1 });
  });

  it("turns nesting too deep for the stack into a diagnostic, not a throw", () => {
    // How deep overflows depends on the runtime's stack, so only the outcome is pinned.
    const depth = 100_000;
    const text = `${"[".repeat(depth)}${"]".repeat(depth)}\n`;
    let doc: Document.Parsed | undefined;
    expect(() => {
      doc = first(text);
    }).not.toThrow();
    expect(doc?.errors.some((e) => e.code === "RESOURCE_EXHAUSTION")).toBe(true);
  }, 60_000); // The input must overflow the stack; CI runs every suite at once.
});
