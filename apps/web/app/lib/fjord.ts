/**
 * Fjord, the web app's one palette: page colours, code colours and diff fills
 * for each colour scheme. `app.css` repeats the page and diff values, so a page
 * paints before any script runs; a test keeps the two equal, and another checks
 * every colour against every surface it can land on (4.5:1 or more, WCAG AA).
 */

import type { Theme } from "@pierre/highlights";

export interface Scheme {
  readonly page: {
    readonly bg: string;
    readonly panel: string;
    readonly border: string;
    readonly fg: string;
    readonly muted: string;
    readonly accent: string;
    readonly accentFg: string;
    readonly danger: string;
    readonly ok: string;
  };
  readonly diff: {
    readonly added: string;
    readonly removed: string;
    readonly addedWord: string;
    readonly removedWord: string;
    readonly selected: string;
  };
  readonly syntax: {
    readonly keyword: string;
    readonly string: string;
    readonly function: string;
    readonly type: string;
    readonly number: string;
    readonly comment: string;
    readonly variable: string;
    readonly tag: string;
  };
}

export const FJORD: { readonly light: Scheme; readonly dark: Scheme } = {
  light: {
    page: {
      bg: "#f5f8f8",
      panel: "#eaf0f1",
      border: "#becbd0",
      fg: "#243338",
      muted: "#52676f",
      accent: "#006b75",
      accentFg: "#ffffff",
      danger: "#a22e3b",
      ok: "#27643e",
    },
    diff: {
      added: "#e2eee5",
      removed: "#f4e5e4",
      addedWord: "#d6e7dc",
      removedWord: "#ecd9d7",
      selected: "#dce9eb",
    },
    syntax: {
      keyword: "#7b354a",
      string: "#27643e",
      function: "#165a83",
      type: "#6b4c80",
      number: "#855017",
      comment: "#465a62",
      variable: "#243338",
      tag: "#006b75",
    },
  },
  dark: {
    page: {
      bg: "#111b20",
      panel: "#19262c",
      border: "#41555e",
      fg: "#dce6e8",
      muted: "#a0b0b7",
      accent: "#7bc9cf",
      accentFg: "#111b20",
      danger: "#ffa5a0",
      ok: "#99d3a5",
    },
    diff: {
      added: "#1a302a",
      removed: "#342529",
      addedWord: "#224034",
      removedWord: "#483037",
      selected: "#1f3a42",
    },
    syntax: {
      keyword: "#e5a8b9",
      string: "#99d3a5",
      function: "#9fcaf0",
      type: "#c7b3e4",
      number: "#e5bc85",
      comment: "#a0b0b7",
      variable: "#dce6e8",
      tag: "#7bc9cf",
    },
  },
};

/** The names the file and diff renderers know the themes by. */
export const FJORD_THEME_NAMES = { light: "fjord-light", dark: "fjord-dark" } as const;

export type Appearance = "light" | "dark";

/** Highlights' scopes; ones not named inherit their parent's colour, the rest the text's. */
export function highlightScopes(scheme: Scheme): Readonly<Record<string, string>> {
  const { syntax, page } = scheme;
  return {
    attribute: syntax.tag,
    boolean: syntax.number,
    comment: syntax.comment,
    constant: syntax.number,
    constructor: syntax.type,
    "diff.minus": page.danger,
    "diff.plus": page.ok,
    function: syntax.function,
    keyword: syntax.keyword,
    label: syntax.tag,
    namespace: syntax.type,
    number: syntax.number,
    operator: syntax.variable,
    preproc: syntax.keyword,
    property: syntax.variable,
    punctuation: syntax.variable,
    selector: syntax.tag,
    string: syntax.string,
    tag: syntax.tag,
    title: syntax.function,
    type: syntax.type,
    variable: syntax.variable,
  };
}

/** A highlighter's colours, on `background`. */
type Palette = { readonly background: string; readonly foreground: string } & {
  readonly syntax: Readonly<Record<string, string>>;
};

const markdownPalette = (scheme: Scheme): Palette => ({
  background: scheme.page.panel,
  foreground: scheme.page.fg,
  syntax: highlightScopes(scheme),
});

/** The colours Markdown code is highlighted in, on the page's code background (`--panel`). */
export const LIGHT = markdownPalette(FJORD.light);
export const DARK = markdownPalette(FJORD.dark);

/** `palette` as Highlights' theme. */
export function themeOf(name: string, appearance: Appearance, palette: Palette): Theme {
  return {
    name,
    appearance,
    style: {
      "editor.background": palette.background,
      "editor.foreground": palette.foreground,
      syntax: Object.fromEntries(
        Object.entries(palette.syntax).map(([scope, color]) => [scope, { color }]),
      ),
    },
  } satisfies Theme;
}

/**
 * The renderers' final diff fills, set inside their shadow root (its stylesheet
 * otherwise mixes each fill from a base colour). The values come from the page's
 * custom properties, which inherit into the shadow root, so they follow the scheme.
 */
export const FJORD_RENDERER_CSS = `
:host {
  --diffs-bg-addition-emphasis-override: var(--diff-added-word);
  --diffs-bg-deletion-emphasis-override: var(--diff-removed-word);
  --diffs-fg-number-override: var(--muted);
  --diffs-addition-color-override: var(--ok);
  --diffs-deletion-color-override: var(--danger);
  --diffs-modified-color-override: var(--accent);
}
[data-line-type="change-addition"] {
  --diffs-computed-diff-line-bg: var(--diff-added);
}
[data-line-type="change-deletion"] {
  --diffs-computed-diff-line-bg: var(--diff-removed);
}
[data-selected-line] {
  --diffs-computed-selected-line-bg: var(--diff-selected);
  --diffs-selection-number-fg: var(--accent);
}
[data-no-newline] span {
  color: var(--muted);
  opacity: 1;
}
`;
