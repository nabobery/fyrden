// What the renderer is handed over the highlighting limits, and what it then does with it:
// the rows of a file come before any highlighting is asked for, so only the request itself,
// made to a fake pool here, shows that none is ever sent.

import { FileRenderer } from "@pierre/diffs";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_HIGHLIGHTED_BYTES,
  MAX_HIGHLIGHTED_LINES,
  rendererFile,
} from "../app/lib/file-view.js";

const given = (size: number, totalLines: number) =>
  rendererFile({ path: "a.ts", contents: "const a = 1;", cacheKey: "k", size, totalLines });

/** How many times the renderer asks a working pool to highlight `file`. */
function highlightRequests(file: ReturnType<typeof rendererFile>): number {
  const highlightFileAST = vi.fn();
  const pool = {
    isWorkingPool: () => true,
    isInitialized: () => true,
    shouldHighlightOnMainThread: () => false,
    getFileResultCache: () => undefined,
    getFileRenderOptions: () => ({ theme: "fjord", tokenizeMaxLineLength: 1_000 }),
    // One row of the rendered lines: the renderer checks each exists, and no more of it.
    getPlainFileAST: () => ({
      code: [{ type: "element", tagName: "div", properties: {}, children: [] }],
      themeStyles: "",
      baseThemeType: undefined,
    }),
    highlightFileAST,
    cleanUpTasks: () => {},
  };
  const renderer = new FileRenderer(undefined, undefined, undefined, pool as never);
  renderer.renderFile(file);
  return highlightFileAST.mock.calls.length;
}

describe("the file the renderer is given", () => {
  it("is highlighted at both limits exactly", () => {
    const file = given(MAX_HIGHLIGHTED_BYTES, MAX_HIGHLIGHTED_LINES);
    expect(file.lang).toBeUndefined();
    expect(highlightRequests(file)).toBe(1);
  });

  it("is plain text a byte over, whatever its lines", () => {
    const file = given(MAX_HIGHLIGHTED_BYTES + 1, 1);
    expect(file.lang).toBe("text");
    expect(highlightRequests(file)).toBe(0);
  });

  it("is plain text a line over, whatever its bytes", () => {
    const file = given(1, MAX_HIGHLIGHTED_LINES + 1);
    expect(file.lang).toBe("text");
    expect(highlightRequests(file)).toBe(0);
  });
});
