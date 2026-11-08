// The attachment header for a stored name: an ASCII fallback and the exact
// name, so no name can break out of the header or change what it says.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { contentDispositionFor } from "../src/http/content-disposition.js";

const SHAPE = /^attachment; filename="([^"\\]*)"; filename\*=UTF-8''([A-Za-z0-9!#$&+\-.^_`|~%]*)$/;

function parts(name: string): { fallback: string; exact: string } {
  const value = contentDispositionFor(name);
  const match = SHAPE.exec(value);
  if (!match) throw new Error(`not the header's shape: ${value}`);
  return { fallback: match[1] ?? "", exact: decodeURIComponent(match[2] ?? "") };
}

describe("contentDispositionFor", () => {
  it.each([
    ["app.zip", "attachment; filename=\"app.zip\"; filename*=UTF-8''app.zip"],
    ["a b.zip", "attachment; filename=\"a b.zip\"; filename*=UTF-8''a%20b.zip"],
    ["résumé.pdf", "attachment; filename=\"r_sum_.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"],
    ['a"b\\c.txt', "attachment; filename=\"a_b_c.txt\"; filename*=UTF-8''a%22b%5Cc.txt"],
    ["100%25.txt", "attachment; filename=\"100_25.txt\"; filename*=UTF-8''100%2525.txt"],
    ["(a)'*.txt", "attachment; filename=\"(a)'*.txt\"; filename*=UTF-8''%28a%29%27%2A.txt"],
    ["🦀.tar", "attachment; filename=\"_.tar\"; filename*=UTF-8''%F0%9F%A6%80.tar"],
  ])("%s", (name, header) => {
    expect(contentDispositionFor(name)).toBe(header);
  });

  it("can't be broken out of, by a line break or a parameter of its own", () => {
    for (const name of ["a\r\nSet-Cookie: x=1", '";filename="evil.html', "a\0b"]) {
      const header = contentDispositionFor(name);
      expect(() => new Headers({ "Content-Disposition": header })).not.toThrow();
      expect(parts(name).exact).toBe(name);
      expect(parts(name).fallback).not.toMatch(/[\r\n\0"]/);
    }
  });

  it("gives back the exact name, and an ASCII fallback, for any name", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", minLength: 1 }), (name) => {
        const { fallback, exact } = parts(name);
        expect(exact).toBe(name);
        expect(fallback).toMatch(/^[\x20-\x7e]+$/);
        expect(fallback).not.toContain("%");
        expect(
          () => new Headers({ "Content-Disposition": contentDispositionFor(name) }),
        ).not.toThrow();
      }),
    );
  });

  it("doesn't throw on a name that isn't well-formed UTF-16", () => {
    expect(contentDispositionFor("a\ud800b")).toBe(
      "attachment; filename=\"a_b\"; filename*=UTF-8''a%EF%BF%BDb",
    );
  });
});
