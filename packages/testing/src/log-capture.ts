import { inspect } from "node:util";
import { mentionsToken } from "@fyrden/domain";
import { afterEach, beforeEach, expect, type MockInstance, vi } from "vitest";

// Rendered the way console would print it, so nothing an argument carries is
// hidden from the leak check: JSON.stringify turns an Error into "{}" and
// drops its cause and extra properties.
const render = (a: unknown): string =>
  typeof a === "string"
    ? a
    : inspect(a, { depth: Number.POSITIVE_INFINITY, breakLength: Number.POSITIVE_INFINITY });

export interface CapturedLogs {
  /** Every line written through console.* during the current test. */
  readonly lines: string[];
  /** Parsed JSON log entries written during the current test. */
  entries(): Record<string, unknown>[];
}

/**
 * Captures console output for every test in the file and fails the test if
 * any line contains a token in plain or encoded form. Call once at the top
 * level of a setup file or test file.
 */
export function installLogCapture(): CapturedLogs {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  let spies: MockInstance[] = [];
  beforeEach(() => {
    lines.length = 0;
    spies = methods.map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(render).join(" "));
      }),
    );
  });
  afterEach(() => {
    // Plain, percent-encoded and base64 forms all count as a leak.
    const leaked = lines.filter(mentionsToken);
    for (const spy of spies) spy.mockRestore();
    expect(leaked, "a log line contains an unredacted token").toEqual([]);
  });
  return {
    lines,
    entries: () =>
      lines.flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      }),
  };
}
