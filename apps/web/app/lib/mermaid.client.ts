/**
 * Draws a page's Mermaid code blocks: strict mode (no scripts or links) and
 * labels as SVG text, never HTML (strict mode alone keeps sanitized HTML in
 * labels). A client-only module: the server build never carries Mermaid.
 */
/** Mermaid's own keys no diagram may set (its default `secure` list, 12.x). */
const SECURE_KEYS = [
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "suppressErrorRendering",
  "maxEdges",
];

/**
 * Diagrams drawn on this document so far: each takes an id of its own, as
 * Mermaid first removes any element with the id it renders under (another
 * comment's diagram, drawn earlier by another Markdown component).
 */
let drawn = 0;

export async function drawDiagrams(blocks: Element[], isCancelled: () => boolean): Promise<void> {
  const { default: mermaid } = await import("mermaid");
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    // A diagram's own directives and front matter may not change these back.
    // All of `flowchart` (its cosmetic settings too): Mermaid still reads
    // `flowchart.htmlLabels` directly for some labels (swimlanes, 12.2).
    secure: [...SECURE_KEYS, "htmlLabels", "flowchart"],
    theme: dark ? "dark" : "default",
  });
  for (const code of blocks) {
    if (isCancelled()) return;
    try {
      const { svg } = await mermaid.render(`mermaid-${drawn++}`, code.textContent ?? "");
      // The component may have gone (or rendered again) while this one was drawn.
      if (isCancelled()) return;
      const figure = document.createElement("figure");
      figure.className = "mermaid";
      figure.setAttribute("role", "img");
      figure.setAttribute("aria-label", "Diagram");
      figure.innerHTML = svg;
      code.parentElement?.replaceWith(figure);
    } catch {
      // A diagram Mermaid cannot draw stays as its source.
    }
  }
}
