/*
 * A job's matrix expanded into its combinations, by GitHub's documented
 * rules: the first key varies slowest, `exclude` removes every combination
 * it matches partially, then each `include` entry is added to every
 * original combination it does not contradict, or becomes a combination of
 * its own. Keys are matched ignoring case; values as the expression
 * language's `==` compares them, so a matrix agrees with
 * `${{ matrix.x == 'y' }}`.
 *
 * Every cost is bounded before it is paid: the number of combinations and
 * the keys they hold are checked before any is built, and matching is
 * charged as work units against a limit.
 */
import { ErrorList } from "./error-list.js";
import { foldKey, looseEquals } from "./matrix-language.js";
import type { Matrix, Position, Text, Value, Valued, WorkflowError } from "./workflow-schema.js";

export type MatrixScalar = null | boolean | number | string;
export type MatrixValue = MatrixScalar | MatrixArray | MatrixObject;

export interface MatrixArray {
  readonly kind: "array";
  readonly items: readonly MatrixValue[];
}

export interface MatrixObject {
  readonly kind: "object";
  readonly entries: ReadonlyMap<string, MatrixValue>;
}

/** Where a part of the matrix came from, for its errors. */
interface Located {
  readonly at: Position;
  /** Such as `jobs.build.strategy.matrix.include[0].os`. */
  readonly path: string;
}

export interface MatrixDimension extends Located {
  readonly name: string;
  readonly values: readonly MatrixValue[];
}

export interface MatrixKey extends Located {
  readonly key: string;
  readonly value: MatrixValue;
}

/** One `include` or `exclude` entry: its keys in order. */
export interface MatrixEntry extends Located {
  readonly keys: readonly MatrixKey[];
}

/** A matrix ready to expand: literal, or evaluated when its job became ready. */
export interface MatrixSpec extends Located {
  readonly dimensions: readonly MatrixDimension[];
  readonly include: readonly MatrixEntry[];
  readonly exclude: readonly MatrixEntry[];
}

export interface MatrixCombination {
  /** Dimensions first, in matrix order, then keys `include` added, in the order first added. */
  readonly values: ReadonlyMap<string, MatrixValue>;
  /** The scalars a default job name lists: see `expandMatrix`. */
  readonly nameValues: readonly MatrixScalar[];
}

export type ExpandedMatrix =
  | {
      readonly ok: true;
      readonly combinations: readonly MatrixCombination[];
      readonly units: number;
    }
  | { readonly ok: false; readonly errors: readonly WorkflowError[]; readonly units: number };

export type LiteralMatrix =
  | { readonly kind: "spec"; readonly spec: MatrixSpec }
  /** An expression somewhere in it: expanded when the job is ready. */
  | { readonly kind: "dynamic" }
  | { readonly kind: "invalid"; readonly errors: readonly WorkflowError[] };

/** GitHub's limit: "A job matrix can generate a maximum of 256 jobs per workflow run." */
export const MAX_MATRIX_COMBINATIONS = 256;
/** Keys across all combinations: 256 combinations of 64 keys. Proposed. */
export const MAX_MATRIX_ENTRIES = 16_384;
/** Work units one expansion may spend matching and naming. Proposed. */
export const MAX_MATRIX_UNITS = 2_000_000;

const MATRIX = "jobs.<job_id>.strategy.matrix";
const INCLUDE = `${MATRIX}.include`;
const EXCLUDE = `${MATRIX}.exclude`;
/** Code units of text one work unit pays for when folded or compared. */
const UNITS_TEXT = 64;

// The literal matrix -------------------------------------------------------------------

/**
 * A literal matrix as a spec, with keys that differ only in case refused,
 * positioned; or `dynamic` when a value anywhere in it holds an expression,
 * to be evaluated and expanded when the job is ready. Keys never do: the
 * parser refuses an expression in a matrix key.
 */
