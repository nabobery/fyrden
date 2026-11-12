// Bringing a line into view when rows above it change height after the jump (blame's
// annotation rows do): measure in each frame, correct, and stop once it stays put, after
// five corrections, or when the viewer takes over. Frames are the test's own.

import { describe, expect, it } from "vitest";
import { MAX_CORRECTIONS, ScrollTarget } from "../app/lib/scroll-target.js";

function harness(offsets: (number | null)[]) {
  const frames = new Map<number, () => void>();
  let id = 0;
  const scrolled: number[] = [];
  const reached: number[] = [];
  let measured = 0;
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
    scrollBy: (dy) => scrolled.push(dy),
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
  return { target, frames, scrolled, reached, frame, drain, measured: () => measured };
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
