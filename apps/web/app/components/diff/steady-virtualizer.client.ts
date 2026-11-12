import { Virtualizer } from "@pierre/diffs";

/** What the renderer keeps in place on the page as rows are drawn: a line, or a file's edge. */
interface ScrollAnchor {
  fileElement: HTMLElement;
}

/** The renderer's own steps, internal to @pierre/diffs 1.6.2 (a test pins them). */
interface Internal {
  getScrollAnchor?: (viewportHeight: number) => ScrollAnchor | undefined;
  applyScrollFix?: (scrollOffset: number) => void;
}

/**
 * The renderer's virtualizer, never scrolling to keep an empty file in place. After each render
 * the renderer scrolls the page so that what it anchored on (`getScrollAnchor`) hasn't moved,
 * and marks its layout to be read again (`applyScrollFix`). Before a file's first render its
 * element has no height, and the renderer takes an empty file at the top of the window for one
 * wholly above it: it holds the bottom edge, and as the file grows the page is scrolled to the
 * file's end. An empty file had nothing on screen to hold, so that correction marks the layout
 * as the renderer would, and scrolls nothing.
 */
export function steadyVirtualizer(): Virtualizer {
  const virtualizer = new Virtualizer();
  const internal = virtualizer as unknown as Internal;
  const anchorOf = internal.getScrollAnchor?.bind(virtualizer);
  const fix = internal.applyScrollFix?.bind(virtualizer);
  if (anchorOf === undefined || fix === undefined) return virtualizer;
  // Set with each anchor, read by the correction that follows it in the same render.
  let empty = false;
  internal.getScrollAnchor = (viewportHeight) => {
    const anchor = anchorOf(viewportHeight);
    empty = anchor?.fileElement.offsetHeight === 0;
    return anchor;
  };
  internal.applyScrollFix = (scrollOffset) => {
    if (empty) virtualizer.markDOMDirty();
    else fix(scrollOffset);
  };
  return virtualizer;
}
