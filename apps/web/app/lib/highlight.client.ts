/**
 * Highlights a page's Markdown code blocks whose fence names a language
 * the highlighter knows, in the browser: `@pierre/highlights` (WebAssembly)
 * is loaded only when a page has such a block, within the page's budget
 * (`HIGHLIGHT_BUDGET`, against what the page shows highlighted when each
 * block is reached; the rest stays plain). Each block is rebuilt from
 * the highlighter's tokens as text spans (never HTML from it), coloured by
 * custom properties for both colour schemes (app.css picks one). Anything
 * that fails leaves the block plain. A client-only module: the server
 * build never carries the highlighter.
 */

import { fenceLanguage, fits } from "./highlight-languages.js";
import { DARK, LIGHT, themeOf } from "./highlight-palette.js";

const THEMES = {
  light: themeOf("Fyrden light", "light", LIGHT),
  dark: themeOf("Fyrden dark", "dark", DARK),
};

const encoder = new TextEncoder();

/** Each block highlighted, and its size in UTF-8 bytes. */
const sizes = new WeakMap<Element, number>();

/**
 * What the page shows highlighted now: its blocks in the document and
 * their bytes. Counted from the page itself, so blocks it still shows (a
 * description kept while comments are paged) count, and ones gone (another
 * page's) do not.
 */
function spentNow(): { bytes: number; blocks: number } {
  let bytes = 0;
  let blocks = 0;
  for (const code of document.querySelectorAll("pre.highlights > code")) {
    bytes += sizes.get(code) ?? encoder.encode(code.textContent ?? "").length;
    blocks += 1;
  }
  return { bytes, blocks };
}

export async function highlightBlocks(
  blocks: readonly Element[],
  isCancelled: () => boolean,
): Promise<void> {
  const todo = blocks.flatMap((code) => {
    const lang = fenceLanguage(code.className);
    return lang === null ? [] : [{ code, lang, text: code.textContent ?? "" }];
  });
  if (todo.length === 0 || isCancelled()) return;
  let highlighter: typeof import("@pierre/highlights");
  try {
    highlighter = await import("@pierre/highlights");
  } catch {
    // Not loaded (blocked, or no WebAssembly): the code stays plain.
    return;
  }
  for (const { code, lang, text } of todo) {
    // A page gone meanwhile highlights nothing (and so spends nothing).
    if (isCancelled()) return;
    // Within what the page shows highlighted now, block by block: past it, the rest stay plain.
    const size = encoder.encode(text).length;
    if (!code.isConnected || !fits(spentNow(), size)) continue;
    try {
      if (!highlighter.isSupportedLanguage(lang)) continue;
      const { tokens } = highlighter.codeToTokens(text, {
        lang,
        themes: THEMES,
        defaultColor: false,
      });
      const fragment = document.createDocumentFragment();
      tokens.forEach((line, index) => {
        if (index > 0) fragment.append("\n");
        for (const token of line) {
          const span = document.createElement("span");
          span.textContent = token.content;
          for (const [property, value] of Object.entries(token.htmlStyle ?? {}))
            span.style.setProperty(property, value);
          fragment.append(span);
        }
      });
      // The same text, as spans: a block whose text changed meanwhile is left as it is.
      if (code.textContent !== text) continue;
      code.replaceChildren(fragment);
      sizes.set(code, size);
      code.parentElement?.classList.add("highlights");
    } catch {
      // A block the highlighter cannot take stays plain.
    }
  }
}
