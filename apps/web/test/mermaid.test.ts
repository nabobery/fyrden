// Mermaid diagrams are drawn in the browser, each Markdown component its
// own: Mermaid removes any element with the id it renders under, so every
// diagram on the page takes an id of its own, a component gone meanwhile
// places nothing, and a drawing is shown as an image, never as markup.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const render = vi.hoisted(() =>
  vi.fn(async (id: string, _code: string) => ({ svg: `<svg id="${id}"></svg>` })),
);
const initialize = vi.hoisted(() => vi.fn());
vi.mock("mermaid", () => ({ default: { initialize, render } }));

const { drawDiagrams, redrawDiagrams } = await import("../app/lib/mermaid.client.js");
const { FJORD } = await import("../app/lib/fjord.js");

/** An element as the stubbed document makes it: what was set on it and put in it. */
interface Made {
  tag: string;
  className?: string;
  alt?: string;
  src?: string;
  innerHTML?: string;
  children: Made[];
  isConnected?: boolean;
}

/** A `pre > code.language-mermaid` block: where its figure went, if anywhere. */
function block(code: string) {
  const placed: Made[] = [];
  const element = {
    textContent: code,
    parentElement: { replaceWith: (figure: Made) => placed.push(figure) },
  };
  return { element: element as unknown as Element, placed };
}

/** The operating system's scheme, and who listens for it changing. */
const scheme = { matches: false, listeners: [] as (() => unknown)[] };
const media = {
  get matches() {
    return scheme.matches;
  },
  addEventListener: (_type: string, listener: () => unknown) => scheme.listeners.push(listener),
};
/** The figures on the page. */
const figures: unknown[] = [];
/** The page's `<html data-theme>`. */
const dataset: { theme?: string } = {};

