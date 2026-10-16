import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import type { MarkdownPlace } from "./markdown-place.js";
import { encodePath, withoutTrailingSlashes } from "./types.js";

/**
 * GitHub-flavored Markdown (a README, a comment) as HTML that is safe to
 * put in a page, in the browser only (see `components/markdown.tsx`): raw
 * HTML in the source is escaped, not passed through, and link and image
 * URLs keep only safe protocols (micromark's defaults; a
 * `javascript:` link loses its URL). Mermaid diagrams stay as
 * `language-mermaid` code blocks, which the page renders on the client.
 * With `at`, links into the repository go to its files at the same ref
 * (as on GitHub: relative to the file, `/` its top) and images to their bytes.
 */
export function renderMarkdown(source: string, at?: MarkdownPlace): string {
  const html = micromark(source, {
    extensions: [gfm()],
    htmlExtensions: [gfmHtml()],
    allowDangerousHtml: false,
    allowDangerousProtocol: false,
  });
  if (!at) return html;
  // Raw HTML is escaped, so every `href="` and `src="` here is micromark's own.
  return html.replace(
    / (href|src)="([^"]*)"/g,
    (_, name: string, url: string) => ` ${name}="${local(url, at, name === "src")}"`,
  );
}

/** A link's or image's URL (as micromark wrote it: encoded, `&` escaped) in the repository. */
function local(url: string, at: MarkdownPlace, image: boolean): string {
  // Another site, the page's own anchors and other schemes stay as they are.
  if (url === "" || url.startsWith("#") || url.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(url))
    return url;
  const top = "https://repo.invalid/";
  const dir = at.dir ? `${top}${encodePath(at.dir)}/` : top;
  const raw = url.replaceAll("&amp;", "&");
  // `..` past the top stays at the top; a leading `/` keeps `a:b` a path, not a scheme.
  const target = new URL(raw, raw.startsWith("/") ? top : dir);
  const path = withoutTrailingSlashes(target.pathname);
  const view = image ? "raw" : target.pathname.endsWith("/") ? "tree" : "blob";
  return `${at.base}/${view}/${at.ref}${path}${target.search}${target.hash}`.replaceAll(
    "&",
    "&amp;",
  );
}
