import { describe, expect, it } from "vitest";
import { FJORD } from "../app/lib/fjord.js";

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((k) => {
    const c = Number.parseInt(hex.slice(k, k + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

describe.each(Object.entries(FJORD))("log colours, %s", (_, scheme) => {
  it("reads each of the 16, dim and inverse at 4.5:1 on the log's panel", () => {
    expect(scheme.ansi).toHaveLength(16);
    for (const [k, colour] of scheme.ansi.entries())
      expect(contrast(colour, scheme.page.panel), `ansi ${k}`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(scheme.page.muted, scheme.page.panel)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(scheme.page.panel, scheme.page.fg)).toBeGreaterThanOrEqual(4.5);
  });
});