export function literalMatrixSpec(jobId: string, matrix: Valued<Matrix>): LiteralMatrix {
  if (matrix.kind === "expression") return { kind: "dynamic" };
  const { dimensions, include, exclude } = matrix.value;
  const lists = [include, exclude, ...dimensions.map((d) => d.values)];
  for (const list of lists) {
    if (list === undefined) continue;
    if (list.kind === "expression" || list.value.some(holdsExpression)) return { kind: "dynamic" };
  }

  const errors = new ErrorList();
  const path = `jobs.${jobId}.strategy.matrix`;
  const seen = new Map<string, string>();
  const dims: MatrixDimension[] = [];
  for (const { name, values } of dimensions) {
    const at = `${path}.${name.value}`;
    if (!unique(seen, name, at, MATRIX, errors)) continue;
    const items = values.kind === "literal" ? values.value : [];
    dims.push({
      name: name.value,
      values: items.map((v, i) => convert(v, `${at}[${i}]`, MATRIX, errors)),
      at: name.at,
      path: at,
    });
  }
  const entries = (list: Valued<readonly Value[]> | undefined, key: string, feature: string) =>
    (list?.kind === "literal" ? list.value : []).map((item, i): MatrixEntry => {
      const at = `${path}.${key}[${i}]`;
      const keys: MatrixKey[] = [];
      const seenKeys = new Map<string, string>();
      if (item.kind === "mapping") {
        for (const [k, v] of item.entries) {
          const keyPath = `${at}.${k.value}`;
          if (!unique(seenKeys, k, keyPath, feature, errors)) continue;
          keys.push({
            key: k.value,
            value: convert(v, keyPath, feature, errors),
            at: k.at,
            path: keyPath,
          });
        }
      }
      return { keys, at: item.at, path: at };
    });
  const spec: MatrixSpec = {
    dimensions: dims,
    include: entries(include, "include", INCLUDE),
    exclude: entries(exclude, "exclude", EXCLUDE),
    at: matrix.at,
    path,
  };
  return errors.any() ? { kind: "invalid", errors: errors.list() } : { kind: "spec", spec };
}

/** True when a scalar anywhere in `value` holds `${{` (the parser refuses one in a key). */
function holdsExpression(value: Value): boolean {
  const stack: Value[] = [value];
  while (stack.length > 0) {
    const v = stack.pop() as Value;
    if (v.kind === "scalar") {
      if (typeof v.value === "string" && v.value.includes("${{")) return true;
    } else if (v.kind === "sequence") {
      stack.push(...v.items);
    } else {
      for (const [, item] of v.entries) stack.push(item);
    }
  }
  return false;
}

/** Records `key` under its fold, or reports it as a duplicate of an earlier spelling. */
function unique(
  seen: Map<string, string>,
  key: Text,
  path: string,
  feature: string,
  errors: ErrorList,
): boolean {
  const folded = foldKey(key.value);
  const first = seen.get(folded);
  if (first === undefined) {
    seen.set(folded, key.value);
    return true;
  }
  errors.add(
    "duplicate_key",
    feature,
    path,
    key.at,
    `Matrix keys ignore case, so \`${key.value}\` is the same key as \`${first}\`.`,
  );
  return false;
}

/** A positioned YAML value as matrix data, checking nested keys and numbers. */
function convert(value: Value, path: string, feature: string, errors: ErrorList): MatrixValue {
  switch (value.kind) {
    case "scalar":
      // The parser has already refused numbers that are not finite.
      return value.value;
    case "sequence":
      return {
        kind: "array",
        items: value.items.map((item, i) => convert(item, `${path}[${i}]`, feature, errors)),
      };
    case "mapping": {
      const seen = new Map<string, string>();
      const entries = new Map<string, MatrixValue>();
      for (const [key, item] of value.entries) {
        const keyPath = `${path}.${key.value}`;
        if (!unique(seen, key, keyPath, feature, errors)) continue;
        entries.set(key.value, convert(item, keyPath, feature, errors));
      }
      return { kind: "object", entries };
    }
  }
}

// Expansion ---------------------------------------------------------------------------

class OutOfWork {}

class Work {
  units = 0;
  /** Folded-key indexes of the objects matched in this expansion. */
  readonly indexes = new Map<MatrixObject, Map<string, MatrixValue>>();
  constructor(readonly limit: number) {}

  charge(units: number): void {
    this.units += units;
    if (this.units > this.limit) throw new OutOfWork();
  }

  text(text: string): void {
    this.charge(1 + Math.floor(text.length / UNITS_TEXT));
  }
}

/** A combination being built: entries by folded key, in insertion order. */
type Building = Map<string, { key: string; value: MatrixValue }>;

/**
 * The combinations of `spec`, or every reason it has none.
 *
 * Default name values: for an original combination, the scalars of each
 * dimension's value in dimension order (objects' in key order, arrays' in
 * index order); keys `include` added are not listed. For a combination
 * `include` created, its dimension keys first, then its other keys, in the
 * entry's order.
 */
export function expandMatrix(spec: MatrixSpec, limit = MAX_MATRIX_UNITS): ExpandedMatrix {
  const work = new Work(limit);
  try {
    return expand(spec, work);
  } catch (e) {
    if (!(e instanceof OutOfWork)) throw e;
    const errors = new ErrorList();
    errors.add(
      "limit_exceeded",
      MATRIX,
      spec.path,
      spec.at,
      `Expanding this matrix needs more than ${limit} units of work; make its values or its \`include\` and \`exclude\` entries smaller.`,
    );
    return { ok: false, errors: errors.list(), units: work.units };
  }
}

