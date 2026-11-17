/*
 * The inputs given to a `workflow_dispatch`, checked against the inputs the
 * workflow declares. Limits and coercions follow GitHub (verified 2026-11-15,
 * https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch):
 * at most 25 inputs and 65,535 characters; the `inputs` context keeps
 * booleans and numbers typed, `github.event.inputs` holds strings.
 */
import type { DispatchInput, ScalarValue } from "./workflow-schema.js";
import { MAX_DISPATCH_INPUTS } from "./workflow-schema.js";

/**
 * GitHub's limit on a dispatch's inputs. GitHub does not say how it counts
 * characters (unverified); here it is the length of the given inputs' JSON in
 * UTF-16 code units, so defaults the workflow supplies do not count.
 */
export const MAX_DISPATCH_INPUTS_CHARS = 65_535;

export type DispatchInputValue = string | number | boolean;

export interface DispatchInputError {
  /** The input the error is about; null for the inputs as a whole. */
  readonly input: string | null;
  readonly message: string;
}

export type DispatchInputsResult =
  | {
      readonly ok: true;
      /** The `inputs` context: every declared input, typed. */
      readonly inputs: Readonly<Record<string, DispatchInputValue>>;
      /** `github.event.inputs`: every declared input, as a string. */
      readonly eventInputs: Readonly<Record<string, string>>;
    }
  | { readonly ok: false; readonly errors: readonly DispatchInputError[] };

/**
 * Checks `given` (the request's `inputs`, absent meaning none) against
 * `declared`. An absent input takes its default; a required one without a
 * default is refused. An optional absent input without a default is `false`
 * for a boolean (`"false"` in `github.event.inputs`) and `""` otherwise
 * (GitHub's value for an absent number or boolean: unverified).
 * A string or choice input takes only a string: a number or boolean given
 * for one is refused rather than guessed at.
 */
export function validateDispatchInputs(
  declared: readonly DispatchInput[],
  given: unknown,
): DispatchInputsResult {
  const raw = given === undefined ? {} : given;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return fail(null, "Inputs must be an object.");
  }
  const names = Object.keys(raw);
  if (names.length > MAX_DISPATCH_INPUTS) {
    return fail(null, `A dispatch takes at most ${MAX_DISPATCH_INPUTS} inputs.`);
  }
  if (JSON.stringify(raw).length > MAX_DISPATCH_INPUTS_CHARS) {
    return fail(null, `Inputs total at most ${MAX_DISPATCH_INPUTS_CHARS} characters.`);
  }
  const values = new Map(Object.entries(raw));
  const known = new Set(declared.map((d) => d.id.value));
  const errors: DispatchInputError[] = names
    .filter((name) => !known.has(name))
    .map((name) => ({ input: name, message: `The workflow has no input \`${name}\`.` }));
  const inputs: [string, DispatchInputValue][] = [];
  const eventInputs: [string, string][] = [];
  for (const input of declared) {
    const name = input.id.value;
    // A default of the wrong type is the workflow's error, whatever the request gives.
    const fallback =
      input.default !== undefined && input.default.value !== null
        ? coerce(input, defaultValue(input, input.default))
        : null;
    if (fallback === undefined) {
      errors.push({ input: name, message: expected(input, "The default of input") });
      continue;
    }
    let value: DispatchInputValue | undefined;
    if (values.has(name)) {
      value = coerce(input, values.get(name));
      if (value === undefined) errors.push({ input: name, message: expected(input, "Input") });
    } else if (fallback !== null) {
      value = fallback;
    } else if (input.required) {
      errors.push({ input: name, message: `Input \`${name}\` is required.` });
    } else {
      value = input.type === "boolean" ? false : "";
    }
    if (value === undefined) continue;
    inputs.push([name, value]);
    eventInputs.push([name, String(value)]);
  }
  if (errors.length > 0) return { ok: false, errors };
  // `fromEntries` defines own properties, so a name like `__proto__` stays data.
  return {
    ok: true,
    inputs: Object.fromEntries(inputs),
    eventInputs: Object.fromEntries(eventInputs),
  };
}

function fail(input: string | null, message: string): DispatchInputsResult {
  return { ok: false, errors: [{ input, message }] };
}

/** A string or choice default written unquoted (`1.0`, `true`) is its text. */
function defaultValue(input: DispatchInput, value: ScalarValue): unknown {
  return (input.type === "string" || input.type === "choice") && typeof value.value !== "string"
    ? value.source
    : value.value;
}

const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** The typed value of `value` for `input`, or undefined when it does not fit. */
function coerce(input: DispatchInput, value: unknown): DispatchInputValue | undefined {
  switch (input.type) {
    case "boolean":
      if (typeof value === "boolean") return value;
      return value === "true" ? true : value === "false" ? false : undefined;
    case "number": {
      if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
      if (typeof value !== "string" || !DECIMAL.test(value.trim())) return undefined;
      const n = Number(value.trim());
      return Number.isFinite(n) ? n : undefined;
    }
    case "choice":
      return typeof value === "string" && input.options.some((o) => o.value === value)
        ? value
        : undefined;
    case "string":
      return typeof value === "string" ? value : undefined;
  }
}

function expected(input: DispatchInput, subject: string): string {
  const what = `${subject} \`${input.id.value}\``;
  switch (input.type) {
    case "boolean":
      return `${what} must be true or false.`;
    case "number":
      return `${what} must be a number.`;
    case "choice":
      return `${what} must be one of ${input.options.map((o) => `\`${o.value}\``).join(", ")}.`;
    case "string":
      return `${what} must be a string.`;
  }
}
