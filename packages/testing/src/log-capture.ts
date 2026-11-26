import { inspect } from "node:util";
import { mentionsToken } from "@fyrden/domain";
import { afterEach, beforeEach, expect, type MockInstance, vi } from "vitest";

// Rendered the way console would print it, so nothing an argument carries is
// hidden from the leak check: JSON.stringify turns an Error into "{}" and
// drops its cause and extra properties.
const INSPECT = { depth: Number.POSITIVE_INFINITY, breakLength: Number.POSITIVE_INFINITY };
const render = (a: unknown): string => (typeof a === "string" ? a : inspect(a, INSPECT));

export interface CapturedLogs {
  readonly lines: string[];
  entries(): Record<string, unknown>[];
}

const secretValues = new Set<string>();

/**
 * Registers a value a test made up as a secret: from now on, any log line
 * holding it fails the test it was logged in. Returns the value.
 */
export function registerSecretValue(value: string): string {
  if (value !== "") secretValues.add(value);
  return value;
}

function stringsOf(value: unknown, out: string[]): string[] {
  if (typeof value === "string") out.push(value);
  else if (value !== null && typeof value === "object")
    for (const v of Object.values(value)) stringsOf(v, out);
  return out;
}

/**
 * Each registered value as itself, JSON-escaped (the logger writes JSON: line
 * breaks, quotes) and escaped as `render` prints a string inside an object.
 */
function secretForms(): string[] {
  const forms = new Set<string>();
  for (const value of secretValues) {
    forms.add(value);
    forms.add(JSON.stringify(value).slice(1, -1));
    forms.add(inspect(value, INSPECT).slice(1, -1));
  }
  return [...forms];
}

/**
 * Whether a captured line holds any of `forms`: in the line or, for a line
 * that is JSON, in any of its decoded string fields (a field that holds JSON
 * again).
 */
function holdsAny(line: string, forms: readonly string[]): boolean {
  if (forms.length === 0) return false;
  const texts = [line];
  try {
    stringsOf(JSON.parse(line), texts);
  } catch {
    // Not JSON: the line alone.
  }
  return texts.some((t) => forms.some((f) => t.includes(f)));
}

/**
 * Captures console output for every test in the file and fails the test if
 * any line contains a token in plain or encoded form, or a value registered
 * with `registerSecretValue` (as itself or JSON-escaped, in the line or in
 * a JSON line's decoded string fields). Call once at the top level of a
 * setup file or test file.
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
    const forms = secretForms();
    const secrets = lines.filter((line) => holdsAny(line, forms));
    for (const spy of spies) spy.mockRestore();
    expect(leaked, "a log line contains an unredacted token").toEqual([]);
    // The lines are not shown: they hold the value.
    expect(secrets.length, "a log line contains a registered secret value").toBe(0);
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