function expand(spec: MatrixSpec, work: Work): ExpandedMatrix {
  const errors = new ErrorList();
  const fail = (): ExpandedMatrix => ({ ok: false, errors: errors.list(), units: work.units });
  const { dimensions: dims, include, exclude } = spec;

  if (dims.length === 0 && include.length === 0) {
    errors.add(
      "invalid_value",
      MATRIX,
      spec.path,
      spec.at,
      "A matrix needs at least one key with values, or an `include` entry.",
    );
    return fail();
  }
  for (const dim of dims) {
    if (dim.values.length > 0) continue;
    errors.add(
      "invalid_value",
      MATRIX,
      dim.path,
      dim.at,
      `Matrix key \`${dim.name}\` has no values; give it at least one.`,
    );
  }
  if (errors.any()) return fail();

  // The product and the keys it would hold, before anything is built.
  let product = 1;
  for (const [i, dim] of dims.entries()) {
    product *= dim.values.length;
    if (product <= MAX_MATRIX_COMBINATIONS) continue;
    errors.add(
      "limit_exceeded",
      MATRIX,
      dim.path,
      dim.at,
      `A matrix may have at most ${MAX_MATRIX_COMBINATIONS} combinations; ${listed(dims.slice(0, i + 1).map((d) => `\`${d.name}\``))} ${i === 0 ? "makes" : "make"} at least ${product}.`,
    );
    return fail();
  }
  let entries = dims.length === 0 ? 0 : product * dims.length;
  const tooManyEntries = (count: number): ExpandedMatrix => {
    errors.add(
      "limit_exceeded",
      MATRIX,
      spec.path,
      spec.at,
      `A matrix may hold at most ${MAX_MATRIX_ENTRIES} keys across its combinations; this one would hold at least ${count}.`,
    );
    return fail();
  };
  if (entries > MAX_MATRIX_ENTRIES) return tooManyEntries(entries);

  // Each name folded once; the combinations reuse the folds.
  const folds: string[] = [];
  const declared = new Map<string, number>();
  for (const [i, dim] of dims.entries()) {
    work.text(dim.name);
    folds.push(foldKey(dim.name));
    declared.set(folds[i] as string, i);
  }
  /** A key folded once (charged), and the dimension it names, if any. */
  const resolve = (key: MatrixKey) => {
    work.text(key.key);
    const fold = foldKey(key.key);
    return { key, fold, d: declared.get(fold) };
  };

  const excludes = exclude.map((entry) =>
    entry.keys.map((key) => {
      const { d } = resolve(key);
      if (d === undefined) {
        errors.add(
          "invalid_value",
          EXCLUDE,
          key.path,
          key.at,
          `\`${key.key}\` in \`exclude\` names no key of this matrix.`,
        );
      }
      return { d: d ?? -1, filter: key.value };
    }),
  );
  if (errors.any()) return fail();

  // Original combinations, by dimension value index, after `exclude`.
  const originals: { picks: number[]; building: Building }[] = [];
  if (dims.length > 0) {
    for (let ordinal = 0; ordinal < product; ordinal++) {
      const picks: number[] = [];
      let stride = product;
      for (const dim of dims) {
        stride /= dim.values.length;
        picks.push(Math.floor(ordinal / stride) % dim.values.length);
      }
      const valueAt = (d: number) => dims[d]?.values[picks[d] as number] as MatrixValue;
      const excluded = excludes.some((filters) => {
        work.charge(1);
        return filters.every(({ d, filter }) => matches(valueAt(d), filter, work));
      });
      if (excluded) continue;
      const building: Building = new Map();
      dims.forEach((dim, d) => {
        work.charge(1);
        building.set(folds[d] as string, { key: dim.name, value: valueAt(d) });
      });
      originals.push({ picks, building });
    }
  }

  // `include`: added to each original it does not contradict, or a combination of its own.
  const extras: { building: Building; order: { key: MatrixKey }[] }[] = [];
  for (const entry of include) {
    const split = entry.keys.map(resolve);
    const filters = split.filter((k) => k.d !== undefined);
    const others = split.filter((k) => k.d === undefined);
    let matched = false;
    for (const original of originals) {
      work.charge(1);
      const fits = filters.every(({ key, d }) =>
        matches(
          dims[d as number]?.values[original.picks[d as number] as number] as MatrixValue,
          key.value,
          work,
        ),
      );
      if (!fits) continue;
      matched = true;
      for (const { key, fold } of others) {
        work.charge(1);
        const existing = original.building.get(fold);
        if (existing) {
          existing.value = key.value;
          continue;
        }
        original.building.set(fold, { key: key.key, value: key.value });
        entries++;
        if (entries > MAX_MATRIX_ENTRIES) return tooManyEntries(entries);
      }
    }
    if (matched) continue;
    if (entry.keys.length === 0) {
      errors.add(
        "invalid_value",
        INCLUDE,
        entry.path,
        entry.at,
        "This `include` entry has no keys, so it would add a combination with none; give it at least one key.",
      );
      continue;
    }
    const order = [...filters, ...others];
    const building: Building = new Map();
    for (const { key, fold, d } of order) {
      work.charge(1);
      const spelling = d === undefined ? key.key : (dims[d]?.name as string);
      building.set(fold, { key: spelling, value: key.value });
    }
    entries += building.size;
    if (entries > MAX_MATRIX_ENTRIES) return tooManyEntries(entries);
    extras.push({ building, order });
  }
  if (errors.any()) return fail();

  const total = originals.length + extras.length;
  if (total > MAX_MATRIX_COMBINATIONS) {
    errors.add(
      "limit_exceeded",
      MATRIX,
      spec.path,
      spec.at,
      `A matrix may have at most ${MAX_MATRIX_COMBINATIONS} combinations; this one has ${total} after \`include\`.`,
    );
    return fail();
  }
  if (total === 0) {
    errors.add(
      "invalid_value",
      MATRIX,
      spec.path,
      spec.at,
      "Every combination of this matrix is excluded, so the job would have nothing to run. To skip the job on purpose, use the job's `if:`.",
    );
    return fail();
  }

  const combinations: MatrixCombination[] = [];
  for (const { picks, building } of originals) {
    const nameValues: MatrixScalar[] = [];
    dims.forEach((dim, d) => {
      scalarsOf(dim.values[picks[d] as number] as MatrixValue, nameValues, work);
    });
    combinations.push({ values: finish(building), nameValues });
  }
  for (const { building, order } of extras) {
    const nameValues: MatrixScalar[] = [];
    for (const { key } of order) scalarsOf(key.value, nameValues, work);
    combinations.push({ values: finish(building), nameValues });
  }
  return { ok: true, combinations, units: work.units };
}

