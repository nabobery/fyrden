import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ASSET_CONTENT_TYPE_DEFAULT,
  assetContentType,
  assetName,
  MAX_ASSET_NAME_BYTES,
} from "../../src/releases/assets.js";

const bytes = (text: string) => new TextEncoder().encode(text).length;

describe("asset names", () => {
  it("takes an ordinary name, folded for comparison", () => {
    expect(assetName("Fyrden-1.0.tar.gz")).toEqual({
      ok: true,
      name: "Fyrden-1.0.tar.gz",
      fold: "fyrden-1.0.tar.gz",
    });
  });

  it("stores and compares the NFC form", () => {
    const decomposed = "Café.zip";
    expect(assetName(decomposed)).toEqual({ ok: true, name: "Café.zip", fold: "café.zip" });
    expect(assetName("CAFÉ.zip")).toMatchObject({ fold: "café.zip" });
  });

  it("counts UTF-8 bytes, after normalizing, up to the limit", () => {
    expect(MAX_ASSET_NAME_BYTES).toBe(255);
    expect(assetName("a".repeat(255)).ok).toBe(true);
    expect(assetName("a".repeat(256)).ok).toBe(false);
    // 127 two-byte characters and one byte: 255; one more byte is over.
    expect(assetName(`${"é".repeat(127)}a`).ok).toBe(true);
    expect(assetName(`${"é".repeat(127)}ab`).ok).toBe(false);
    // Decomposed, three bytes a character; composed, two: it is the stored form that counts.
    expect(assetName("é".repeat(127)).ok).toBe(true);
  });

  it("refuses empty, dot names, separators and control characters", () => {
    for (const name of [
      "",
      ".",
      "..",
      "a/b",
      "a\\b",
      "a\u0000b",
      "a\nb",
      "a\rb",
      "a\u007fb",
      "a\u0085b",
      "\t",
    ])
      expect(assetName(name)).toMatchObject({ ok: false });
  });

  it("takes names that only contain dots or start with one", () => {
    expect(assetName("...").ok).toBe(true);
    expect(assetName(".hidden").ok).toBe(true);
    expect(assetName("a..b").ok).toBe(true);
  });

  it("refuses a lone surrogate, which has no UTF-8 form", () => {
    expect(assetName("a\ud800.zip").ok).toBe(false);
    expect(assetName("\udc00").ok).toBe(false);
  });

  it("never takes a name that could split a header or a path", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 300 }), (raw) => {
        const result = assetName(raw);
        if (!result.ok) return;
        expect(result.name).toBe(result.name.normalize("NFC"));
        expect(result.name.isWellFormed()).toBe(true);
        expect(bytes(result.name)).toBeGreaterThan(0);
        expect(bytes(result.name)).toBeLessThanOrEqual(MAX_ASSET_NAME_BYTES);
        expect(result.name).not.toMatch(/[\p{Cc}/\\]/u);
        expect([".", ".."]).not.toContain(result.name);
        expect(result.fold).toBe(result.name.toLowerCase());
      }),
    );
  });

  it("is stable: a taken name is taken again as itself", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 80 }), (raw) => {
        const first = assetName(raw);
        if (!first.ok) return;
        expect(assetName(first.name)).toEqual(first);
      }),
    );
  });
});

describe("asset content types", () => {
  it("defaults to application/octet-stream", () => {
    expect(ASSET_CONTENT_TYPE_DEFAULT).toBe("application/octet-stream");
    expect(assetContentType(undefined)).toEqual({ ok: true, type: "application/octet-stream" });
  });

  it("takes a type and subtype as declared, lowercased", () => {
    expect(assetContentType("application/gzip")).toEqual({ ok: true, type: "application/gzip" });
    expect(assetContentType("Application/VND.Debian.Binary-Package")).toEqual({
      ok: true,
      type: "application/vnd.debian.binary-package",
    });
    expect(assetContentType("image/svg+xml")).toEqual({ ok: true, type: "image/svg+xml" });
  });

  it("refuses anything but a bare media type", () => {
    for (const type of [
      "",
      "text",
      "text/",
      "/plain",
      "text/plain; charset=utf-8",
      "text/plain\r\nX-Evil: 1",
      "text /plain",
      "text/pla in",
      "a/b/c",
      "té/xt",
      `${"a".repeat(128)}/b`,
    ])
      expect(assetContentType(type)).toMatchObject({ ok: false });
  });

  it("never takes a value that could split a header", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 80 }), (raw) => {
        const result = assetContentType(raw);
        if (result.ok) expect(result.type).toMatch(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/);
      }),
    );
  });
});
