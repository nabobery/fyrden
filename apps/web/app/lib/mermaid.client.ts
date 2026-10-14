/**
 * Draws a page's Mermaid code blocks (in strict mode: no scripts, links or
 * HTML labels). A client-only module: the server build never carries
 * Mermaid.
 */
export async function drawDiagrams(blocks: Element[], isCancelled: () => boolean): Promise<void> {
  const { default: mermaid } = await import("mermaid");
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: dark ? "dark" : "default",
  });
  for (const [i, code] of blocks.entries()) {
    if (isCancelled()) return;
    try {
      const { svg } = await mermaid.render(`mermaid-${i}`, code.textContent ?? "");
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
