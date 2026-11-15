// Inputs given to a `workflow_dispatch`, checked against the inputs the
// workflow declares: typed for the `inputs` context, strings for
// `github.event.inputs`.
import { describe, expect, it } from "vitest";
import { validateDispatchInputs } from "../../src/ci/dispatch-inputs.js";
import type {
  DispatchInput,
  DispatchInputType,
  ScalarValue,
} from "../../src/ci/workflow-schema.js";

const at = { line: 1, column: 1 };

function scalar(value: string | number | boolean | null, source = String(value)): ScalarValue {
  return { kind: "scalar", value, source, at };
}

function declare(
  id: string,
  type: DispatchInputType,
  options: { required?: boolean; default?: ScalarValue; options?: string[] } = {},
): DispatchInput {
  return {
    id: { value: id, at },
    required: options.required ?? false,
    type,
    options: (options.options ?? []).map((value) => ({ value, at })),
    ...(options.default && { default: options.default }),
  };
}

const ok = (declared: readonly DispatchInput[], given: unknown) => {
  const result = validateDispatchInputs(declared, given);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result;
};

const errors = (declared: readonly DispatchInput[], given: unknown) => {
  const result = validateDispatchInputs(declared, given);
  if (result.ok) throw new Error("expected errors");
  return result.errors;
};

