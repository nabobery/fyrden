import { useEffect, useRef, useState } from "react";
import type { MarkdownPlace } from "../lib/markdown-place.js";
import { drawDiagrams } from "../lib/mermaid.client.js";

/**
 * Markdown, rendered in the browser: the server never parses it (Markdown
 * is costly to render, and the server's CPU budget is small), so a page
 * shows the source as plain text, whitespace kept, until it is hydrated;
 * then the renderer (`lib/markdown.client.ts`, loaded on demand and never
 * in the server build) turns it into safe HTML: raw HTML escaped, only safe
 * link protocols, and with `at` a README's links into the repository. Its Mermaid code blocks are then
 * drawn (`lib/mermaid.client.ts`, which loads Mermaid only when there is a
 * diagram).
 */
export function Markdown({ source, at }: { source: string; at?: MarkdownPlace | undefined }) {
  const [html, setHtml] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const base = at?.base;
  const gitRef = at?.ref;
  const dir = at?.dir;
  useEffect(() => {
    let live = true;
    setHtml(null);
    void import("../lib/markdown.client.js").then(({ renderMarkdown }) => {
      const place = base !== undefined ? { base, ref: gitRef ?? "", dir: dir ?? "" } : undefined;
      if (live) setHtml(renderMarkdown(source, place));
    });
    return () => {
      live = false;
    };
  }, [source, base, gitRef, dir]);
  useEffect(() => {
    if (html === null) return;
    const blocks = [...(ref.current?.querySelectorAll("pre > code.language-mermaid") ?? [])];
    if (blocks.length === 0) return;
    let cancelled = false;
    void drawDiagrams(blocks, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [html]);
  if (html === null)
    return (
      <div className="markdown">
        <pre className="markdown-source">{source}</pre>
      </div>
    );
  // biome-ignore lint/security/noDangerouslySetInnerHtml: rendered by micromark with raw HTML escaped and unsafe URLs dropped.
  return <div ref={ref} className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
