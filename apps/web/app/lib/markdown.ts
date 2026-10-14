import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";

/**
 * GitHub-flavored Markdown (a README) as HTML that is safe to put in a
 * page: raw HTML in the source is escaped, not passed through, and link
 * and image URLs keep only safe protocols (micromark's defaults; a
 * `javascript:` link loses its URL). Mermaid diagrams stay as
 * `language-mermaid` code blocks, which the page renders on the client.
 */
export function renderMarkdown(source: string): string {
  return micromark(source, {
    extensions: [gfm()],
    htmlExtensions: [gfmHtml()],
    allowDangerousHtml: false,
    allowDangerousProtocol: false,
  });
}
