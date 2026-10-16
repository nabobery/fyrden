// Mermaid diagrams are drawn in the browser, each Markdown component its
// own: Mermaid removes any element with the id it renders under, so every
// diagram on the page takes an id of its own, and a component gone
// meanwhile places nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const render = vi.hoisted(() =>
  vi.fn(async (id: string, _code: string) => ({ svg: `<svg id="${id}"></svg>` })),
);
vi.mock("mermaid", () => ({ default: { initialize: () => undefined, render } }));

const { drawDiagrams } = await import("../app/lib/mermaid.client.js");

/** A `pre > code.language-mermaid` block: where its figure went, if anywhere. */
function block(code: string) {
  const placed: unknown[] = [];
  const element = {
    textContent: code,
    parentElement: { replaceWith: (figure: unknown) => placed.push(figure) },
  };
  return { element: element as unknown as Element, placed };
}

beforeEach(() => {
  render.mockClear();
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
  vi.stubGlobal("document", {
    createElement: () => ({ setAttribute: () => undefined, className: "", innerHTML: "" }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("drawing Mermaid diagrams", () => {
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
