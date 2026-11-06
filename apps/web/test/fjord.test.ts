// The Fjord palette: every colour readable on every surface it can land on, the page's
// CSS tokens equal to the palette, and both highlighters' themes drawn from one table.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DARK, FJORD, FJORD_THEME_NAMES, LIGHT, type Scheme } from "../app/lib/fjord.js";
import { textMateTheme, zedTheme } from "../app/lib/fjord-themes.js";

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const SCHEMES: readonly (readonly [string, Scheme])[] = [
  ["light", FJORD.light],
  ["dark", FJORD.dark],
];

/** The block of `css` that holds the tokens of the light (`:root {`) or dark scheme. */
function tokensIn(css: string, opening: string): Record<string, string> {
  const start = css.indexOf(opening);
  expect(start, opening).toBeGreaterThanOrEqual(0);
  const body = css.slice(start + opening.length, css.indexOf("}", start));
  return Object.fromEntries(
    [...body.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6});/g)].map((m) => [m[1], m[2]]),
  );
}

describe("Fjord", () => {
  describe.each(SCHEMES)("%s", (_name, scheme) => {
    const code = Object.entries(scheme.syntax);
    const surfaces = {
      page: scheme.page.bg,
      panel: scheme.page.panel,
      added: scheme.diff.added,
      removed: scheme.diff.removed,
      "added word": scheme.diff.addedWord,
      "removed word": scheme.diff.removedWord,
      selected: scheme.diff.selected,
    };

    it.each(code)("%s stays readable on every code surface", (_token, color) => {
      for (const [surface, background] of Object.entries(surfaces))
        expect(contrast(color, background), surface).toBeGreaterThanOrEqual(4.5);
    });

    it("page text stays readable on page and panel", () => {
      const { fg, muted, accent, danger, ok, bg, panel } = scheme.page;
      for (const color of [fg, muted, accent, danger, ok]) {
        expect(contrast(color, bg), color).toBeGreaterThanOrEqual(4.5);
        expect(contrast(color, panel), color).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(scheme.page.accentFg, accent)).toBeGreaterThanOrEqual(4.5);
    });

    it("line numbers and change markers stay readable on the line fills", () => {
      const { muted, ok, danger } = scheme.page;
      const { added, removed, selected } = scheme.diff;
      for (const fill of [added, removed, selected])
        expect(contrast(muted, fill), fill).toBeGreaterThanOrEqual(4.5);
      expect(contrast(ok, added)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(danger, removed)).toBeGreaterThanOrEqual(4.5);
    });
  });

  it("app.css declares exactly the palette's tokens for each scheme", () => {
    const css = readFileSync(new URL("../app/app.css", import.meta.url), "utf8");
    const expected = (scheme: Scheme) => ({
      "--bg": scheme.page.bg,
      "--fg": scheme.page.fg,
      "--muted": scheme.page.muted,
      "--border": scheme.page.border,
      "--accent": scheme.page.accent,
      "--accent-fg": scheme.page.accentFg,
      "--panel": scheme.page.panel,
      "--danger": scheme.page.danger,
      "--ok": scheme.page.ok,
      "--diff-added": scheme.diff.added,
      "--diff-removed": scheme.diff.removed,
      "--diff-added-word": scheme.diff.addedWord,
      "--diff-removed-word": scheme.diff.removedWord,
      "--diff-selected": scheme.diff.selected,
    });
    expect(tokensIn(css, ":root {")).toEqual(expected(FJORD.light));
    // Followed from the operating system, and picked in the site header.
    expect(tokensIn(css, ':root:not([data-theme="light"]) {')).toEqual(expected(FJORD.dark));
    expect(tokensIn(css, ':root[data-theme="dark"] {')).toEqual(expected(FJORD.dark));
  });

  it("gives Highlights and Shiki the same colours for the same kinds of code", () => {
    for (const [name, scheme] of SCHEMES) {
      const appearance = name as "light" | "dark";
      const zed = zedTheme(appearance);
      const textMate = textMateTheme(appearance);
      expect(zed.name).toBe(FJORD_THEME_NAMES[appearance]);
      expect(textMate.name).toBe(FJORD_THEME_NAMES[appearance]);
      expect(textMate.type).toBe(appearance);
      expect(zed.style["editor.background"]).toBe(scheme.page.bg);
      expect(textMate.colors["editor.background"]).toBe(scheme.page.bg);
      expect(zed.style["editor.foreground"]).toBe(scheme.page.fg);
      expect(textMate.colors["editor.foreground"]).toBe(scheme.page.fg);

      const zedColor = (scope: string) =>
        (zed.style.syntax as Record<string, { color: string }>)[scope]?.color;
      const shikiColor = (scope: string) =>
        textMate.tokenColors.find((rule) => rule.scope.includes(scope))?.settings.foreground;
      for (const [zedScope, textMateScope, token] of [
        ["keyword", "keyword", "keyword"],
        ["string", "string", "string"],
        ["function", "entity.name.function", "function"],
        ["type", "entity.name.type", "type"],
        ["number", "constant.numeric", "number"],
        ["comment", "comment", "comment"],
        ["variable", "variable", "variable"],
        ["tag", "entity.name.tag", "tag"],
        ["attribute", "entity.other.attribute-name", "tag"],
      ] as const) {
        expect(zedColor(zedScope), zedScope).toBe(scheme.syntax[token]);
        expect(shikiColor(textMateScope), textMateScope).toBe(scheme.syntax[token]);
      }
    }
  });

  it("gives Markdown's palette the panel it is drawn on", () => {
    expect(LIGHT.background).toBe(FJORD.light.page.panel);
    expect(DARK.background).toBe(FJORD.dark.page.panel);
  });
});
