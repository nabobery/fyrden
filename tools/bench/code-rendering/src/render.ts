/**
 * The two ways a file view can be turned into highlighted HTML, shared by the
 * workerd and the Node benchmark (each is bundled by esbuild, which resolves
 * the packages from apps/web's dependencies).
 *
 * - `highlights`: `@pierre/highlights` alone, `codeToHtml` with a light and a
 *   dark theme (the floor: tokens to HTML, nothing else).
 * - `file`: `@pierre/diffs`' file renderer (`preloadFile`, its server-side
 *   entry), highlighted by Highlights, with the options the web app's diff
 *   renderer uses (`apps/web/app/components/diff/file-diff.client.tsx`).
 *
 * Both are loaded by dynamic import, so a first call in a fresh isolate pays
 * for evaluating the modules, instantiating the WebAssembly and resolving
 * the themes, as a page would.
 */

export type Mode = "highlights" | "file";
export type Render = (name: string, lang: string, text: string) => Promise<string>;

/** The web app's diff renderer themes and line limit (file-diff.client.tsx). */
const FILE_THEMES = { dark: "github-dark-high-contrast", light: "github-light-high-contrast" };
const MAX_TOKENIZED_LINE = 1000;

export async function loadRenderer(mode: Mode): Promise<Render> {
  if (mode === "highlights") {
    const [{ codeToHtml }, dark, light] = await Promise.all([
      import("@pierre/highlights"),
      import("@pierre/highlights/themes/github-dark-high-contrast"),
      import("@pierre/highlights/themes/github-light-high-contrast"),
    ]);
    const decoder = new TextDecoder();
    const themes = { light: light.default, dark: dark.default };
    return async (_name, lang, text) =>
      decoder.decode(
        codeToHtml(text, {
          lang: lang as Parameters<typeof codeToHtml>[1]["lang"],
          themes,
          defaultColor: "light-dark()",
        }),
      );
  }
  const { preloadFile } = await import("@pierre/diffs/ssr");
  return async (name, _lang, text) => {
    const result = await preloadFile({
      file: { name, contents: text },
      options: {
        theme: FILE_THEMES,
        preferredHighlighter: "highlights",
        tokenizeMaxLineLength: MAX_TOKENIZED_LINE,
      },
    });
    return result.prerenderedHTML;
  };
}

/** Spans carrying a colour: a check that the output was highlighted, not plain. */
export function styledSpans(html: string): number {
  let count = 0;
  let at = html.indexOf("<span");
  while (at !== -1) {
    const end = html.indexOf(">", at);
    if (html.slice(at, end).includes("style=")) count += 1;
    at = html.indexOf("<span", end);
  }
  return count;
}
