// After each render the renderer's virtualizer scrolls the page so that what it anchored on
// hasn't moved: a drawn line in the window, or else a file's top or bottom edge. Before a file's
// first render its element has no height, and the renderer takes an empty file at the top of the
// window for one wholly above it: it holds the bottom edge and, as the file grows, scrolls the
// page to the file's end. These tests drive the renderer's own anchor and correction (internal
// to @pierre/diffs 1.6.2), so an upgrade that changes them fails here.

import { Virtualizer } from "@pierre/diffs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { steadyVirtualizer } from "../app/components/diff/steady-virtualizer.client.js";

/** A file element with no drawn lines: `top` pixels from the top of the window, `height` tall. */
function fileAt(top: number, height: number) {
  return {
    top,
    offsetHeight: height,
    getBoundingClientRect() {
      return { top: this.top, height: this.offsetHeight };
    },
    shadowRoot: null,
  };
}

interface Internal {
  visibleInstances: Map<object, object>;
  scrollDirty: boolean;
  getScrollAnchor(viewportHeight: number): unknown;
  scrollFix(anchor: unknown): void;
}

/**
 * The page scrolled by `virtualizer` around one render of its one visible file, `element`:
 * anchored before, `render` grows or moves it, then corrected as the renderer does.
 */
function scrolledAround(
  virtualizer: Virtualizer,
  element: ReturnType<typeof fileAt>,
  render: () => void,
) {
  const scrollTo = vi.fn();
  vi.stubGlobal("window", { scrollY: 0, scrollTo });
  const internal = virtualizer as unknown as Internal;
  internal.visibleInstances.set(element, {});
  const anchor = internal.getScrollAnchor(800);
  render();
  internal.scrollDirty = false;
  internal.scrollFix(anchor);
  return {
    scrolledTo: scrollTo.mock.calls.map(([options]) => (options as { top: number }).top),
    marked: internal.scrollDirty,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the renderer's virtualizer", () => {
  it("scrolls to the end of a file that was empty at the top of the window", () => {
    const file = fileAt(0, 0);
    expect(
      scrolledAround(new Virtualizer(), file, () => {
        file.offsetHeight = 60_000;
      }),
    ).toEqual({ scrolledTo: [60_000], marked: true });
  });
});

describe("a steady virtualizer", () => {
  it("scrolls nothing for a file that was empty, and marks its layout as the renderer does", () => {
    const file = fileAt(0, 0);
    expect(
      scrolledAround(steadyVirtualizer(), file, () => {
        file.offsetHeight = 60_000;
      }),
    ).toEqual({ scrolledTo: [], marked: true });
  });

  it("holds a file with height in place as the renderer does", () => {
    // Wholly above the window, then 500 pixels taller: the page follows its bottom edge.
    const above = fileAt(-500, 400);
    expect(
      scrolledAround(steadyVirtualizer(), above, () => {
        above.offsetHeight = 900;
      }),
    ).toEqual({ scrolledTo: [500], marked: true });
    // In the window, then moved 30 pixels down: the page follows its top edge.
    const inView = fileAt(120, 60_000);
    expect(
      scrolledAround(steadyVirtualizer(), inView, () => {
        inView.top = 150;
      }),
    ).toEqual({ scrolledTo: [30], marked: true });
  });

  it("does nothing for a file that stays empty", () => {
    expect(scrolledAround(steadyVirtualizer(), fileAt(0, 0), () => {})).toEqual({
      scrolledTo: [],
      marked: false,
    });
  });
});
