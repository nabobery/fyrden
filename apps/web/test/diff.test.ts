// A pull request file's hunks as the diff renderer reads them: the lines
// each side shows, the file named from the listing (never parsed out of
// patch text), and hostile file names and lines drawn as text.

import { preloadDiffHTML } from "@pierre/diffs/ssr";
import { describe, expect, it } from "vitest";
import { fileDiffOf } from "../app/components/diff/file-diff.js";
import { changeType, isShown, shownLines } from "../app/components/diff/patch.js";
import { HOSTILE } from "./helpers/render.js";

const HUNKS =
  "@@ -1,3 +1,4 @@\n a\n-b\n+B\n+C\n c\n@@ -10 +11,0 @@\n-gone\n@@ -20,0 +21 @@\n+new\n";

describe("the lines a file's hunks show", () => {
  it("are each hunk's range on each side, a count left out meaning one", () => {
    const shown = shownLines(HUNKS);
    expect(shown).toEqual({
      LEFT: [
        [1, 3],
        [10, 10],
      ],
      RIGHT: [
        [1, 4],
        [21, 21],
      ],
    });
    expect(isShown(shown, "RIGHT", 4)).toBe(true);
    expect(isShown(shown, "RIGHT", 5)).toBe(false);
    expect(isShown(shown, "LEFT", 10)).toBe(true);
    expect(isShown(shown, "LEFT", 21)).toBe(false);
  });

  it("are none for an empty patch, and ignore a line that only looks like a header", () => {
    expect(shownLines("")).toEqual({ LEFT: [], RIGHT: [] });
    expect(shownLines("@@ -1 +1 @@\n-@@ -5,2 +5,2 @@\n+x\n").LEFT).toEqual([[1, 1]]);
  });
});

describe("a file for the renderer", () => {
  it("keeps every hunk, and takes its name and kind from the listing", () => {
    const diff = fileDiffOf(
      HUNKS,
      { path: "dir/new name.ts", previousPath: "old.ts", status: "renamed" },
      "k",
    );
    expect(diff?.hunks).toHaveLength(3);
    expect(diff?.name).toBe("dir/new name.ts");
    expect(diff?.prevName).toBe("old.ts");
    expect(diff?.type).toBe("rename-changed");
    expect(diff?.cacheKey).toBe("k");
  });

  it("never reads a name out of patch text", () => {
    // A hunk line that looks like a file header is a removed line, not a name.
    const diff = fileDiffOf(
      "@@ -1 +1 @@\n---- a/evil\n++++ b/evil\n",
      { path: "x", status: "modified" },
      "k",
    );
    expect(diff?.name).toBe("x");
    expect(diff?.prevName).toBeUndefined();
    expect(diff?.hunks).toHaveLength(1);
  });

  it("maps the API's statuses to the renderer's kinds", () => {
    expect(changeType("added", true)).toBe("new");
    expect(changeType("removed", true)).toBe("deleted");
    expect(changeType("renamed", false)).toBe("rename-pure");
    expect(changeType("modified", true)).toBe("change");
    expect(changeType("changed", false)).toBe("change");
  });

  it("draws hostile lines and file names as text", async () => {
    const hostile = `@@ -1,2 +1,2 @@\n-${HOSTILE}\n+</code></pre>${HOSTILE}\n ${"<svg onload=alert(6)>"}\n`;
    for (const path of [`${HOSTILE}.html`, "safe.js"]) {
      const fileDiff = fileDiffOf(hostile, { path, previousPath: HOSTILE, status: "renamed" }, "k");
      if (!fileDiff) throw new Error("not parsed");
      const html = await preloadDiffHTML({
        fileDiff,
        options: {
          preferredHighlighter: "shiki-js",
          theme: { dark: "pierre-dark", light: "pierre-light" },
        },
      });
      // The renderer's own markup has its styles and icons; nothing from the patch adds a tag
      // or an attribute: every `<` of it is escaped.
      expect(html, path).toContain("&#x3C;script>alert(1)&#x3C;/script>&#x3C;img src=x");
      expect(html, path).toContain("&#x3C;svg onload=alert(6)>");
      expect(html, path).not.toMatch(/<(script|img|iframe|object|embed)\b/i);
      expect(html, path).not.toMatch(/<svg onload/i);
      expect(html, path).not.toMatch(/<[a-z][^<>]*\son[a-z]+=/i);
    }
  });
});
