// A renderer only logs a file's highlighting failure: each one it connects steps the session
// down, the file view's renderer as much as the diff view's.

import { FileRenderer } from "@pierre/diffs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type HighlighterChoice,
  highlighterChoice,
  stepDownOnFailure,
} from "../app/components/diff/highlighter.js";

const done = async () => {};

/** Settles once `choice` has reached `step`: the failure handlers return nothing to wait on. */
const reached = (choice: HighlighterChoice, step: number) =>
  new Promise<void>((done) => {
    const check = () => {
      if (choice.current()?.step === step) done();
    };
    choice.subscribe(check);
    check();
  });

class Renderer {
  logged: unknown[] = [];
  cleanedUp = 0;
  cleanUp() {
    this.cleanedUp++;
  }
  onHighlightError(error: unknown) {
    this.logged.push(error);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a renderer's highlighting failure", () => {
  it("steps the session down, and is still logged", async () => {
    const choice = highlighterChoice({ teardown: done, prepare: done });
    choice.choose(true);
    stepDownOnFailure(Renderer, choice);
    const renderer = new Renderer();
    const failure = new Error("no such lexer");
    renderer.onHighlightError(failure);
    expect(renderer.logged).toEqual([failure]);
    await reached(choice, 1);
  });

  it("is not the current step's once the renderer has left the page", async () => {
    const choice = highlighterChoice({ teardown: done, prepare: done });
    choice.choose(true);
    class Left extends Renderer {}
    stepDownOnFailure(Left, choice);
    const renderer = new Left();
    renderer.cleanUp();
    expect(renderer.cleanedUp).toBe(1);
    renderer.onHighlightError(new Error("late"));
    expect(choice.current()?.step).toBe(0);
  });

  it("reaches the file view's own renderer", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const choice = highlighterChoice({ teardown: done, prepare: done });
    choice.choose(true);
    stepDownOnFailure(FileRenderer as never, choice);
    new FileRenderer().onHighlightError(new Error("no such lexer"));
    await reached(choice, 1);
  });
});
