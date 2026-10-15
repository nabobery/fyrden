import { useEffect, useRef } from "react";
import { drawDiagrams } from "../lib/mermaid.client.js";

/**
 * Rendered Markdown (already safe HTML, see `lib/markdown.ts`), with its
 * Mermaid code blocks drawn on the client (`lib/mermaid.client.ts`), which
 * loads Mermaid only when a page has a diagram.
 */
export function Markdown({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: new HTML means new diagrams to draw.
  useEffect(() => {
    const blocks = [...(ref.current?.querySelectorAll("pre > code.language-mermaid") ?? [])];
    if (blocks.length === 0) return;
    let cancelled = false;
    void drawDiagrams(blocks, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [html]);
  // biome-ignore lint/security/noDangerouslySetInnerHtml: rendered by micromark with raw HTML escaped and unsafe URLs dropped.
  return <div ref={ref} className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
