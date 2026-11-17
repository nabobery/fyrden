import {
  type ExprValue,
  exprArray,
  exprObject,
  type JobInstance,
  type MatrixValue,
} from "@fyrden/domain/ci";

/*
 * Expression values as stored text. `writeJson` is GitHub's `toJSON` (numbers
 * as 15 significant digits), so it would change a matrix value such as
 * 1.2345678901234567 between expansion and the payload; this codec keeps
 * every value and the key order exactly.
 */

type Encoded =
  | null
  | boolean
  | number
  | string
  | { readonly a: readonly Encoded[] }
  | { readonly o: readonly (readonly [string, Encoded])[] };

function encode(value: ExprValue): Encoded {
  if (value === null || typeof value !== "object") return value;
  if (value.kind === "array") return { a: value.items.map(encode) };
  return { o: [...value.entries].map(([key, item]) => [key, encode(item)] as const) };
}

function decode(value: Encoded): ExprValue {
  if (value === null || typeof value !== "object") return value;
  if ("a" in value) return { kind: "array", items: value.a.map(decode) };
  // Not exprObject: it sorts, and the order is the value's own.
  return { kind: "object", entries: new Map(value.o.map(([key, item]) => [key, decode(item)])) };
}

interface StoredInstance {
  readonly jobId: string;
  readonly index: number;
  readonly total: number;
  readonly matrix: readonly (readonly [string, Encoded])[] | null;
  readonly name: string;
  readonly runsOn: readonly string[];
  readonly timeoutMinutes?: number;
  readonly continueOnError: boolean;
}

export function encodeInstance(instance: JobInstance): string {
  const stored: StoredInstance = {
    jobId: instance.jobId,
    index: instance.index,
    total: instance.total,
    matrix: instance.matrix
      ? [...instance.matrix].map(([key, value]) => [key, encode(value)] as const)
      : null,
    name: instance.name,
    runsOn: instance.runsOn,
    ...(instance.timeoutMinutes === undefined ? {} : { timeoutMinutes: instance.timeoutMinutes }),
    continueOnError: instance.continueOnError,
  };
  return JSON.stringify(stored);
}

export function decodeInstance(text: string): JobInstance {
  const stored = JSON.parse(text) as StoredInstance;
  return {
    jobId: stored.jobId,
    index: stored.index,
    total: stored.total,
    matrix: stored.matrix
      ? new Map<string, MatrixValue>(stored.matrix.map(([key, value]) => [key, decode(value)]))
      : null,
    name: stored.name,
    runsOn: stored.runsOn,
    ...(stored.timeoutMinutes === undefined ? {} : { timeoutMinutes: stored.timeoutMinutes }),
    continueOnError: stored.continueOnError,
  };
}

/** Plain JSON data (a trigger's `github`, `inputs`, `vars`) as an expression value. */
export function exprFromJson(value: unknown): ExprValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string")
    return value;
  if (Array.isArray(value)) return exprArray(value.map(exprFromJson));
  if (typeof value === "object")
    return exprObject(
      Object.entries(value).map(([key, item]) => [key, exprFromJson(item)] as const),
    );
  throw new TypeError(`not JSON data: ${typeof value}`);
}

/** String-valued outputs as an expression object. */
export function outputsExpr(outputs: Readonly<Record<string, string>>): ExprValue {
  return exprObject(Object.entries(outputs));
}
