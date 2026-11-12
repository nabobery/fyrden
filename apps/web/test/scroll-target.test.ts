// Bringing a line into view when rows above it change height after the jump (blame's
// annotation rows do): measure in each frame, correct, and stop once it stays put, after
// five corrections, or when the viewer takes over; then hold it there through later changes
// above it until the viewer scrolls. Frames and the page's scroll are the test's own.

import { describe, expect, it } from "vitest";
import { MAX_CORRECTIONS, ScrollTarget } from "../app/lib/scroll-target.js";

function harness(offsets: (number | null)[]) {
  const frames = new Map<number, () => void>();
  let id = 0;
  const scrolled: number[] = [];
  const reached: number[] = [];
  let measured = 0;
  let y = 0;
  const target = new ScrollTarget({
    frame: (callback) => {
      frames.set(++id, callback);
      return id;
    },
    cancelFrame: (frame) => frames.delete(frame),
    offset: () => {
      const value = offsets[Math.min(measured, offsets.length - 1)] ?? null;
      measured++;
      return value;
    },
    scrollBy: (dy) => {
      scrolled.push(dy);
      y += dy;
    },
    scrollY: () => y,
    onReached: (line) => reached.push(line),
  });
  /** Runs every frame requested so far; returns how many ran. */
  const frame = () => {
    const due = [...frames.entries()];
    frames.clear();
    for (const [, callback] of due) callback();
    return due.length;
  };
  const drain = (limit = 50) => {
    let ran = 0;
    while (frames.size > 0 && ran < limit) ran += frame();
    return ran;
  };
  /** The viewer scrolls the page by `dy`. */
  const viewerScrolls = (dy: number) => {
    y += dy;
  };
  return {
    target,
    frames,
    scrolled,
    reached,
    frame,
    drain,
    viewerScrolls,
    measured: () => measured,
  };
}

describe("a line to bring into view", () => {
  it("corrects once, then is reached after two checks in place, with no event from the renderer", () => {
    const h = harness([216, 0, 0]);
    h.target.go(7000);
    expect(h.frames.size).toBe(1);
    h.drain();
    expect(h.scrolled).toEqual([216]);
    expect(h.reached).toEqual([7000]);
    expect(h.target.pending()).toBeNull();
    expect(h.frames.size).toBe(0);
  });

  it("isn't reached by one check in place: the layout may still be moving", () => {
    const h = harness([0, 40, 0, 0]);
    h.target.go(10);
    h.frame();
    expect(h.reached).toEqual([]);
    h.drain();
    expect(h.scrolled).toEqual([40]);
    expect(h.reached).toEqual([10]);
  });

  it("takes within a pixel as in place", () => {
    const h = harness([1, -1]);
    h.target.go(3);
    h.drain();
    expect(h.scrolled).toEqual([]);
    expect(h.reached).toEqual([3]);
  });

  it(`gives up after ${MAX_CORRECTIONS} corrections, even when the page can't scroll further`, () => {
    const h = harness([500]);
    h.target.go(9);
    h.drain();
    expect(h.scrolled).toHaveLength(MAX_CORRECTIONS);
    expect(h.reached).toEqual([]);
    expect(h.target.pending()).toBeNull();
    expect(h.frames.size).toBe(0);
  });

  it("counts a frame it couldn't measure toward that limit", () => {
    const h = harness([null]);
    h.target.go(9);
    h.drain();
    expect(h.measured()).toBe(MAX_CORRECTIONS + 1);
    expect(h.target.pending()).toBeNull();
  });

  it("stops on cancel, with no frame left", () => {
    const h = harness([300]);
    h.target.go(9);
    h.frame();
    h.target.cancel();
    expect(h.frames.size).toBe(0);
    expect(h.target.pending()).toBeNull();
    expect(h.scrolled).toEqual([300]);
  });

  it("drops the old target for a new one, keeping one frame", () => {
    const h = harness([0, 0]);
    h.target.go(1);
    h.target.go(2);
    expect(h.frames.size).toBe(1);
    h.drain();
    expect(h.reached).toEqual([2]);
  });

  it("ends within ten checks whatever the layout does", () => {
    const h = harness([30, 0, 30, 0, 30, 0, 30, 0, 30, 0, 30, 0]);
    h.target.go(5);
    expect(h.drain()).toBeLessThanOrEqual(2 * MAX_CORRECTIONS + 1);
    expect(h.target.pending()).toBeNull();
  });
});

describe("a line reached, held", () => {
  it("is brought back when something above it moves, the viewer not having scrolled", () => {
    // Reached in place, then the progress line above shrinks and the line rises 37 px.
    const h = harness([0, 0, -37, 0, 0]);
    h.target.go(2400);
    h.drain();
    expect(h.reached).toEqual([2400]);
    expect(h.target.hold()).toBe(true);
    expect(h.target.pending()).toBe(2400);
    h.drain();
    expect(h.scrolled).toEqual([-37]);
    expect(h.reached).toEqual([2400, 2400]);
  });

  it("is held through one change after another", () => {
    const h = harness([0, 0, 20, 0, 0, 15, 0, 0]);
    h.target.go(8);
    h.drain();
    expect(h.target.hold()).toBe(true);
    h.drain();
    expect(h.target.hold()).toBe(true);
    h.drain();
    expect(h.scrolled).toEqual([20, 15]);
    expect(h.reached).toEqual([8, 8, 8]);
  });

  it("is let go once the viewer has scrolled, for good", () => {
    const h = harness([0, 0, 50]);
    h.target.go(8);
    h.drain();
    h.viewerScrolls(400);
    expect(h.target.hold()).toBe(false);
    expect(h.frames.size).toBe(0);
    // Back where the target left it: still let go.
    h.viewerScrolls(-400);
    expect(h.target.hold()).toBe(false);
    expect(h.scrolled).toEqual([]);
  });

  it("is let go when the viewer scrolls before bringing it back has finished", () => {
    // Held, the line rises 37 px, and the viewer drags the scrollbar before the next frame.
    const h = harness([0, 0, -37, -37, 0, 0]);
    h.target.go(8);
    h.drain();
    expect(h.target.hold()).toBe(true);
    h.viewerScrolls(400);
    h.drain();
    expect(h.scrolled).toEqual([]);
    expect(h.target.pending()).toBeNull();
    expect(h.target.hold()).toBe(false);
  });

  it("is let go when the viewer scrolls between its corrections", () => {
    const h = harness([0, 0, 30, 30, 30, 0, 0]);
    h.target.go(8);
    h.drain();
    expect(h.target.hold()).toBe(true);
    h.frame();
    expect(h.scrolled).toEqual([30]);
    h.viewerScrolls(-250);
    h.drain();
    expect(h.scrolled).toEqual([30]);
    expect(h.reached).toEqual([8]);
    expect(h.target.hold()).toBe(false);
  });

  it("is let go on cancel", () => {
    const h = harness([0, 0, 50]);
    h.target.go(8);
    h.drain();
    h.target.cancel();
    expect(h.target.hold()).toBe(false);
    expect(h.frames.size).toBe(0);
  });

  it("holds nothing before a line is reached, or after the target gave up", () => {
    const h = harness([0, 500]);
    expect(h.target.hold()).toBe(false);
    h.target.go(8);
    // Still being brought in: its own frames see the change.
    expect(h.target.hold()).toBe(false);
    expect(h.frames.size).toBe(1);
    h.drain();
    expect(h.reached).toEqual([]);
    expect(h.target.hold()).toBe(false);
    expect(h.frames.size).toBe(0);
  });
});