describe("validateDispatchInputs", () => {
  it("accepts no inputs for a workflow that declares none", () => {
    expect(ok([], {})).toStrictEqual({ ok: true, inputs: {}, eventInputs: {} });
    expect(ok([], undefined)).toStrictEqual({ ok: true, inputs: {}, eventInputs: {} });
  });

  it("refuses inputs that are not an object", () => {
    for (const given of [null, [], "x", 1, true]) {
      expect(errors([], given)).toStrictEqual([
        { input: null, message: "Inputs must be an object." },
      ]);
    }
  });

  it("refuses an input the workflow does not declare", () => {
    expect(errors([declare("a", "string")], { a: "1", b: "2" })).toStrictEqual([
      { input: "b", message: "The workflow has no input `b`." },
    ]);
  });

  it("does not treat inherited names as declared", () => {
    expect(errors([], JSON.parse('{"__proto__": "x"}'))).toStrictEqual([
      { input: "__proto__", message: "The workflow has no input `__proto__`." },
    ]);
    expect(errors([], { toString: "x" })[0]?.input).toBe("toString");
  });

  it("refuses more than 25 inputs", () => {
    const declared = Array.from({ length: 26 }, (_, i) => declare(`i${i}`, "string"));
    const given = Object.fromEntries(declared.map((d) => [d.id.value, "x"]));
    expect(
      ok(declared.slice(0, 25), Object.fromEntries(Object.entries(given).slice(0, 25))).ok,
    ).toBe(true);
    expect(errors(declared, given)).toStrictEqual([
      { input: null, message: "A dispatch takes at most 25 inputs." },
    ]);
  });

  it("refuses inputs longer than 65,535 characters as JSON", () => {
    const declared = [declare("a", "string")];
    // {"a":""} is 8 characters.
    expect(ok(declared, { a: "x".repeat(65_535 - 8) }).inputs.a).toHaveLength(65_527);
    expect(errors(declared, { a: "x".repeat(65_535 - 7) })).toStrictEqual([
      { input: null, message: "Inputs total at most 65535 characters." },
    ]);
  });

  it("refuses a required input that is absent and has no default", () => {
    expect(errors([declare("env", "string", { required: true })], {})).toStrictEqual([
      { input: "env", message: "Input `env` is required." },
    ]);
  });

  it("applies defaults to absent inputs, required or not", () => {
    const result = ok(
      [
        declare("env", "string", { required: true, default: scalar("staging") }),
        declare("debug", "boolean", { default: scalar(true) }),
        declare("level", "number", { default: scalar(3) }),
        declare("size", "choice", { default: scalar("s"), options: ["s", "m"] }),
      ],
      {},
    );
    expect(result.inputs).toStrictEqual({ env: "staging", debug: true, level: 3, size: "s" });
    expect(result.eventInputs).toStrictEqual({
      env: "staging",
      debug: "true",
      level: "3",
      size: "s",
    });
  });

  it("refuses a default of the wrong type even when the input is given", () => {
    const declared = [declare("flag", "boolean", { default: scalar("yes") })];
    expect(validateDispatchInputs(declared, { flag: true }).ok).toBe(false);
    expect(validateDispatchInputs(declared, {}).ok).toBe(false);
  });

  it("gives a given input over its default", () => {
    expect(
      ok([declare("env", "string", { default: scalar("staging") })], { env: "prod" }).inputs,
    ).toStrictEqual({ env: "prod" });
  });

  it("takes a string default written as a number or boolean as its text", () => {
    const result = ok(
      [
        declare("version", "string", { default: scalar(1, "1.0") }),
        declare("flag", "string", { default: scalar(true, "true") }),
      ],
      {},
    );
    expect(result.inputs).toStrictEqual({ version: "1.0", flag: "true" });
  });

  it("treats a null default as no default", () => {
    expect(
      errors([declare("env", "string", { required: true, default: scalar(null, "") })], {}),
    ).toStrictEqual([{ input: "env", message: "Input `env` is required." }]);
  });

  it("refuses a default of the wrong type, naming the input", () => {
    expect(
      errors(
        [
          declare("debug", "boolean", { default: scalar("yes") }),
          declare("level", "number", { default: scalar("high") }),
          declare("size", "choice", { default: scalar("xl"), options: ["s", "m"] }),
        ],
        {},
      ),
    ).toStrictEqual([
      { input: "debug", message: "The default of input `debug` must be true or false." },
      { input: "level", message: "The default of input `level` must be a number." },
      { input: "size", message: "The default of input `size` must be one of `s`, `m`." },
    ]);
  });

  it("gives an optional absent input without a default as empty, false for a boolean", () => {
    const result = ok(
      [
        declare("s", "string"),
        declare("b", "boolean"),
        declare("n", "number"),
        declare("c", "choice", { options: ["x"] }),
      ],
      {},
    );
    expect(result.inputs).toStrictEqual({ s: "", b: false, n: "", c: "" });
    expect(result.eventInputs).toStrictEqual({ s: "", b: "", n: "", c: "" });
  });

  describe("boolean", () => {
    const declared = [declare("debug", "boolean")];
    it.each([
      [true, true, "true"],
      [false, false, "false"],
      ["true", true, "true"],
      ["false", false, "false"],
    ])("accepts %j", (given, typed, text) => {
      const result = ok(declared, { debug: given });
      expect(result.inputs.debug).toBe(typed);
      expect(result.eventInputs.debug).toBe(text);
    });
    it.each([["yes"], ["True"], [1], [null], [""]])("refuses %j", (given) => {
      expect(errors(declared, { debug: given })).toStrictEqual([
        { input: "debug", message: "Input `debug` must be true or false." },
      ]);
    });
  });

  describe("number", () => {
    const declared = [declare("level", "number")];
    it.each([
      [3, 3, "3"],
      [-1.5, -1.5, "-1.5"],
      ["42", 42, "42"],
      [" 2.50 ", 2.5, "2.5"],
      ["1e3", 1000, "1000"],
    ])("accepts %j", (given, typed, text) => {
      const result = ok(declared, { level: given });
      expect(result.inputs.level).toBe(typed);
      expect(result.eventInputs.level).toBe(text);
    });
    it.each([["abc"], [""], ["  "], ["Infinity"], ["0x10"], [Number.NaN], [true], [null]])(
      "refuses %j",
      (given) => {
        expect(errors(declared, { level: given })).toStrictEqual([
          { input: "level", message: "Input `level` must be a number." },
        ]);
      },
    );
  });

  describe("choice", () => {
    const declared = [declare("size", "choice", { options: ["s", "m", "1"] })];
    it("accepts one of the options", () => {
      expect(ok(declared, { size: "m" }).inputs.size).toBe("m");
    });
    it.each([["l"], ["S"], [1]])("refuses %j", (given) => {
      expect(errors(declared, { size: given })).toStrictEqual([
        { input: "size", message: "Input `size` must be one of `s`, `m`, `1`." },
      ]);
    });
  });

  describe("string", () => {
    const declared = [declare("name", "string")];
    it("accepts any string, the empty one included", () => {
      expect(ok(declared, { name: "" }).inputs.name).toBe("");
      expect(ok(declared, { name: "a b" }).eventInputs.name).toBe("a b");
    });
    it.each([[1], [true], [null], [{}]])("refuses %j", (given) => {
      expect(errors(declared, { name: given })).toStrictEqual([
        { input: "name", message: "Input `name` must be a string." },
      ]);
    });
  });

  it("reports every input's error", () => {
    expect(
      errors([declare("a", "boolean"), declare("b", "number", { required: true })], {
        a: "x",
        c: 1,
      }),
    ).toStrictEqual([
      { input: "c", message: "The workflow has no input `c`." },
      { input: "a", message: "Input `a` must be true or false." },
      { input: "b", message: "Input `b` is required." },
    ]);
  });

  it("keeps typed inputs typed and event inputs as strings", () => {
    const result = ok([declare("debug", "boolean"), declare("level", "number")], {
      debug: "true",
      level: 2,
    });
    expect(result.inputs).toStrictEqual({ debug: true, level: 2 });
    expect(result.eventInputs).toStrictEqual({ debug: "true", level: "2" });
  });

  it("keeps an input named like an object property as data", () => {
    const result = ok([declare("__proto__", "string")], JSON.parse('{"__proto__": "x"}'));
    expect(Object.getOwnPropertyDescriptor(result.inputs, "__proto__")?.value).toBe("x");
    expect(Object.getPrototypeOf(result.inputs)).toBe(Object.prototype);
  });
});
