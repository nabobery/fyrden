/**
 * Fjord as the file and diff renderers' themes. Its own chunk, loaded when a
 * highlighter asks for a theme, so a worker pool starts only once it has arrived.
 */

import type { Theme } from "@pierre/highlights";
import { type Appearance, FJORD, FJORD_THEME_NAMES, highlightScopes, themeOf } from "./fjord.js";

/** The renderers' theme for Highlights, on the page's background. */
export function zedTheme(appearance: Appearance): Theme & {
  readonly style: { readonly "editor.background": string; readonly "editor.foreground": string };
} {
  const scheme = FJORD[appearance];
  const theme = themeOf(FJORD_THEME_NAMES[appearance], appearance, {
    background: scheme.page.bg,
    foreground: scheme.page.fg,
    syntax: highlightScopes(scheme),
  });
  return theme as ReturnType<typeof zedTheme>;
}

/** The same colours as a TextMate theme, for Shiki when Highlights cannot run. */
export function textMateTheme(appearance: Appearance) {
  const scheme = FJORD[appearance];
  const { syntax } = scheme;
  const rule = (foreground: string, ...scope: string[]) => ({ scope, settings: { foreground } });
  return {
    name: FJORD_THEME_NAMES[appearance],
    type: appearance,
    colors: {
      "editor.background": scheme.page.bg,
      "editor.foreground": scheme.page.fg,
    },
    tokenColors: [
      rule(syntax.comment, "comment", "punctuation.definition.comment"),
      rule(syntax.string, "string", "punctuation.definition.string"),
      rule(syntax.number, "constant.numeric", "constant.language", "constant"),
      rule(syntax.keyword, "keyword", "storage", "storage.type", "storage.modifier"),
      rule(syntax.function, "entity.name.function", "support.function", "meta.function-call"),
      rule(
        syntax.type,
        "entity.name.type",
        "entity.name.class",
        "support.type",
        "support.class",
        "entity.other.inherited-class",
      ),
      rule(
        syntax.tag,
        "entity.name.tag",
        "entity.other.attribute-name",
        "support.type.property-name",
      ),
      rule(syntax.variable, "variable", "variable.other", "keyword.operator", "punctuation"),
    ],
  };
}
