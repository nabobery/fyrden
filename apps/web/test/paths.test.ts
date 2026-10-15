import { describe, expect, it } from "vitest";
import { encodeText, withoutTrailingSlashes } from "../app/lib/types.js";

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

describe("encodeText", () => {
  it("is the UTF-8 bytes' base64, a large file's included", () => {
    for (const text of ["", "a", "héllo ✓ 𝄞", "x".repeat(0x8000 + 3), "é".repeat(2 * 1024 * 1024)])
      expect(encodeText(text)).toBe(Buffer.from(text, "utf8").toString("base64"));
  });
});
