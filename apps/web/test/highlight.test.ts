// Markdown code highlighting: the fence labels a page highlights (each one
// the highlighter knows), the page's budget, and the palette: every colour
// readable on the code background in both schemes (WCAG AA, 4.5:1).

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { codeToTokens, isSupportedLanguage } from "@pierre/highlights";
import { describe, expect, it } from "vitest";
import {
  fenceLanguage,
  fits,
  HIGHLIGHT_BUDGET,
  HIGHLIGHT_LANGUAGES,
} from "../app/lib/highlight-languages.js";
import { DARK, LIGHT, themeOf } from "../app/lib/highlight-palette.js";

/** WCAG 2 contrast ratio of two six-digit hex colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((at) => {
      const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("the fence labels highlighted", () => {
  it("are every language the highlighter knows, plain text aside, and only those", () => {
    // The package's own map of names and aliases (not exported): an upgrade that adds or drops
    // one fails here until the list follows.
    const dist = dirname(createRequire(import.meta.url).resolve("@pierre/highlights/package.json"));
    const source = readFileSync(join(dist, "dist/languages.js"), "utf8");
    const map = source.slice(source.indexOf("const languages = {"), source.indexOf("};"));
    const known = [...map.matchAll(/^\s*(?:"([^"]+)"|([A-Za-z0-9_$]+)):\s*\d+,?$/gm)]
      .map((m) => m[1] ?? m[2])
      .filter((name) => !["plain", "plaintext", "text", "txt"].includes(name as string));
    expect(known.length).toBeGreaterThan(150);
    expect([...HIGHLIGHT_LANGUAGES].sort()).toEqual(known.sort());
    for (const lang of HIGHLIGHT_LANGUAGES) expect(isSupportedLanguage(lang), lang).toBe(true);
    for (const plain of ["plain", "text", "txt", "plaintext"])
      expect(HIGHLIGHT_LANGUAGES.has(plain)).toBe(false);
  });

  it("are read from a rendered block's class, ignoring case; others are not highlighted", () => {
    expect(fenceLanguage("language-TS")).toBe("ts");
    expect(fenceLanguage("language-c++")).toBe("c++");
    // Only micromark's one class, whole: a label with a space in it, or a `language-` of its own,
    // is no language (and loads nothing).
    for (const other of [
      "language-mermaid",
      "language-text",
      "language-nope",
      "",
      "rust",
      "language-ts\u00a0junk",
      "language-ts junk",
      "language- language-ts",
      "hljs language-rust",
    ])
      expect(fenceLanguage(other), JSON.stringify(other)).toBeNull();
  });
});

describe("a page's highlighting budget", () => {
  it("takes a block while what the page shows highlighted leaves room for it", () => {
    const k = 1024;
    expect(fits({ bytes: 0, blocks: 0 }, 64 * k)).toBe(true);
    expect(fits({ bytes: 10 * k, blocks: 1 }, 60 * k)).toBe(false);
    // A large one passed over, a later small one still fits.
    expect(fits({ bytes: 10 * k, blocks: 1 }, 4 * k)).toBe(true);
    expect(fits({ bytes: 0, blocks: HIGHLIGHT_BUDGET.blocks - 1 }, 1)).toBe(true);
    expect(fits({ bytes: 0, blocks: HIGHLIGHT_BUDGET.blocks }, 1)).toBe(false);
    expect(fits({ bytes: HIGHLIGHT_BUDGET.bytes, blocks: 0 }, 1)).toBe(false);
  });
});

describe("the palette", () => {
  it("is readable on the code background in both schemes (4.5:1 or more)", () => {
    for (const palette of [LIGHT, DARK]) {
      expect(contrast(palette.foreground, palette.background)).toBeGreaterThanOrEqual(4.5);
      for (const [scope, color] of Object.entries(palette.syntax))
        expect(contrast(color, palette.background), `${scope} ${color}`).toBeGreaterThanOrEqual(
          4.5,
        );
    }
  });

  it("colours tokens for both schemes at once, as custom properties", () => {
    const { tokens } = codeToTokens("const answer = 42;\n", {
      lang: "ts",
      themes: { light: themeOf("l", "light", LIGHT), dark: themeOf("d", "dark", DARK) },
      defaultColor: false,
    });
    const keyword = tokens[0]?.find((token) => token.content.trim() === "const");
    expect(keyword?.htmlStyle).toMatchObject({
      "--hls-light": LIGHT.syntax.keyword,
      "--hls-dark": DARK.syntax.keyword,
    });
  });
});
