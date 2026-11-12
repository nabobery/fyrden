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
 */

export const MAX_CORRECTIONS = 5;

export interface ScrollTargetDeps {
  frame(callback: () => void): number;
  cancelFrame(id: number): void;
  /** How far below where it belongs the line is now (negative: above), or null if unknown. */
  offset(line: number): number | null;
  scrollBy(dy: number): void;
  onReached(line: number): void;
}

export class ScrollTarget {
  readonly #deps: ScrollTargetDeps;
  #line: number | null = null;
  #frame: number | null = null;
  #corrections = 0;
  #inPlace = 0;

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
    const offset = this.#deps.offset(line);
    if (offset !== null && Math.abs(offset) <= 1) {
      this.#inPlace++;
      if (this.#inPlace >= 2) {
        this.#line = null;
        this.#deps.onReached(line);
        return;
      }
      this.#next();
      return;
    }
    this.#inPlace = 0;
    if (this.#corrections >= MAX_CORRECTIONS) {
      this.#line = null;
      return;
    }
    this.#corrections++;
    if (offset !== null) this.#deps.scrollBy(offset);
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
