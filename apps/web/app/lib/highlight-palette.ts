import type { Theme } from "@pierre/highlights";

/**
 * The colours Markdown code is highlighted in: one palette for the light
 * scheme and one for the dark, each on the page's code background
 * (`--panel`), every colour at least 4.5:1 against it (WCAG AA; a test
 * checks each). Syntax scopes not named take their parent's colour
 * (`keyword.control` a keyword's), and the rest the text colour.
 */

/** A syntax scope's colour, by the highlighter's names. */
type Palette = { readonly background: string; readonly foreground: string } & {
  readonly syntax: Readonly<Record<string, string>>;
};

export const LIGHT: Palette = {
  background: "#f6f8fa",
  foreground: "#1f2328",
  syntax: {
    attribute: "#0550ae",
    boolean: "#0550ae",
    comment: "#59636e",
    constant: "#0550ae",
    constructor: "#6639ba",
    "diff.minus": "#82071e",
    "diff.plus": "#116329",
    function: "#6639ba",
    keyword: "#cf222e",
    label: "#953800",
    namespace: "#953800",
    number: "#0550ae",
    operator: "#1f2328",
    preproc: "#cf222e",
    property: "#0550ae",
    punctuation: "#1f2328",
    selector: "#116329",
    string: "#0a3069",
    tag: "#116329",
    title: "#0550ae",
    type: "#953800",
    variable: "#1f2328",
  },
};

export const DARK: Palette = {
  background: "#151b23",
  foreground: "#e6edf3",
  syntax: {
    attribute: "#79c0ff",
    boolean: "#79c0ff",
    comment: "#9198a1",
    constant: "#79c0ff",
    constructor: "#d2a8ff",
    "diff.minus": "#ffa198",
    "diff.plus": "#7ee787",
    function: "#d2a8ff",
    keyword: "#ff7b72",
    label: "#ffa657",
    namespace: "#ffa657",
    number: "#79c0ff",
    operator: "#e6edf3",
    preproc: "#ff7b72",
    property: "#79c0ff",
    punctuation: "#e6edf3",
    selector: "#7ee787",
    string: "#a5d6ff",
    tag: "#7ee787",
    title: "#79c0ff",
    type: "#ffa657",
    variable: "#e6edf3",
  },
};

/** `palette` as the highlighter's theme. */
export function themeOf(name: string, appearance: "light" | "dark", palette: Palette): Theme {
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