function finish(building: Building): ReadonlyMap<string, MatrixValue> {
  return new Map([...building.values()].map(({ key, value }) => [key, value]));
}

/** The scalars of `value` in order: objects' values in key order, arrays' in index order. */
function scalarsOf(value: MatrixValue, out: MatrixScalar[], work: Work): void {
  work.charge(1);
  if (value === null || typeof value !== "object") {
    out.push(value);
    return;
  }
  const items = value.kind === "array" ? value.items : value.entries.values();
  for (const item of items) scalarsOf(item, out, work);
}

/**
 * Whether `value` matches `filter` partially: an object filter when each of
 * its keys matches (a key the value lacks reads as null), an array filter
 * index by index, a scalar with the language's `==`. Two containers are
 * never compared with `==`, which would only test identity.
 */
function matches(value: MatrixValue, filter: MatrixValue, work: Work): boolean {
  work.charge(1);
  if (filter !== null && typeof filter === "object") {
    if (filter.kind === "object") {
      const object =
        value !== null && typeof value === "object" && value.kind === "object" ? value : undefined;
      for (const [key, item] of filter.entries) {
        const found = object ? lookup(object, key, work) : undefined;
        if (!matches(found ?? null, item, work)) return false;
      }
      return true;
    }
    const array =
      value !== null && typeof value === "object" && value.kind === "array" ? value : undefined;
    for (const [i, item] of filter.items.entries()) {
      if (!matches(array?.items[i] ?? null, item, work)) return false;
    }
    return true;
  }
  if (typeof value === "string") work.text(value);
  if (typeof filter === "string") work.text(filter);
  return looseEquals(value, filter);
}

/** `key` in `object` ignoring case, through an index built once per object (the first spelling wins). */
function lookup(object: MatrixObject, key: string, work: Work): MatrixValue | undefined {
  let index = work.indexes.get(object);
  if (!index) {
    index = new Map();
    for (const [k, v] of object.entries) {
      work.text(k);
      const f = foldKey(k);
      if (!index.has(f)) index.set(f, v);
    }
    work.indexes.set(object, index);
  }
  work.text(key);
  return index.get(foldKey(key));
}

/** `a`, `a and b`, `a, b and c`. */
function listed(names: readonly string[]): string {
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