beforeEach(() => {
  delete dataset.theme;
  figures.length = 0;
  render.mockReset();
  render.mockImplementation(async (id: string) => ({ svg: `<svg id="${id}"></svg>` }));
  scheme.matches = false;
  vi.stubGlobal("window", { matchMedia: () => media });
  vi.stubGlobal("document", {
    documentElement: { dataset },
    querySelectorAll: () => figures,
    createElement: (tag: string): Made & { appendChild(child: Made): void } => {
      const children: Made[] = [];
      return { tag, children, isConnected: true, appendChild: (child) => children.push(child) };
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("drawing Mermaid diagrams", () => {
  it.each([
    ["default", false, FJORD.light],
    ["dark", true, FJORD.dark],
  ])(
    "draws over Mermaid's %s theme in Fjord's colours, which no diagram may change",
    async (theme, dark, colours) => {
      scheme.matches = dark;
      await drawDiagrams([block("graph TD\n  A --> B").element], () => false);
      expect(initialize).toHaveBeenLastCalledWith(
        expect.objectContaining({
          theme,
          themeVariables: expect.objectContaining({
            primaryColor: colours.page.panel,
            primaryTextColor: colours.page.fg,
            lineColor: colours.page.muted,
            // Mermaid's is a pale shadow, which reads as a glow on a dark page.
            dropShadow: "none",
          }),
          secure: expect.arrayContaining(["theme", "themeVariables"]),
        }),
      );
    },
  );

  it.each([
    ["dark", false, "dark"],
    ["light", true, "default"],
  ])("draws in a %s scheme picked over the operating system's", async (picked, os, theme) => {
    scheme.matches = os;
    dataset.theme = picked;
    await drawDiagrams([block("graph TD\n  A --> B").element], () => false);
    expect(initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme }));
  });

  it("draws the page's diagrams again, each image in the scheme now in force", async () => {
    const { element, placed } = block("graph TD\n  Follow --> Me");
    await drawDiagrams([element], () => false);
    figures.push(...placed);
    render.mockImplementation(async (id: string) => ({
      svg: `<svg id="${id}" data-scheme="${scheme.matches ? "dark" : "light"}"></svg>`,
    }));
    scheme.matches = true;
    await redrawDiagrams();
    expect(initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "dark" }));
    expect(decodeURIComponent(placed[0]?.children[0]?.src ?? "")).toContain('data-scheme="dark"');
  });

  it("draws again when the scheme changes while a drawing is under way", async () => {
    render.mockImplementationOnce(async (id: string) => {
      // The operating system changes while Mermaid draws in the old scheme.
      scheme.matches = true;
      return { svg: `<svg id="${id}" data-scheme="stale"></svg>` };
    });
    const { element, placed } = block("graph TD\n  During --> It");
    await drawDiagrams([element], () => false);
    expect(render).toHaveBeenCalledTimes(2);
    expect(initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "dark" }));
    expect(decodeURIComponent(placed[0]?.children[0]?.src ?? "")).not.toContain("stale");
  });

  it("configures and draws one diagram at a time, as Mermaid's settings are global", async () => {
    const steps: string[] = [];
    initialize.mockImplementation(() => steps.push("configure"));
    let finishFirst = () => {};
    const firstStarted = Promise.withResolvers<void>();
    render.mockImplementationOnce(async (id: string) => {
      steps.push("first starts");
      firstStarted.resolve();
      await new Promise<void>((finish) => {
        finishFirst = finish;
      });
      steps.push("first ends");
      return { svg: `<svg id="${id}"></svg>` };
    });
    render.mockImplementationOnce(async (id: string) => {
      steps.push("second starts");
      return { svg: `<svg id="${id}"></svg>` };
    });
    const first = drawDiagrams([block("graph TD\n  One --> Two").element], () => false);
    await firstStarted.promise;
    // The second asks whether its page left just before it queues for its turn, in the
    // same synchronous step: were nothing holding it back, it would be at the renderer now.
    const secondQueued = Promise.withResolvers<void>();
    const second = drawDiagrams([block("graph TD\n  Three --> Four").element], () => {
      secondQueued.resolve();
      return false;
    });
    await secondQueued.promise;
    finishFirst();
    await Promise.all([first, second]);
    initialize.mockReset();
    expect(steps).toEqual([
      "configure",
      "first starts",
      "first ends",
      "configure",
      "second starts",
    ]);
  });

  it("skips a diagram whose page left while it waited for its turn", async () => {
    let finishFirst = () => {};
    const firstStarted = Promise.withResolvers<void>();
    render.mockImplementationOnce(async (id: string) => {
      firstStarted.resolve();
      await new Promise<void>((finish) => {
        finishFirst = finish;
      });
      return { svg: `<svg id="${id}"></svg>` };
    });
    const first = drawDiagrams([block("graph TD\n  One --> Two").element], () => false);
    await firstStarted.promise;
    let left = false;
    // The second asks whether its page left just before it queues for its turn, in the
    // same synchronous step, so once asked it is waiting in the queue.
    const secondQueued = Promise.withResolvers<void>();
    const second = drawDiagrams([block("graph TD\n  Gone --> Away").element], () => {
      secondQueued.resolve();
      return left;
    });
    await secondQueued.promise;
    left = true;
    finishFirst();
    await Promise.all([first, second]);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("does not draw again for a page that left during a scheme change", async () => {
    let left = false;
    render.mockImplementationOnce(async (id: string) => {
      scheme.matches = true;
      left = true;
      return { svg: `<svg id="${id}"></svg>` };
    });
    await drawDiagrams([block("graph TD\n  Left --> During").element], () => left);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("listens once for the operating system, and ignores it under a picked scheme", async () => {
    const { element, placed } = block("graph TD\n  A --> B");
    await drawDiagrams([element], () => false);
    await drawDiagrams([block("graph TD\n  C --> D").element], () => false);
    figures.push(...placed);
    expect(scheme.listeners).toHaveLength(1);

    dataset.theme = "light";
    render.mockClear();
    await scheme.listeners[0]?.();
    expect(render).not.toHaveBeenCalled();

    delete dataset.theme;
    await scheme.listeners[0]?.();
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("gives every diagram on the page its own id, across components", async () => {
    // A description's diagram, then a comment's two drawn later by another component.
    const description = block("graph TD\n  A --> B");
    await drawDiagrams([description.element], () => false);
    const comment = [block("graph LR\n  C --> D"), block("graph LR\n  E --> F")];
    await drawDiagrams(
      comment.map((b) => b.element),
      () => false,
    );
    const ids = render.mock.calls.map(([id]) => id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect([description, ...comment].map((b) => b.placed.length)).toEqual([1, 1, 1]);
  });

  it("shows a drawing as an image of its SVG, never as markup in the page", async () => {
    render.mockImplementationOnce(async () => ({ svg: '<svg><text>A & "B"</text></svg>' }));
    const diagram = block("graph TD\n  A --> B");
    await drawDiagrams([diagram.element], () => false);
    const [figure] = diagram.placed;
    expect(figure).toMatchObject({ tag: "figure", className: "mermaid" });
    expect(figure?.innerHTML).toBeUndefined();
    const [image] = figure?.children ?? [];
    expect(image).toMatchObject({ tag: "img", alt: "Diagram" });
    expect(image?.innerHTML).toBeUndefined();
    const prefix = "data:image/svg+xml;charset=utf-8,";
    expect(image?.src?.startsWith(prefix)).toBe(true);
    expect(decodeURIComponent(image?.src?.slice(prefix.length) ?? "")).toBe(
      '<svg><text>A & "B"</text></svg>',
    );
  });

  it("places nothing for a component gone while its diagram was drawn", async () => {
    let cancelled = false;
    render.mockImplementationOnce(async (id: string) => {
      cancelled = true;
      return { svg: `<svg id="${id}"></svg>` };
    });
    const first = block("graph TD\n  A --> B");
    const second = block("graph TD\n  C --> D");
    await drawDiagrams([first.element, second.element], () => cancelled);
    expect(first.placed).toEqual([]);
    expect(second.placed).toEqual([]);
    expect(render).toHaveBeenCalledTimes(1);
  });
});
