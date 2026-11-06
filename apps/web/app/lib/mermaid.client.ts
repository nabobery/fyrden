/**
 * Draws a page's Mermaid code blocks: strict mode (no scripts or links) and
 * labels as SVG text, never HTML (strict mode alone keeps sanitized HTML in
 * labels). Each drawing is shown as an image, never put in the page as
 * markup: an SVG image runs nothing and loads nothing, whatever got past
 * Mermaid's sanitizing. A client-only module: the server build never
 * carries Mermaid.
 */
import type MermaidModule from "mermaid";
import { FJORD, type Scheme } from "./fjord.js";

type Mermaid = typeof MermaidModule;

/**
 * Fjord's surfaces and text over Mermaid's own light or dark theme. Not over its
 * `base` theme, whose per-diagram defaults (Gantt markers, Cynefin domains, gitGraph
 * labels) stay light-scheme colours; these two carry readable ones for their scheme.
 */
function mermaidColors({ page }: Scheme) {
  return {
    background: page.bg,
    primaryColor: page.panel,
    primaryTextColor: page.fg,
    primaryBorderColor: page.border,
    lineColor: page.muted,
    textColor: page.fg,
    mainBkg: page.panel,
    nodeBorder: page.border,
    noteBkgColor: page.panel,
    noteTextColor: page.fg,
    noteBorderColor: page.border,
    taskBkgColor: page.panel,
    taskTextColor: page.fg,
    taskBorderColor: page.border,
    dropShadow: "none",
  };
}

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

const DARK_SCHEME = "(prefers-color-scheme: dark)";

/** A forced scheme from the site header's choice, else the operating system's. */
function isDark(): boolean {
  const forced = document.documentElement.dataset.theme;
  return forced ? forced === "dark" : window.matchMedia(DARK_SCHEME).matches;
}

function configure(mermaid: Mermaid, dark: boolean): void {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    // A diagram's own directives and front matter may not change these back.
    // All of `flowchart` (its cosmetic settings too): Mermaid still reads
    // `flowchart.htmlLabels` directly for some labels (swimlanes, 12.2).
    secure: [...SECURE_KEYS, "htmlLabels", "flowchart", "theme", "themeVariables"],
    theme: dark ? "dark" : "default",
    themeVariables: mermaidColors(dark ? FJORD.dark : FJORD.light),
  });
}

/** The drawing under way: Mermaid's settings are global, so one configures and draws at a time. */
let turn: Promise<unknown> = Promise.resolve();

/** `source` as an SVG in the scheme in force when it finished: drawn again if that changed. */
function renderInScheme(mermaid: Mermaid, source: string): Promise<string> {
  const drawing = turn.then(async () => {
    for (;;) {
      const dark = isDark();
      configure(mermaid, dark);
      const { svg } = await mermaid.render(`mermaid-${drawn++}`, source);
      if (dark === isDark()) return svg;
    }
  });
  turn = drawing.catch(() => undefined);
  return drawing;
}

/** An SVG as an image's `src`: an image runs and loads nothing. */
const imageSource = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** Each figure's image and source, gone with the figure. */
const drawings = new WeakMap<object, { image: HTMLImageElement; source: string }>();

/** Draws the page's diagrams again in the scheme now in force, each keeping its drawing on failure. */
export async function redrawDiagrams(): Promise<void> {
  const { default: mermaid } = await import("mermaid");
  for (const figure of document.querySelectorAll("figure.mermaid")) {
    const drawing = drawings.get(figure);
    if (!drawing) continue;
    try {
      drawing.image.src = imageSource(await renderInScheme(mermaid, drawing.source));
    } catch {
      // It keeps the drawing it has.
    }
  }
}

let following = false;

/** Follows the operating system's scheme, which a scheme picked in the site header overrides. */
function followScheme(): void {
  if (following) return;
  following = true;
  window.matchMedia(DARK_SCHEME).addEventListener("change", () => {
    if (!document.documentElement.dataset.theme) void redrawDiagrams();
  });
}

export async function drawDiagrams(blocks: Element[], isCancelled: () => boolean): Promise<void> {
  const { default: mermaid } = await import("mermaid");
  followScheme();
  for (const code of blocks) {
    if (isCancelled()) return;
    try {
      const source = code.textContent ?? "";
      const svg = await renderInScheme(mermaid, source);
      // The component may have gone (or rendered again) while this one was drawn.
      if (isCancelled()) return;
      const image = document.createElement("img");
      image.alt = "Diagram";
      image.src = imageSource(svg);
      const figure = document.createElement("figure");
      figure.className = "mermaid";
      figure.appendChild(image);
      code.parentElement?.replaceWith(figure);
      drawings.set(figure, { image, source });
    } catch {
      // A diagram Mermaid cannot draw stays as its source.
    }
  }
}
