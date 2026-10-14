import { describe, expect, it } from "vitest";
import { withoutTrailingSlashes } from "../app/lib/types.js";

describe("withoutTrailingSlashes", () => {
  it("drops every trailing slash and nothing else", () => {
    expect(withoutTrailingSlashes("docs/guide/")).toBe("docs/guide");
    expect(withoutTrailingSlashes("docs//")).toBe("docs");
    expect(withoutTrailingSlashes("docs")).toBe("docs");
    expect(withoutTrailingSlashes("///")).toBe("");
    expect(withoutTrailingSlashes("")).toBe("");
  });

  // The old regex trim takes tens of seconds on this; the deadline is far below that.
  it("takes linear time on many slashes that do not end the path", { timeout: 2_000 }, () => {
    const path = `${"/".repeat(200_000)}x`;
    expect(withoutTrailingSlashes(path)).toBe(path);
  });
});
