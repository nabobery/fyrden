/**
 * Brings a line into view when rows above it change height after the jump: the renderer counts
 * an annotation row it hasn't measured as shorter than it is, so its own position for a line
 * can miss by hundreds of pixels and doesn't correct itself (measured at @pierre/diffs 1.6.2).
 *
 * A target keeps one animation frame requested: each measures how far the line is from where
 * it belongs, scrolls by that if it's more than a pixel off, and asks for the next frame. Two
 * checks in a row in place reach it. It never waits on the renderer to draw again, which an
 * unchanged drawing doesn't. It gives up after `MAX_CORRECTIONS` (a frame it couldn't measure
 * counts), so it ends within about twice that many frames.
 *
 * A line reached is then held: when something above it may have changed height (`hold`), it
 * is brought back the same way, until the viewer scrolls. The viewer has scrolled when the
 * page is no longer where the target left it, checked before bringing it back and before each
 * correction after; this also covers a scrollbar dragged, with no input event to cancel on.
 * (The first jump to a line has no such check: the browser may still be scrolling to the
 * page's fragment then.)
 */

export const MAX_CORRECTIONS = 5;

export interface ScrollTargetDeps {
  frame(callback: () => void): number;
  cancelFrame(id: number): void;
  /** How far below where it belongs the line is now (negative: above), or null if unknown. */
  offset(line: number): number | null;
  scrollBy(dy: number): void;
  /** How far the page is scrolled: changed by anything but the target, the viewer moved. */
  scrollY(): number;
  onReached(line: number): void;
}

export class ScrollTarget {
  readonly #deps: ScrollTargetDeps;
  #line: number | null = null;
  #frame: number | null = null;
  #corrections = 0;
  #inPlace = 0;
  #held: { line: number; scrollY: number } | null = null;
  /** While a held line is brought back: where the page is when only the target moved it. */
  #expectY: number | null = null;

  constructor(deps: ScrollTargetDeps) {
    this.#deps = deps;
  }

  /** The line still being brought into view, if any. */
  pending(): number | null {
    return this.#line;
  }

  go(line: number): void {
    this.cancel();
    this.#line = line;
    this.#corrections = 0;
    this.#inPlace = 0;
    this.#next();
  }

  /** The viewer scrolled or selected, a new target came, or the view went: nothing more moves. */
  cancel(): void {
    if (this.#frame !== null) this.#deps.cancelFrame(this.#frame);
    this.#frame = null;
    this.#line = null;
    this.#held = null;
    this.#expectY = null;
  }

  /**
   * Something above the line reached may have changed height: brings it back into view, unless
   * the viewer has scrolled since, which lets it go for good. True when it starts bringing it
   * back. A line still being brought in needs nothing: its own frames see the change.
   */
  hold(): boolean {
    const held = this.#held;
    if (held === null || this.#line !== null) return false;
    if (this.#deps.scrollY() !== held.scrollY) {
      this.#held = null;
      return false;
    }
    this.go(held.line);
    this.#expectY = held.scrollY;
    return true;
  }

  #next(): void {
    this.#frame = this.#deps.frame(() => {
      this.#frame = null;
      this.#check();
    });
  }

  #check(): void {
    const line = this.#line;
    if (line === null) return;
    if (this.#expectY !== null && this.#deps.scrollY() !== this.#expectY) {
      this.cancel();
      return;
    }
    const offset = this.#deps.offset(line);
    if (offset !== null && Math.abs(offset) <= 1) {
      this.#inPlace++;
      if (this.#inPlace >= 2) {
        this.#line = null;
        this.#expectY = null;
        this.#held = { line, scrollY: this.#deps.scrollY() };
        this.#deps.onReached(line);
        return;
      }
      this.#next();
      return;
    }
    this.#inPlace = 0;
    if (this.#corrections >= MAX_CORRECTIONS) {
      this.#line = null;
      this.#expectY = null;
      return;
    }
    this.#corrections++;
    if (offset !== null) {
      this.#deps.scrollBy(offset);
      if (this.#expectY !== null) this.#expectY = this.#deps.scrollY();
    }
    this.#next();
  }
}

/**
 * The first line whose row is at least partly below the top of the window, in the renderer's
 * drawing under `container` (its rows are in the drawing's shadow root), or null with none.
 */
export function topVisibleLine(container: Element): number | null {
  const host = container.querySelector("diffs-container");
  for (const row of host?.shadowRoot?.querySelectorAll("[data-line]") ?? []) {
    if (row.getBoundingClientRect().bottom <= 0) continue;
    const line = Number(row.getAttribute("data-line"));
    if (Number.isInteger(line) && line > 0) return line;
  }
  return null;
}

/**
 * Whether the reader is still above the renderer's drawing under `container`: it starts at or
 * below the top of the window. False with no drawing.
 */
export function aboveDrawing(container: Element): boolean {
  const host = container.querySelector("diffs-container");
  return host !== null && host.getBoundingClientRect().top >= 0;
}
