import {
  type Alias,
  Composer,
  type Document,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  type Node,
  Parser,
  type Scalar,
  type YAMLMap,
} from "yaml";
import { checkWorkflowExpressions, noExpressions } from "./expression-sites.js";
import {
  featureOf,
  type SupportedKey,
  type SupportedKeysOf,
  type WorkflowFeature,
} from "./support-matrix.js";
import {
  type Concurrency,
  type Condition,
  type Container,
  type Credentials,
  type DispatchInput,
  type DispatchInputType,
  type Filter,
  type Job,
  MAX_DISPATCH_INPUTS,
  MAX_JOBS,
  MAX_STEPS,
  MAX_WORKFLOW_BYTES,
  MAX_WORKFLOW_ERRORS,
  MAX_WORKFLOW_NODES,
  MAX_YAML_DEPTH,
  type Matrix,
  type Pairs,
  type ParsedWorkflow,
  PERMISSION_SCOPES,
  type PermissionScope,
  type Permissions,
  type Position,
  type RunDefaults,
  type ScalarValue,
  type Service,
  type Step,
  type Strategy,
  type Text,
  type Trigger,
  type Value,
  type Valued,
  type Workflow,
  type WorkflowError,
  type WorkflowErrorCode,
} from "./workflow-schema.js";

/*
 * A workflow file's bytes to the model in `workflow-schema.ts`, or every
 * error in it. The `yaml` library tokenizes and composes the document; the
 * parser then walks the nodes itself, never converting them to plain
 * objects, so every value keeps its position and every key is checked
 * against the support matrix.
 *
 * Three of the library's own behaviours are replaced because they are
 * superlinear or do not apply to a walk (measured on yaml 2.9.1): its
 * duplicate-key check compares each key with every earlier one, its alias
 * limit applies only to `toJS`, and its YAML 1.1 collection tags
 * (`!!omap`) check keys the same quadratic way. With those off, composing
 * is linear in the file's size as far as is known; the walk then charges
 * every node it visits (an alias's target at each use) against
 * MAX_WORKFLOW_NODES and stops at MAX_YAML_DEPTH.
 */

/** The options workflows are composed with. */
export const YAML_OPTIONS = {
  version: "1.2",
  uniqueKeys: false,
  resolveKnownTags: false,
  prettyErrors: false,
} as const;

/** Unwinds the walk once the file has too many errors or is too complex. */
class Stop extends Error {}

const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const JOB_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const CRON_FIELD =
  /^(?:\*|[0-9A-Za-z]+(?:-[0-9A-Za-z]+)?)(?:\/[0-9]+)?(?:,(?:\*|[0-9A-Za-z]+(?:-[0-9A-Za-z]+)?)(?:\/[0-9]+)?)*$/;
const REMOTE_ACTION = /^[^\s/@]+\/[^\s/@]+(?:\/[^\s@]+)?@[^\s@]+$/;

/** `path`'s workflow, or every error that stops it running. Never throws on any input. */
export function parseWorkflow(path: string, bytes: Uint8Array): ParsedWorkflow {
  if (bytes.length > MAX_WORKFLOW_BYTES) {
    return wholeFile(
      "file_too_large",
      `The file is ${bytes.length} bytes; a workflow file holds at most ${MAX_WORKFLOW_BYTES}.`,
    );
  }
  let text: string;
  try {
    text = strict.decode(bytes);
  } catch {
    return wholeFile("invalid_encoding", "A workflow file must be UTF-8.");
  }
  const lines = new LineCounter();
  // The library tokenizes and composes recursively: input nested deeply enough (a long run of
  // `- - - …`) overflows the stack there, before any bound of the parser's own applies.
  const tokens = exhaustible(() => [...new Parser(lines.addNewLine).parse(text)]);
  if (!tokens) return wholeFile("yaml_too_complex", tooComplex());
  const walk = new Walk(text, lines);
  try {
    walk.checkStream(tokens);
    if (walk.errors.length > 0) return walk.result(undefined);
    const doc = exhaustible(
      () => [...new Composer(YAML_OPTIONS).compose(tokens, true, text.length)][0],
    );
    if (!doc)
      return doc === null ? wholeFile("yaml_too_complex", tooComplex()) : walk.result(undefined);
    if (!walk.checkDiagnostics(doc)) return walk.result(undefined);
    if (!walk.resolveAnchors(doc)) return walk.result(undefined);
    const workflow = readWorkflow(walk, doc.contents, path);
    // Expressions are checked once the structure is valid: a field's site is known only then.
    if (workflow && walk.errors.length === 0) {
      for (const e of checkWorkflowExpressions(workflow)) {
        walk.fail(e.code, e.feature, e.path, { line: e.line, column: e.column }, e.message);
      }
    }
    return walk.result(workflow);
  } catch (error) {
    if (error instanceof Stop) return walk.result(undefined);
    throw error;
  }
}

/** `run()`'s result, or null when it exhausts the stack (V8 throws a RangeError). */
function exhaustible<T>(run: () => T): T | null {
  try {
    return run();
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

function wholeFile(code: WorkflowErrorCode, message: string): ParsedWorkflow {
  return { ok: false, errors: [{ code, feature: "", path: "", line: 0, column: 0, message }] };
}

/** The state of one parse: positions, errors, the node budget and the path being walked. */
class Walk {
  readonly errors: WorkflowError[] = [];
  readonly #text: string;
  readonly #lines: LineCounter;
  /** Code points before each UTF-16 offset, built only for text with astral characters. */
  #codePoints: Uint32Array | undefined;
  readonly #bom: boolean;
  #units = 0;
  #depth = 0;
  /** The nodes being read, outermost first: an alias to one of them is a cycle. */
  readonly #open = new Set<Node>();
  #aliases = new Map<Alias, Node>();
  #full = false;

  constructor(text: string, lines: LineCounter) {
    this.#text = text;
    this.#lines = lines;
    this.#bom = text.startsWith("﻿");
    if (/[\uD800-\uDFFF]/.test(text)) {
      const counts = new Uint32Array(text.length + 1);
      let n = 0;
      for (let i = 0; i < text.length; i++) {
        counts[i] = n;
        const unit = text.charCodeAt(i);
        // A high surrogate and the low one after it are one code point.
        if (!(unit >= 0xdc00 && unit <= 0xdfff && i > 0 && isHigh(text.charCodeAt(i - 1)))) n++;
      }
      counts[text.length] = n;
      this.#codePoints = counts;
    }
  }

  position(offset: number): Position {
    const { line, col } = this.#lines.linePos(offset);
    let column = col;
    if (this.#codePoints) {
      const start = this.#lines.lineStarts[line - 1] ?? 0;
      column = (this.#codePoints[offset] ?? 0) - (this.#codePoints[start] ?? 0) + 1;
    }
    // A byte order mark is not a column.
    if (line === 1 && this.#bom && column > 1) column--;
    return { line, column };
  }

  at(node: Node | null | undefined, fallback: number): Position {
    return this.position(node?.range?.[0] ?? fallback);
  }

  fail(
    code: WorkflowErrorCode,
    feature: string,
    path: string,
    where: Position,
    message: string,
  ): undefined {
    if (this.#full) throw new Stop();
    if (this.errors.length >= MAX_WORKFLOW_ERRORS) {
      this.#full = true;
      this.errors.push({
        code: "too_many_errors",
        feature: "",
        path: "",
        line: 0,
        column: 0,
        message: `The file has more than ${MAX_WORKFLOW_ERRORS} errors; the first ${MAX_WORKFLOW_ERRORS} are shown.`,
      });
      throw new Stop();
    }
    // Paths and messages can quote user keys and values: each field is cut short.
    this.errors.push({
      code,
      feature: cut(feature, MAX_ERROR_FIELD),
      path: cut(path, MAX_ERROR_FIELD),
      ...where,
      message: cut(message, 2 * MAX_ERROR_FIELD),
    });
    return undefined;
  }

  result(workflow: Workflow | undefined): ParsedWorkflow {
    if (this.errors.length === 0 && workflow) return { ok: true, workflow };
    const limited = this.errors.filter((e) => e.code !== "too_many_errors");
    limited.sort((a, b) => a.line - b.line || a.column - b.column);
    if (this.#full) limited.push(...this.errors.filter((e) => e.code === "too_many_errors"));
    return { ok: false, errors: limited };
  }

  /** Directives (checked raw: the composed document keeps only their effect) and documents. */
  checkStream(tokens: readonly { type: string; offset: number; source?: string }[]): void {
    let documents = 0;
    for (const token of tokens) {
      if (token.type === "directive") {
        const source = token.source ?? "";
        if (!/^%YAML[ \t]+1\.2$/.test(source)) {
          this.fail(
            "unsupported_value",
            "yaml.directives",
            "",
            this.position(token.offset),
            `\`${cut(source, 60)}\` is not supported: ${reasonOf("yaml.directives")}`,
          );
        }
      } else if (token.type === "document" && ++documents === 2) {
        this.fail(
          "multiple_documents",
          "",
          "",
          this.position(token.offset),
          "A workflow file holds one YAML document; this is a second one.",
        );
      }
    }
  }

  /** The library's errors and warnings; false when the document cannot be walked. */
  checkDiagnostics(doc: Document.Parsed): boolean {
    let walkable = true;
    for (const diagnostic of [...doc.errors, ...doc.warnings]) {
      // Directives were checked from the tokens.
      if (diagnostic.code === "BAD_DIRECTIVE") continue;
      const offset = diagnostic.pos[0];
      if (diagnostic.code === "TAG_RESOLVE_FAILED") {
        // A tag the library could not resolve (`!!omap`, `!custom`, an undeclared `!x!y`, which
        // leaves the node untagged). The walk would refuse the first two again, so it is
        // skipped; tags the library resolves (`!!str`) give no warning and the walk refuses them.
        walkable = false;
        const tag = this.#text.slice(offset, diagnostic.pos[1]).trim();
        this.fail(
          "unsupported_value",
          "yaml.tags",
          "",
          this.position(offset),
          `The YAML tag \`${cut(tag, 60)}\` is not supported: ${reasonOf("yaml.tags")}`,
        );
        continue;
      }
      walkable = false;
      this.fail(
        "yaml_syntax",
        "",
        "",
        this.position(offset),
        `Invalid YAML: ${cut(diagnostic.message, 200)}`,
      );
    }
    return walkable;
  }

  /**
   * Each alias's node: the most recent node before it with that anchor
   * (YAML's rule), found in one bounded pass in source order. False when
   * the document is too large or deep to walk.
   */
  resolveAnchors(doc: Document.Parsed): boolean {
    const named = new Map<string, Node>();
    const stack: [Node, number][] = doc.contents ? [[doc.contents, 1]] : [];
    let seen = 0;
    for (let top = stack.pop(); top; top = stack.pop()) {
      const [node, depth] = top;
      if (++seen > MAX_WORKFLOW_NODES || depth > MAX_YAML_DEPTH) {
        this.fail("yaml_too_complex", "", "", this.at(node, 0), tooComplex());
        return false;
      }
      if (isAlias(node)) {
        const target = named.get(node.source);
        if (target) this.#aliases.set(node, target);
        else {
          this.fail(
            "yaml_syntax",
            "",
            "",
            this.at(node, 0),
            `The alias \`*${cut(node.source, 60)}\` has no anchor before it.`,
          );
        }
        continue;
      }
      if (node.anchor) named.set(node.anchor, node);
      if (isMap(node)) {
        for (let i = node.items.length - 1; i >= 0; i--) {
          const pair = node.items[i];
          if (isNode(pair?.value)) stack.push([pair.value, depth + 1]);
          if (isNode(pair?.key)) stack.push([pair.key, depth + 1]);
        }
      } else if (isSeq(node)) {
        for (let i = node.items.length - 1; i >= 0; i--) {
          const item = node.items[i];
          if (isNode(item)) stack.push([item, depth + 1]);
        }
      }
    }
    return true;
  }

  /** Spends `units` of the walk's budget; past it, the file is too complex and the walk stops. */
  charge(units: number, path: string, at: Position): void {
    this.#units += units;
    if (this.#units > MAX_WORKFLOW_NODES) {
      this.fail("yaml_too_complex", "", path, at, tooComplex());
      throw new Stop();
    }
  }

  /** Pays for reading `length` characters of key or scalar text. */
  chargeText(length: number, path: string, at: Position): void {
    if (length >= CHARS_PER_UNIT) this.charge(Math.floor(length / CHARS_PER_UNIT), path, at);
  }

  /**
   * Reads `node` with `read`: charges it to the budget, follows an alias,
   * refuses a cycle, a tag or too much depth. Undefined when refused.
   */
  enter<T>(
    node: Node | null,
    path: string,
    fallback: number,
    read: (node: Node | null) => T,
  ): T | undefined {
    this.charge(1, path, this.at(node, fallback));
    let target = node;
    if (node && isAlias(node)) {
      target = this.#aliases.get(node) ?? null;
      if (!target) return undefined; // Reported while resolving anchors.
      if (this.#open.has(target)) {
        this.fail(
          "yaml_too_complex",
          "",
          path,
          this.at(node, fallback),
          `The alias \`*${cut(node.source, 60)}\` refers to a value that contains it.`,
        );
        return undefined;
      }
    }
    // A scalar's text is paid for before anything reads it, at each use through an alias.
    if (isScalar(target) && typeof target.source === "string") {
      this.chargeText(target.source.length, path, this.at(target, fallback));
    }
    if (target?.tag !== undefined) {
      const tag = target.tag.replace(/^tag:yaml\.org,2002:/, "!!");
      this.fail(
        "unsupported_value",
        "yaml.tags",
        path,
        this.at(target, fallback),
        `The YAML tag \`${cut(tag, 60)}\` is not supported: ${reasonOf("yaml.tags")}`,
      );
      return undefined;
    }
    if (this.#depth >= MAX_YAML_DEPTH) {
      this.fail("yaml_too_complex", "", path, this.at(node, fallback), tooComplex());
      throw new Stop();
    }
    this.#depth++;
    if (target) this.#open.add(target);
    try {
      return read(target);
    } finally {
      this.#depth--;
      if (target) this.#open.delete(target);
    }
  }
}

function isHigh(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isNode(value: unknown): value is Node {
  return isScalar(value) || isMap(value) || isSeq(value) || isAlias(value);
}

function tooComplex(): string {
  return `The file nests values more than ${MAX_YAML_DEPTH} deep or holds more than ${MAX_WORKFLOW_NODES} values (long text counting once per ${CHARS_PER_UNIT} characters, aliases at each use).`;
}

/** `text` cut to at most `max` code points, without reading past them. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let count = 0;
  let end = 0;
  // The string iterator yields code points lazily, so this reads at most max + 1 of them.
  for (const char of text) {
    if (count === max) return `${text.slice(0, end)}…`;
    count++;
    end += char.length;
  }
  return text;
}

/** Code points kept of an error's path and feature; a message keeps twice this. */
const MAX_ERROR_FIELD = 200;
/** Characters of scalar or key text one budget unit pays for, so long text costs its length. */
const CHARS_PER_UNIT = 64;

function reasonOf(feature: string): string {
  const entry = featureOf(feature);
  return entry?.status === "unsupported" ? entry.reason : "";
}

const join = (path: string, key: string) => (path === "" ? key : `${path}.${key}`);

// Scalars ---------------------------------------------------------------------------------

/** A scalar's text: a string as decoded, a number or boolean as written. */
function sourceOf(node: Scalar): string {
  if (node.value === null) return "";
  return typeof node.source === "string" ? node.source : String(node.value);
}

/** A string-like scalar (a number or boolean taken as written); null and collections refused. */
function readText(
  w: Walk,
  node: Node | null,
  path: string,
  feature: string,
  fallback: number,
): Text | undefined {
  return w.enter(node, path, fallback, (n) => {
    if (isScalar(n) && n.value !== null && typeof n.value !== "object") {
      return { value: sourceOf(n), at: w.at(n, fallback) };
    }
    return w.fail(
      "invalid_type",
      feature,
      path,
      w.at(n, fallback),
      `\`${path}\` must be a string.`,
    );
  });
}

/** A string, or a list of strings, as a list; repeats refused when `unique`. */
/**
 * `${{` in a field that takes no expressions, named as such before the field's own type or
 * format checks would refuse it under another name. True when it was refused.
 */
function refuseExpression(
  w: Walk,
  n: Node | null,
  path: string,
  feature: string,
  fallback: number,
): boolean {
  if (!isScalar(n) || typeof n.value !== "string" || !n.value.includes("${{")) return false;
  w.fail("expression_not_allowed", feature, path, w.at(n, fallback), noExpressions(feature));
  return true;
}

function readTexts(
  w: Walk,
  node: Node | null,
  path: string,
  feature: string,
  fallback: number,
  unique: boolean,
): Text[] | undefined {
  return readTextItems(w, node, path, feature, fallback, unique)?.map((item) => item.text);
}

/**
 * A string or a list of strings, each with its own path (`path` for a single string,
 * `path[i]` by its index in the list as written). With `noExpressions`, an item holding
 * `${{` is refused as such and left out, so the caller never judges it as a value.
 */
function readTextItems(
  w: Walk,
  node: Node | null,
  path: string,
  feature: string,
  fallback: number,
  unique: boolean,
  refuseExpressions = false,
  onRefused?: () => void,
): { text: Text; path: string }[] | undefined {
  const refused = (text: Text, itemPath: string) => {
    if (!refuseExpressions || !text.value.includes("${{")) return false;
    onRefused?.();
    w.fail("expression_not_allowed", feature, itemPath, text.at, noExpressions(feature));
    return true;
  };
  return w.enter(node, path, fallback, (n) => {
    if (isScalar(n)) {
      const one = readScalarText(w, n, path, feature, fallback);
      if (!one) return undefined;
      return refused(one, path) ? [] : [{ text: one, path }];
    }
    if (!isSeq(n)) {
      return w.fail(
        "invalid_type",
        feature,
        path,
        w.at(n, fallback),
        `\`${path}\` must be a string or a list of strings.`,
      );
    }
    const items: { text: Text; path: string }[] = [];
    const seen = new Set<string>();
    n.items.forEach((item, i) => {
      const itemPath = `${path}[${i}]`;
      const text = readText(w, item as Node, itemPath, feature, n.range?.[0] ?? fallback);
      if (!text || refused(text, itemPath)) return;
      if (unique && seen.has(text.value)) {
        w.fail(
          "invalid_value",
          feature,
          itemPath,
          text.at,
          `\`${cut(text.value, 60)}\` is listed twice in \`${path}\`.`,
        );
        return;
      }
      seen.add(text.value);
      items.push({ text, path: itemPath });
    });
    return items;
  });
}

function readScalarText(
  w: Walk,
  n: Scalar,
  path: string,
  feature: string,
  fallback: number,
): Text | undefined {
  if (n.value === null || typeof n.value === "object") {
    return w.fail(
      "invalid_type",
      feature,
      path,
      w.at(n, fallback),
      `\`${path}\` must be a string.`,
    );
  }
  return { value: sourceOf(n), at: w.at(n, fallback) };
}

const hasExpression = (value: unknown): value is string =>
  typeof value === "string" && value.includes("${{");

function readBoolean(
  w: Walk,
  node: Node | null,
  path: string,
  feature: string,
  fallback: number,
): Valued<boolean> | undefined {
  return w.enter(node, path, fallback, (n) => {
    const at = w.at(n, fallback);
    if (isScalar(n) && typeof n.value === "boolean") return { kind: "literal", value: n.value, at };
    if (isScalar(n) && hasExpression(n.value)) return { kind: "expression", source: n.value, at };
    return w.fail(
      "invalid_type",
      feature,
      path,
      at,
      `\`${path}\` must be true, false or an expression.`,
    );
  });
}

function readNumber(
  w: Walk,
  node: Node | null,
  path: string,
  feature: string,
  fallback: number,
  rule: { integer: boolean; min: number },
): Valued<number> | undefined {
  return w.enter(node, path, fallback, (n) => {
    const at = w.at(n, fallback);
    if (isScalar(n) && hasExpression(n.value)) return { kind: "expression", source: n.value, at };
    if (!isScalar(n) || typeof n.value !== "number") {
      return w.fail(
        "invalid_type",
        feature,
        path,
        at,
        `\`${path}\` must be a number or an expression.`,
      );
    }
    const value = n.value;
    const ok = rule.integer ? Number.isSafeInteger(value) : Number.isFinite(value);
    if (!ok || value < rule.min) {
      const kind = rule.integer ? "a whole number" : "a number";
      return w.fail(
        "invalid_value",
        feature,
        path,
        at,
        `\`${path}\` must be ${kind} of at least ${rule.min}.`,
      );
    }
    return { kind: "literal", value, at };
  });
}

/** Any YAML value, positioned, for matrix values. */
function readValue(
  w: Walk,
  node: Node | null,
  path: string,
  feature: string,
  fallback: number,
): Value | undefined {
  return w.enter(node, path, fallback, (n): Value | undefined => {
    const at = w.at(n, fallback);
    if (n === null) return { kind: "scalar", value: null, source: "", at };
    if (isScalar(n)) {
      const value = n.value;
      if (
        typeof value === "number" &&
        !(Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)))
      ) {
        return w.fail(
          "invalid_value",
          feature,
          path,
          at,
          `\`${path}\` must be a finite number that is exactly representable.`,
        );
      }
      if (value !== null && typeof value === "object") {
        return w.fail("invalid_type", feature, path, at, `\`${path}\` must be a plain value.`);
      }
      return {
        kind: "scalar",
        value: value as string | number | boolean | null,
        source: sourceOf(n),
        at,
      };
    }
    if (isSeq(n)) {
      const items: Value[] = [];
      n.items.forEach((item, i) => {
        const value = readValue(
          w,
          item as Node,
          `${path}[${i}]`,
          feature,
          n.range?.[0] ?? fallback,
        );
        if (value) items.push(value);
      });
      return { kind: "sequence", items, at };
    }
    if (isMap(n)) {
      const entries: (readonly [Text, Value])[] = [];
      for (const entry of entriesOf(w, n, path, fallback)) {
        const value = readValue(w, entry.value, entry.path, feature, entry.offset);
        if (value) entries.push([entry.key, value]);
      }
      return { kind: "mapping", entries, at };
    }
    return undefined;
  });
}

// Mappings --------------------------------------------------------------------------------

interface Entry {
  readonly key: Text;
  readonly path: string;
  readonly value: Node | null;
  /** Where the key starts, for errors about a missing or null value. */
  readonly offset: number;
}

/**
 * A mapping's entries in order. Keys are plain strings; a repeated key, a
 * merge key (`<<`) or any other key is refused here, once, with a linear
 * check.
 */
function entriesOf(w: Walk, map: YAMLMap, path: string, fallback: number): Entry[] {
  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const pair of map.items) {
    const keyNode = pair.key as Node | null;
    const offset = keyNode?.range?.[0] ?? map.range?.[0] ?? fallback;
    const at = w.position(offset);
    if (!isScalar(keyNode) || typeof keyNode.value !== "string" || keyNode.tag !== undefined) {
      w.fail(
        "invalid_type",
        "",
        path,
        at,
        `Keys in \`${path || "the workflow"}\` must be plain strings.`,
      );
      continue;
    }
    const key = keyNode.value;
    w.chargeText(key.length, path, at);
    const keyPath = join(path, key);
    if (key === "<<") {
      w.fail(
        "unsupported_key",
        "yaml.merge-keys",
        keyPath,
        at,
        `Merge keys (\`<<\`) are not supported: ${reasonOf("yaml.merge-keys")}`,
      );
      continue;
    }
    if (seen.has(key)) {
      w.fail("duplicate_key", "", keyPath, at, `\`${cut(keyPath, 120)}\` is given twice.`);
      continue;
    }
    seen.add(key);
    entries.push({
      key: { value: key, at },
      path: keyPath,
      value: (pair.value as Node | null) ?? null,
      offset,
    });
  }
  return entries;
}

/** A mapping's entries, or an error when `node` is not one. */
function mapping(
  w: Walk,
  node: Node | null,
  path: string,
  feature: string,
  fallback: number,
  read: (entries: Entry[], map: YAMLMap) => void,
): boolean {
  return (
    w.enter(node, path, fallback, (n) => asMapping(w, n, path, feature, fallback, read)) ?? false
  );
}

/** As {@link mapping}, for a node already entered. */
function asMapping(
  w: Walk,
  n: Node | null,
  path: string,
  feature: string,
  fallback: number,
  read: (entries: Entry[], map: YAMLMap) => void,
): boolean {
  if (!isMap(n)) {
    w.fail(
      "invalid_type",
      feature,
      path,
      w.at(n, fallback),
      `\`${cut(path, 120) || "The workflow"}\` must be a mapping of keys.`,
    );
    return false;
  }
  read(entriesOf(w, n, path, fallback), n);
  return true;
}

/**
 * `whenNull()` for an absent or null value (`push:`, `push: ~`, or an alias
 * of one), else `read` of the entered node. The node is entered first, so an
 * alias is followed and a tag refused before null is taken for no config.
 */
function nullable<T>(
  w: Walk,
  node: Node | null,
  path: string,
  fallback: number,
  whenNull: () => T,
  read: (n: Node) => T | undefined,
): T | undefined {
  return w.enter(node, path, fallback, (n) =>
    n === null || (isScalar(n) && n.value === null) ? whenNull() : read(n),
  );
}

type Reader<T> = (w: Walk, entry: Entry) => Partial<T> | undefined;
/** One reader for every supported key under `Context`, and none for any other (checked by `satisfies`). */
type Readers<Context extends string, T> = Record<SupportedKeysOf<Context>, Reader<T>>;

/** Top-level supported keys. */
type TopKey = SupportedKey extends infer F ? (F extends `${string}.${string}` ? never : F) : never;

/**
 * The fields `readers` make of a mapping's keys: each key is looked up in
 * the support matrix under `context`; unknown and unsupported keys are
 * errors naming them.
 */
function readKeys<T>(
  w: Walk,
  entries: readonly Entry[],
  context: string,
  readers: Readonly<Record<string, Reader<T>>>,
): Partial<T> {
  const fields: Partial<T> = {};
  for (const entry of entries) {
    const feature = context === "" ? entry.key.value : `${context}.${entry.key.value}`;
    // A key holding `.`, `=` or `[` would match a deeper feature or a value entry, never a key here.
    const known: WorkflowFeature | undefined = /[.=[]/.test(entry.key.value)
      ? undefined
      : featureOf(feature);
    const read = Object.hasOwn(readers, entry.key.value) ? readers[entry.key.value] : undefined;
    if (!known || (known.status === "supported" && !read)) {
      w.fail(
        "unknown_key",
        feature,
        entry.path,
        entry.key.at,
        `\`${cut(entry.path, 120)}\` is not a workflow key.`,
      );
      continue;
    }
    if (known.status === "unsupported") {
      w.fail(
        "unsupported_key",
        feature,
        entry.path,
        entry.key.at,
        `\`${cut(entry.path, 120)}\` is not supported: ${known.reason}`,
      );
      continue;
    }
    if (read) Object.assign(fields, read(w, entry));
  }
  return fields;
}

const missing = (w: Walk, feature: string, path: string, at: Position, key: string) =>
  w.fail(
    "missing_key",
    feature,
    join(path, key),
    at,
    `\`${path || "The workflow"}\` needs \`${key}\`.`,
  );

// Shared pieces ---------------------------------------------------------------------------

function readPairs(w: Walk, entry: Entry, feature: string): Pairs | undefined {
  let pairs: (readonly [Text, Text])[] | undefined;
  mapping(w, entry.value, entry.path, feature, entry.offset, (entries) => {
    pairs = [];
    for (const e of entries) {
      const value = w.enter(e.value, e.path, e.offset, (n): Text | undefined => {
        if (n === null) return { value: "", at: e.key.at };
        if (isScalar(n) && (n.value === null || typeof n.value !== "object")) {
          return { value: sourceOf(n), at: w.at(n, e.offset) };
        }
        return w.fail(
          "invalid_type",
          feature,
          e.path,
          w.at(n, e.offset),
          `\`${cut(e.path, 120)}\` must be a string, number or boolean.`,
        );
      });
      if (value) pairs.push([e.key, value]);
    }
  });
  return pairs;
}

function readCondition(w: Walk, entry: Entry, feature: string): Condition | undefined {
  return w.enter(entry.value, entry.path, entry.offset, (n) => {
    if (isScalar(n) && (typeof n.value === "string" || typeof n.value === "boolean")) {
      return { source: sourceOf(n), at: w.at(n, entry.offset) };
    }
    return w.fail(
      "invalid_type",
      feature,
      entry.path,
      w.at(n, entry.offset),
      `\`${entry.path}\` must be an expression, true or false.`,
    );
  });
}

function readRunDefaults(w: Walk, entry: Entry, context: string): RunDefaults | undefined {
  let defaults: RunDefaults | undefined;
  mapping(w, entry.value, entry.path, context, entry.offset, (entries) => {
    const fields = readKeys(w, entries, context, {
      run: (w2, e) => {
        let run: RunDefaults = {};
        mapping(w2, e.value, e.path, `${context}.run`, e.offset, (runEntries) => {
          run = readKeys<RunDefaults>(w2, runEntries, `${context}.run`, {
            shell: (w3, e3) =>
              opt("shell", readText(w3, e3.value, e3.path, `${context}.run.shell`, e3.offset)),
            "working-directory": (w3, e3) =>
              opt(
                "workingDirectory",
                readText(w3, e3.value, e3.path, `${context}.run.working-directory`, e3.offset),
              ),
          } satisfies Readers<"defaults.run", RunDefaults> &
            Readers<`${typeof JOB}.defaults.run`, RunDefaults>);
        });
        return { run };
      },
    } satisfies Readers<"defaults", { run: RunDefaults }> &
      Readers<`${typeof JOB}.defaults`, { run: RunDefaults }>);
    defaults = fields.run ?? {};
  });
  return defaults;
}

/** `{ [key]: value }`, or nothing when `value` is undefined (exactOptionalPropertyTypes). */
function opt<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

function readConcurrency(w: Walk, entry: Entry, context: string): Concurrency | undefined {
  return w.enter(entry.value, entry.path, entry.offset, (n) => {
    const at = w.at(n, entry.offset);
    if (isScalar(n)) {
      const group = readScalarText(w, n, entry.path, context, entry.offset);
      return group ? { group, at } : undefined;
    }
    if (!isMap(n)) {
      return w.fail(
        "invalid_type",
        context,
        entry.path,
        at,
        `\`${entry.path}\` must be a group name or a mapping.`,
      );
    }
    const fields = readKeys<{ group: Text; cancelInProgress: Valued<boolean> }>(
      w,
      entriesOf(w, n, entry.path, entry.offset),
      context,
      {
        group: (w2, e) => opt("group", readText(w2, e.value, e.path, `${context}.group`, e.offset)),
        "cancel-in-progress": (w2, e) =>
          opt(
            "cancelInProgress",
            readBoolean(w2, e.value, e.path, `${context}.cancel-in-progress`, e.offset),
          ),
      } satisfies Readers<"concurrency", { group: Text; cancelInProgress: Valued<boolean> }> &
        Readers<`${typeof JOB}.concurrency`, { group: Text; cancelInProgress: Valued<boolean> }>,
    );
    if (!fields.group) {
      if (!n.items.some((p) => isScalar(p.key) && p.key.value === "group"))
        missing(w, `${context}.group`, entry.path, at, "group");
      return undefined;
    }
    return { group: fields.group, ...opt("cancelInProgress", fields.cancelInProgress), at };
  });
}

const ACCESS = new Set(["read", "write", "none"]);
const GRANTABLE: ReadonlySet<string> = new Set<string>(PERMISSION_SCOPES);

function readPermissions(w: Walk, entry: Entry): Permissions | undefined {
  const feature = entry.path.startsWith("jobs.") ? "jobs.<job_id>.permissions" : "permissions";
  return w.enter(entry.value, entry.path, entry.offset, (n): Permissions | undefined => {
    const at = w.at(n, entry.offset);
    if (refuseExpression(w, n, entry.path, feature, entry.offset)) return undefined;
    if (isScalar(n) && (n.value === "read-all" || n.value === "write-all")) {
      return { kind: "all", access: n.value === "read-all" ? "read" : "write", at };
    }
    if (!isMap(n)) {
      return w.fail(
        "invalid_type",
        "permissions",
        entry.path,
        at,
        `\`${entry.path}\` must be \`read-all\`, \`write-all\` or a mapping of scopes.`,
      );
    }
    const scopes: { scope: PermissionScope; access: "read" | "write"; at: Position }[] = [];
    for (const e of entriesOf(w, n, entry.path, entry.offset)) {
      const scope = e.key.value;
      const known = featureOf("permissions", scope);
      if (!known) {
        w.fail(
          "unknown_key",
          `permissions.${scope}`,
          e.path,
          e.key.at,
          `\`${cut(e.path, 120)}\` is not a permission scope.`,
        );
        continue;
      }
      const access = readText(w, e.value, e.path, "permissions", e.offset);
      if (!access) continue;
      if (access.value.includes("${{")) {
        w.fail("expression_not_allowed", feature, e.path, access.at, noExpressions(feature));
        continue;
      }
      const allowed =
        scope === "id-token" || scope === "copilot-requests"
          ? ["write", "none"]
          : scope === "vulnerability-alerts"
            ? ["read", "none"]
            : ["read", "write", "none"];
      if (!ACCESS.has(access.value) || !allowed.includes(access.value)) {
        w.fail(
          "invalid_value",
          "permissions",
          e.path,
          access.at,
          `\`${e.path}\` must be ${allowed.map((a) => `\`${a}\``).join(", ")}.`,
        );
        continue;
      }
      if (access.value === "none") continue;
      if (known.status === "unsupported" || !GRANTABLE.has(scope)) {
        w.fail(
          "unsupported_value",
          "permissions",
          e.path,
          access.at,
          `\`${e.path}: ${access.value}\` is not supported: ${known.status === "unsupported" ? known.reason : ""}`,
        );
        continue;
      }
      scopes.push({
        scope: scope as PermissionScope,
        access: access.value as "read" | "write",
        at: e.key.at,
      });
    }
    return { kind: "scopes", scopes, at };
  });
}

// Triggers --------------------------------------------------------------------------------

type FilterFields = { branches: Filter; tags: Filter; paths: Filter; types: readonly Text[] };

function filterReader(
  name: "branches" | "tags" | "paths",
  mode: Filter["mode"],
  feature: string,
): Reader<FilterFields> {
  return (w, e) => {
    const patterns = readTexts(w, e.value, e.path, feature, e.offset, false);
    return patterns
      ? ({ [name]: { mode, patterns, at: e.key.at } } as Partial<FilterFields>)
      : undefined;
  };
}

/** GitHub allows `branches` or `branches-ignore` (likewise tags, paths) for one event, not both. */
function checkExclusive(w: Walk, entries: readonly Entry[], context: string): void {
  const keys = new Set(entries.map((e) => e.key.value));
  for (const name of ["branches", "tags", "paths"]) {
    const ignore = entries.find((e) => e.key.value === `${name}-ignore`);
    if (keys.has(name) && ignore) {
      w.fail(
        "invalid_value",
        `${context}.${name}-ignore`,
        ignore.path,
        ignore.key.at,
        `\`${name}\` and \`${name}-ignore\` cannot both filter one event.`,
      );
    }
  }
}

function readTypes(
  w: Walk,
  e: Entry,
  event: "pull_request" | "pull_request_target",
): readonly Text[] | undefined {
  const feature = `on.${event}.types`;
  const types = readTextItems(w, e.value, e.path, feature, e.offset, true, true);
  if (!types) return undefined;
  const kept: Text[] = [];
  for (const { text: type } of types) {
    const known = featureOf(feature, type.value);
    if (!known) {
      w.fail(
        "invalid_value",
        feature,
        e.path,
        type.at,
        `\`${cut(type.value, 60)}\` is not an activity type of \`${event}\`.`,
      );
    } else if (known.status === "unsupported") {
      w.fail(
        "unsupported_value",
        feature,
        e.path,
        type.at,
        `\`${event}\` activity \`${type.value}\` is not supported: ${known.reason}`,
      );
    } else kept.push(type);
  }
  return kept;
}

function readPush(
  w: Walk,
  node: Node | null,
  path: string,
  at: Position,
  fallback: number,
): Trigger | undefined {
  let trigger: Trigger | undefined;
  const none = (): Trigger => ({ event: "push", at });
  const configured = nullable(w, node, path, fallback, none, (n) => {
    asMapping(w, n, path, "on.push", fallback, (entries) => {
      checkExclusive(w, entries, "on.push");
      const f = readKeys<FilterFields>(w, entries, "on.push", {
        branches: filterReader("branches", "include", "on.push.branches"),
        "branches-ignore": filterReader("branches", "ignore", "on.push.branches-ignore"),
        tags: filterReader("tags", "include", "on.push.tags"),
        "tags-ignore": filterReader("tags", "ignore", "on.push.tags-ignore"),
        paths: filterReader("paths", "include", "on.push.paths"),
        "paths-ignore": filterReader("paths", "ignore", "on.push.paths-ignore"),
      } satisfies Readers<"on.push", FilterFields>);
      trigger = {
        event: "push",
        at,
        ...opt("branches", f.branches),
        ...opt("tags", f.tags),
        ...opt("paths", f.paths),
      };
    });
    return trigger;
  });
  return configured;
}

function readPullRequest(
  w: Walk,
  event: "pull_request" | "pull_request_target",
  node: Node | null,
  path: string,
  at: Position,
  fallback: number,
): Trigger | undefined {
  const context = `on.${event}`;
  let trigger: Trigger | undefined;
  const none = (): Trigger => ({ event, at });
  const configured = nullable(w, node, path, fallback, none, (n) => {
    asMapping(w, n, path, context, fallback, (entries) => {
      checkExclusive(w, entries, context);
      const readers = {
        types: (w2, e) => opt("types", readTypes(w2, e, event)),
        branches: filterReader("branches", "include", `${context}.branches`),
        "branches-ignore": filterReader("branches", "ignore", `${context}.branches-ignore`),
        paths: filterReader("paths", "include", `${context}.paths`),
        "paths-ignore": filterReader("paths", "ignore", `${context}.paths-ignore`),
      } satisfies Readers<"on.pull_request", FilterFields> &
        Readers<"on.pull_request_target", FilterFields>;
      const f = readKeys<FilterFields>(w, entries, context, readers);
      trigger = {
        event,
        at,
        ...opt("types", f.types),
        ...opt("branches", f.branches),
        ...opt("paths", f.paths),
      };
    });
    return trigger;
  });
  return configured;
}

function readSchedule(
  w: Walk,
  node: Node | null,
  path: string,
  at: Position,
  fallback: number,
): Trigger | undefined {
  return w.enter(node, path, fallback, (n) => {
    if (!isSeq(n) || n.items.length === 0) {
      return w.fail(
        "invalid_type",
        "on.schedule",
        path,
        w.at(n, fallback),
        `\`${path}\` must be a list of \`cron\` entries.`,
      );
    }
    const crons: Text[] = [];
    n.items.forEach((item, i) => {
      const itemPath = `${path}[${i}]`;
      mapping(
        w,
        item as Node,
        itemPath,
        "on.schedule",
        n.range?.[0] ?? fallback,
        (entries, map) => {
          const f = readKeys<{ cron: Text }>(w, entries, "on.schedule[*]", {
            cron: (w2, e) => {
              const cron = readText(w2, e.value, e.path, "on.schedule[*].cron", e.offset);
              if (!cron) return undefined;
              if (cron.value.includes("${{")) {
                return w2.fail(
                  "expression_not_allowed",
                  "on.schedule[*].cron",
                  e.path,
                  cron.at,
                  noExpressions("on.schedule[*].cron"),
                );
              }
              const fields = cron.value.trim().split(/\s+/);
              if (fields.length !== 5 || !fields.every((field) => CRON_FIELD.test(field))) {
                return w2.fail(
                  "invalid_value",
                  "on.schedule[*].cron",
                  e.path,
                  cron.at,
                  `\`${cut(cron.value, 60)}\` is not a five-field cron expression.`,
                );
              }
              return { cron };
            },
          } satisfies Readers<"on.schedule[*]", { cron: Text }>);
          if (f.cron) crons.push(f.cron);
          else if (!entries.some((e) => e.key.value === "cron"))
            missing(w, "on.schedule[*].cron", itemPath, w.at(map, 0), "cron");
        },
      );
    });
    return { event: "schedule", at, crons };
  });
}

const INPUT = "on.workflow_dispatch.inputs.<input_id>";

function readDispatch(
  w: Walk,
  node: Node | null,
  path: string,
  at: Position,
  fallback: number,
): Trigger | undefined {
  const none = (): Trigger => ({ event: "workflow_dispatch", at, inputs: [] });
  return nullable(w, node, path, fallback, none, (n) => {
    let trigger: Trigger | undefined;
    asMapping(w, n, path, "on.workflow_dispatch", fallback, (entries) => {
      const f = readKeys<{ inputs: DispatchInput[] }>(w, entries, "on.workflow_dispatch", {
        inputs: (w2, e) => opt("inputs", readInputs(w2, e)),
      } satisfies Readers<"on.workflow_dispatch", { inputs: DispatchInput[] }>);
      trigger = { event: "workflow_dispatch", at, inputs: f.inputs ?? [] };
    });
    return trigger;
  });
}

function readInputs(w: Walk, e: Entry): DispatchInput[] | undefined {
  return nullable(
    w,
    e.value,
    e.path,
    e.offset,
    () => [],
    (n) => {
      const inputs: DispatchInput[] = [];
      asMapping(w, n, e.path, "on.workflow_dispatch.inputs", e.offset, (inputEntries) => {
        for (const [i, ie] of inputEntries.entries()) {
          if (i === MAX_DISPATCH_INPUTS) {
            w.fail(
              "limit_exceeded",
              "on.workflow_dispatch.inputs",
              ie.path,
              ie.key.at,
              `A workflow takes at most ${MAX_DISPATCH_INPUTS} inputs.`,
            );
            break;
          }
          const input = readInput(w, ie);
          if (input) inputs.push(input);
        }
      });
      return inputs;
    },
  );
}

type InputFields = {
  description: Text;
  required: boolean;
  default: ScalarValue;
  type: DispatchInputType;
  options: readonly Text[];
};

function readInput(w: Walk, entry: Entry): DispatchInput | undefined {
  const base = {
    id: entry.key,
    required: false,
    type: "string" as DispatchInputType,
    options: [] as readonly Text[],
  };
  return nullable(
    w,
    entry.value,
    entry.path,
    entry.offset,
    () => base,
    (n) => readInputFields(w, entry, n, base),
  );
}

function readInputFields(
  w: Walk,
  entry: Entry,
  n: Node,
  base: DispatchInput,
): DispatchInput | undefined {
  let input: DispatchInput | undefined;
  asMapping(w, n, entry.path, INPUT, entry.offset, (entries) => {
    const f = readKeys<InputFields>(w, entries, INPUT, {
      description: (w2, e) =>
        opt("description", readText(w2, e.value, e.path, `${INPUT}.description`, e.offset)),
      required: (w2, e) =>
        w2.enter(e.value, e.path, e.offset, (n) =>
          refuseExpression(w2, n, e.path, `${INPUT}.required`, e.offset)
            ? undefined
            : isScalar(n) && typeof n.value === "boolean"
              ? { required: n.value }
              : w2.fail(
                  "invalid_type",
                  `${INPUT}.required`,
                  e.path,
                  w2.at(n, e.offset),
                  `\`${e.path}\` must be true or false.`,
                ),
        ),
      default: (w2, e) => {
        const value = readValue(w2, e.value, e.path, `${INPUT}.default`, e.offset);
        if (value && value.kind !== "scalar") {
          return w2.fail(
            "invalid_type",
            `${INPUT}.default`,
            e.path,
            value.at,
            `\`${e.path}\` must be a plain value.`,
          );
        }
        return opt("default", value);
      },
      type: (w2, e) => {
        const type = readText(w2, e.value, e.path, `${INPUT}.type`, e.offset);
        if (!type) return undefined;
        if (type.value.includes("${{")) {
          const feature = `${INPUT}.type`;
          return w2.fail(
            "expression_not_allowed",
            feature,
            e.path,
            type.at,
            noExpressions(feature),
          );
        }
        const known = featureOf(`${INPUT}.type`, type.value);
        if (!known) {
          return w2.fail(
            "invalid_value",
            `${INPUT}.type`,
            e.path,
            type.at,
            `\`${cut(type.value, 60)}\` is not an input type.`,
          );
        }
        if (known.status === "unsupported") {
          return w2.fail(
            "unsupported_value",
            `${INPUT}.type`,
            e.path,
            type.at,
            `Input type \`${type.value}\` is not supported: ${known.reason}`,
          );
        }
        return { type: type.value as DispatchInputType };
      },
      options: (w2, e) =>
        opt("options", readTexts(w2, e.value, e.path, `${INPUT}.options`, e.offset, true)),
    } satisfies Readers<typeof INPUT, InputFields>);
    const options = entries.find((e) => e.key.value === "options");
    const type = f.type ?? "string";
    if (type === "choice" && (f.options?.length ?? 0) === 0 && !options) {
      missing(w, `${INPUT}.options`, entry.path, entry.key.at, "options");
    } else if (type === "choice" && f.options?.length === 0 && options) {
      w.fail(
        "invalid_value",
        `${INPUT}.options`,
        options.path,
        options.key.at,
        "A choice input needs at least one option.",
      );
    } else if (type !== "choice" && options) {
      w.fail(
        "invalid_value",
        `${INPUT}.options`,
        options.path,
        options.key.at,
        "Only a `choice` input has options.",
      );
    }
    input = {
      ...base,
      ...opt("description", f.description),
      required: f.required ?? false,
      ...opt("default", f.default),
      type,
      options: f.options ?? [],
    };
  });
  return input;
}

type EventReader = (
  w: Walk,
  config: Node | null,
  path: string,
  at: Position,
  fallback: number,
) => Trigger | undefined;

const EVENT_READERS = {
  push: readPush,
  pull_request: (w, c, p, a, f) => readPullRequest(w, "pull_request", c, p, a, f),
  pull_request_target: (w, c, p, a, f) => readPullRequest(w, "pull_request_target", c, p, a, f),
  schedule: readSchedule,
  workflow_dispatch: readDispatch,
} satisfies Record<SupportedKeysOf<"on">, EventReader>;

/** The events a workflow runs on, in source order. */
function readOn(w: Walk, entry: Entry): readonly Trigger[] | undefined {
  return w.enter(entry.value, "on", entry.offset, (n) => {
    const triggers: Trigger[] = [];
    const add = (
      name: string,
      path: string,
      at: Position,
      config: Node | null,
      fallback: number,
    ) => {
      const feature = `on.${name}`;
      const known = /[.=[]/.test(name) ? undefined : featureOf(feature);
      const read = Object.hasOwn(EVENT_READERS, name)
        ? EVENT_READERS[name as keyof typeof EVENT_READERS]
        : undefined;
      if (!known || (known.status === "supported" && !read))
        return w.fail(
          "unknown_key",
          feature,
          path,
          at,
          `\`${cut(name, 60)}\` is not an event that triggers workflows.`,
        );
      if (known.status === "unsupported") {
        return w.fail(
          "unsupported_key",
          feature,
          path,
          at,
          `The \`${name}\` event is not supported: ${known.reason}`,
        );
      }
      const trigger = read?.(w, config, path, at, fallback);
      if (trigger) triggers.push(trigger);
      return undefined;
    };
    if (isScalar(n) || isSeq(n)) {
      // A refused expression still counts as an event written, for the empty-list check.
      let refused = 0;
      const items =
        readTextItems(w, n, "on", "on", entry.offset, true, true, () => {
          refused++;
        }) ?? [];
      for (const { text: name, path } of items) add(name.value, path, name.at, null, entry.offset);
      if (items.length + refused === 0 && isSeq(n))
        w.fail(
          "invalid_value",
          "on",
          "on",
          w.at(n, entry.offset),
          "`on` needs at least one event.",
        );
    } else if (isMap(n)) {
      const entries = entriesOf(w, n, "on", entry.offset);
      for (const e of entries) add(e.key.value, e.path, e.key.at, e.value, e.offset);
      if (entries.length === 0)
        w.fail(
          "invalid_value",
          "on",
          "on",
          w.at(n, entry.offset),
          "`on` needs at least one event.",
        );
    } else {
      return w.fail(
        "invalid_type",
        "on",
        "on",
        w.at(n, entry.offset),
        "`on` must be an event, a list of events or a mapping of events.",
      );
    }
    return triggers;
  });
}

// Jobs ------------------------------------------------------------------------------------

const JOB = "jobs.<job_id>";
const STEP = "jobs.<job_id>.steps[*]";
const CONTAINER = "jobs.<job_id>.container";
const SERVICE = "jobs.<job_id>.services.<service_id>";

type ContainerFields = {
  image: Text;
  credentials: Credentials;
  env: Pairs;
  ports: readonly Text[];
  volumes: readonly Text[];
  options: Text;
};

function containerReaders(context: typeof CONTAINER | typeof SERVICE) {
  return {
    image: (w, e) => opt("image", readText(w, e.value, e.path, `${context}.image`, e.offset)),
    credentials: (w, e) => {
      let credentials: Credentials | undefined;
      mapping(w, e.value, e.path, `${context}.credentials`, e.offset, (entries) => {
        const f = readKeys<Credentials>(w, entries, `${context}.credentials`, {
          username: (w2, e2) =>
            opt(
              "username",
              readText(w2, e2.value, e2.path, `${context}.credentials.username`, e2.offset),
            ),
          password: (w2, e2) =>
            opt(
              "password",
              readText(w2, e2.value, e2.path, `${context}.credentials.password`, e2.offset),
            ),
        } satisfies Readers<`${typeof CONTAINER}.credentials`, Credentials> &
          Readers<`${typeof SERVICE}.credentials`, Credentials>);
        for (const key of ["username", "password"] as const) {
          if (!f[key] && !entries.some((x) => x.key.value === key))
            missing(w, `${context}.credentials.${key}`, e.path, e.key.at, key);
        }
        if (f.username && f.password) credentials = { username: f.username, password: f.password };
      });
      return opt("credentials", credentials);
    },
    env: (w, e) => opt("env", readPairs(w, e, `${context}.env`)),
    ports: (w, e) =>
      opt("ports", readTexts(w, e.value, e.path, `${context}.ports`, e.offset, false)),
    volumes: (w, e) =>
      opt("volumes", readTexts(w, e.value, e.path, `${context}.volumes`, e.offset, false)),
    options: (w, e) => opt("options", readText(w, e.value, e.path, `${context}.options`, e.offset)),
  } satisfies Readers<typeof CONTAINER, ContainerFields> & Readers<typeof SERVICE, ContainerFields>;
}

function readContainerLike(
  w: Walk,
  node: Node | null,
  path: string,
  context: typeof CONTAINER | typeof SERVICE,
  fallback: number,
): Container | undefined {
  return w.enter(node, path, fallback, (n) => {
    const at = w.at(n, fallback);
    if (context === CONTAINER && isScalar(n)) {
      const image = readScalarText(w, n, path, `${context}.image`, fallback);
      return image ? { image, env: [], ports: [], volumes: [], at } : undefined;
    }
    if (!isMap(n))
      return w.fail(
        "invalid_type",
        context,
        path,
        at,
        `\`${path}\` must be a mapping${context === CONTAINER ? " or an image" : ""}.`,
      );
    const entries = entriesOf(w, n, path, fallback);
    const f = readKeys<ContainerFields>(w, entries, context, containerReaders(context));
    if (!f.image) {
      if (!entries.some((e) => e.key.value === "image"))
        missing(w, `${context}.image`, path, at, "image");
      return undefined;
    }
    return {
      image: f.image,
      ...opt("credentials", f.credentials),
      env: f.env ?? [],
      ports: f.ports ?? [],
      volumes: f.volumes ?? [],
      ...opt("options", f.options),
      at,
    };
  });
}

function readServices(w: Walk, e: Entry): readonly Service[] | undefined {
  const services: Service[] = [];
  const ok = mapping(w, e.value, e.path, `${JOB}.services`, e.offset, (entries) => {
    for (const s of entries) {
      const container = readContainerLike(w, s.value, s.path, SERVICE, s.offset);
      if (container) services.push({ id: s.key, ...container });
    }
  });
  return ok ? services : undefined;
}

function readMatrix(w: Walk, e: Entry): Valued<Matrix> | undefined {
  const feature = `${JOB}.strategy.matrix`;
  return w.enter(e.value, e.path, e.offset, (n): Valued<Matrix> | undefined => {
    const at = w.at(n, e.offset);
    if (isScalar(n) && hasExpression(n.value)) return { kind: "expression", source: n.value, at };
    if (!isMap(n))
      return w.fail(
        "invalid_type",
        feature,
        e.path,
        at,
        `\`${e.path}\` must be a mapping or an expression.`,
      );
    const dimensions: { name: Text; values: Valued<readonly Value[]> }[] = [];
    let include: Valued<readonly Value[]> | undefined;
    let exclude: Valued<readonly Value[]> | undefined;
    for (const entry of entriesOf(w, n, e.path, e.offset)) {
      const name = entry.key.value;
      if (name === "include" || name === "exclude") {
        const list = readList(w, entry, `${feature}.${name}`, true);
        if (name === "include") include = list;
        else exclude = list;
      } else {
        const values = readList(w, entry, feature, false);
        if (values) dimensions.push({ name: entry.key, values });
      }
    }
    return {
      kind: "literal",
      value: { dimensions, ...opt("include", include), ...opt("exclude", exclude) },
      at,
    };
  });
}

/** A list of values (of mappings when `mappings`), or an expression giving one. */
function readList(
  w: Walk,
  e: Entry,
  feature: string,
  mappings: boolean,
): Valued<readonly Value[]> | undefined {
  return w.enter(e.value, e.path, e.offset, (n): Valued<readonly Value[]> | undefined => {
    const at = w.at(n, e.offset);
    if (isScalar(n) && hasExpression(n.value)) return { kind: "expression", source: n.value, at };
    if (!isSeq(n))
      return w.fail(
        "invalid_type",
        feature,
        e.path,
        at,
        `\`${e.path}\` must be a list or an expression.`,
      );
    const items: Value[] = [];
    n.items.forEach((item, i) => {
      const path = `${e.path}[${i}]`;
      const value = readValue(w, item as Node, path, feature, n.range?.[0] ?? e.offset);
      if (!value) return;
      if (mappings && value.kind !== "mapping") {
        w.fail(
          "invalid_type",
          feature,
          path,
          value.at,
          `\`${path}\` must be a mapping of matrix keys.`,
        );
        return;
      }
      items.push(value);
    });
    return { kind: "literal", value: items, at };
  });
}

type StrategyFields = {
  matrix: Valued<Matrix>;
  failFast: Valued<boolean>;
  maxParallel: Valued<number>;
};

function readStrategy(w: Walk, e: Entry): Strategy | undefined {
  let strategy: Strategy | undefined;
  mapping(w, e.value, e.path, `${JOB}.strategy`, e.offset, (entries) => {
    const f = readKeys<StrategyFields>(w, entries, `${JOB}.strategy`, {
      matrix: (w2, e2) => opt("matrix", readMatrix(w2, e2)),
      "fail-fast": (w2, e2) =>
        opt("failFast", readBoolean(w2, e2.value, e2.path, `${JOB}.strategy.fail-fast`, e2.offset)),
      "max-parallel": (w2, e2) =>
        opt(
          "maxParallel",
          readNumber(w2, e2.value, e2.path, `${JOB}.strategy.max-parallel`, e2.offset, {
            integer: true,
            min: 1,
          }),
        ),
    } satisfies Readers<`${typeof JOB}.strategy`, StrategyFields>);
    strategy = {
      ...opt("matrix", f.matrix),
      ...opt("failFast", f.failFast),
      ...opt("maxParallel", f.maxParallel),
    };
  });
  return strategy;
}

function readRunsOn(w: Walk, e: Entry): Valued<readonly Text[]> | undefined {
  const feature = `${JOB}.runs-on`;
  return w.enter(e.value, e.path, e.offset, (n): Valued<readonly Text[]> | undefined => {
    const at = w.at(n, e.offset);
    if (isScalar(n) && hasExpression(n.value)) return { kind: "expression", source: n.value, at };
    let labels: Text[] | undefined;
    if (isMap(n)) {
      const entries = entriesOf(w, n, e.path, e.offset);
      const f = readKeys<{ labels: Text[] }>(w, entries, feature, {
        labels: (w2, e2) =>
          opt("labels", readTexts(w2, e2.value, e2.path, `${feature}.labels`, e2.offset, true)),
      } satisfies Readers<typeof feature, { labels: Text[] }>);
      if (!f.labels && !entries.some((x) => x.key.value === "labels"))
        missing(w, `${feature}.labels`, e.path, at, "labels");
      labels = f.labels;
    } else {
      labels = readTexts(w, n, e.path, feature, e.offset, true);
    }
    if (!labels) return undefined;
    if (labels.length === 0)
      return w.fail(
        "invalid_value",
        feature,
        e.path,
        at,
        `\`${e.path}\` needs at least one label.`,
      );
    return { kind: "literal", value: labels, at };
  });
}

type StepFields = {
  id: Text;
  name: Text;
  if: Condition;
  uses: Text;
  run: Text;
  workingDirectory: Text;
  shell: Text;
  with: Pairs;
  env: Pairs;
  continueOnError: Valued<boolean>;
  timeoutMinutes: Valued<number>;
};

const STEP_READERS = {
  id: (w, e) => opt("id", readText(w, e.value, e.path, `${STEP}.id`, e.offset)),
  if: (w, e) => opt("if", readCondition(w, e, `${STEP}.if`)),
  name: (w, e) => opt("name", readText(w, e.value, e.path, `${STEP}.name`, e.offset)),
  uses: (w, e) => {
    const uses = readText(w, e.value, e.path, `${STEP}.uses`, e.offset);
    if (!uses) return undefined;
    const v = uses.value;
    // An expression is named as such, not as a malformed reference.
    if (v.includes("${{")) {
      return w.fail(
        "expression_not_allowed",
        `${STEP}.uses`,
        e.path,
        uses.at,
        noExpressions(`${STEP}.uses`),
      );
    }
    const ok =
      v.startsWith("./") ||
      (v.startsWith("docker://") && v.length > "docker://".length) ||
      REMOTE_ACTION.test(v);
    if (!ok) {
      return w.fail(
        "invalid_value",
        `${STEP}.uses`,
        e.path,
        uses.at,
        `\`${cut(v, 80)}\` is not an action reference: use \`owner/repo@ref\`, \`owner/repo/path@ref\`, \`./path\` or \`docker://image\`.`,
      );
    }
    return { uses };
  },
  run: (w, e) => opt("run", readText(w, e.value, e.path, `${STEP}.run`, e.offset)),
  "working-directory": (w, e) =>
    opt("workingDirectory", readText(w, e.value, e.path, `${STEP}.working-directory`, e.offset)),
  shell: (w, e) => opt("shell", readText(w, e.value, e.path, `${STEP}.shell`, e.offset)),
  with: (w, e) => opt("with", readPairs(w, e, `${STEP}.with`)),
  env: (w, e) => opt("env", readPairs(w, e, `${STEP}.env`)),
  "continue-on-error": (w, e) =>
    opt("continueOnError", readBoolean(w, e.value, e.path, `${STEP}.continue-on-error`, e.offset)),
  "timeout-minutes": (w, e) =>
    opt(
      "timeoutMinutes",
      readNumber(w, e.value, e.path, `${STEP}.timeout-minutes`, e.offset, {
        integer: true,
        min: 1,
      }),
    ),
} satisfies Readers<typeof STEP, StepFields>;

function readStep(w: Walk, node: Node | null, path: string, fallback: number): Step | undefined {
  let step: Step | undefined;
  mapping(w, node, path, STEP, fallback, (entries, map) => {
    const at = w.at(map, fallback);
    const f = readKeys<StepFields>(w, entries, STEP, STEP_READERS);
    const has = (key: string) => entries.find((e) => e.key.value === key);
    const run = has("run");
    const uses = has("uses");
    if (run && uses) {
      w.fail(
        "invalid_value",
        STEP,
        uses.path,
        uses.key.at,
        "A step has `run` or `uses`, not both.",
      );
      return;
    }
    if (!run && !uses) {
      w.fail("missing_key", `${STEP}.run`, path, at, `\`${path}\` needs \`run\` or \`uses\`.`);
      return;
    }
    for (const key of run ? ["with"] : ["shell", "working-directory"]) {
      const misplaced = has(key);
      if (misplaced) {
        w.fail(
          "invalid_value",
          `${STEP}.${key}`,
          misplaced.path,
          misplaced.key.at,
          `\`${key}\` belongs to a step with \`${run ? "uses" : "run"}\`.`,
        );
      }
    }
    const common = {
      at,
      ...opt("id", f.id),
      ...opt("name", f.name),
      ...opt("if", f.if),
      env: f.env ?? [],
      ...opt("continueOnError", f.continueOnError),
      ...opt("timeoutMinutes", f.timeoutMinutes),
    };
    if (f.run)
      step = {
        kind: "run",
        run: f.run,
        ...opt("shell", f.shell),
        ...opt("workingDirectory", f.workingDirectory),
        ...common,
      };
    else if (f.uses) step = { kind: "uses", uses: f.uses, with: f.with ?? [], ...common };
  });
  return step;
}

function readSteps(w: Walk, e: Entry): readonly Step[] | undefined {
  return w.enter(e.value, e.path, e.offset, (n) => {
    const at = w.at(n, e.offset);
    if (!isSeq(n))
      return w.fail(
        "invalid_type",
        `${JOB}.steps`,
        e.path,
        at,
        `\`${e.path}\` must be a list of steps.`,
      );
    if (n.items.length === 0)
      return w.fail(
        "invalid_value",
        `${JOB}.steps`,
        e.path,
        at,
        `\`${e.path}\` needs at least one step.`,
      );
    if (n.items.length > MAX_STEPS) {
      return w.fail(
        "limit_exceeded",
        `${JOB}.steps`,
        e.path,
        at,
        `A job has at most ${MAX_STEPS} steps.`,
      );
    }
    const steps: Step[] = [];
    const ids = new Set<string>();
    n.items.forEach((item, i) => {
      const step = readStep(w, item as Node, `${e.path}[${i}]`, n.range?.[0] ?? e.offset);
      if (!step) return;
      if (step.id && ids.has(step.id.value)) {
        w.fail(
          "invalid_value",
          `${STEP}.id`,
          `${e.path}[${i}].id`,
          step.id.at,
          `Step id \`${cut(step.id.value, 60)}\` is used twice in this job.`,
        );
      }
      if (step.id) ids.add(step.id.value);
      steps.push(step);
    });
    return steps;
  });
}

type JobFields = Omit<Job, "id"> & { permissions: Permissions };

const JOB_READERS = {
  name: (w, e) => opt("name", readText(w, e.value, e.path, `${JOB}.name`, e.offset)),
  permissions: (w, e) => opt("permissions", readPermissions(w, e)),
  needs: (w, e) => opt("needs", readTexts(w, e.value, e.path, `${JOB}.needs`, e.offset, true)),
  if: (w, e) => opt("if", readCondition(w, e, `${JOB}.if`)),
  "runs-on": (w, e) => opt("runsOn", readRunsOn(w, e)),
  concurrency: (w, e) => opt("concurrency", readConcurrency(w, e, `${JOB}.concurrency`)),
  outputs: (w, e) => opt("outputs", readPairs(w, e, `${JOB}.outputs`)),
  env: (w, e) => opt("env", readPairs(w, e, `${JOB}.env`)),
  defaults: (w, e) => opt("defaults", readRunDefaults(w, e, `${JOB}.defaults`)),
  steps: (w, e) => opt("steps", readSteps(w, e)),
  "timeout-minutes": (w, e) =>
    opt(
      "timeoutMinutes",
      readNumber(w, e.value, e.path, `${JOB}.timeout-minutes`, e.offset, {
        integer: true,
        min: 1,
      }),
    ),
  strategy: (w, e) => opt("strategy", readStrategy(w, e)),
  "continue-on-error": (w, e) =>
    opt("continueOnError", readBoolean(w, e.value, e.path, `${JOB}.continue-on-error`, e.offset)),
  container: (w, e) => opt("container", readContainerLike(w, e.value, e.path, CONTAINER, e.offset)),
  services: (w, e) => opt("services", readServices(w, e)),
} satisfies Readers<typeof JOB, JobFields>;

function readJob(w: Walk, entry: Entry): Job | undefined {
  let job: Job | undefined;
  mapping(w, entry.value, entry.path, JOB, entry.offset, (entries) => {
    const f = readKeys<JobFields>(w, entries, JOB, JOB_READERS);
    // A job that calls a reusable workflow (refused above) has no runs-on or steps of its own.
    if (entries.some((e) => e.key.value === "uses")) return;
    const has = (key: string) => entries.some((e) => e.key.value === key);
    if (!has("runs-on")) missing(w, `${JOB}.runs-on`, entry.path, entry.key.at, "runs-on");
    if (!has("steps")) missing(w, `${JOB}.steps`, entry.path, entry.key.at, "steps");
    if (!f.runsOn || !f.steps) return;
    job = {
      id: entry.key,
      ...opt("name", f.name),
      runsOn: f.runsOn,
      needs: f.needs ?? [],
      ...opt("if", f.if),
      ...opt("permissions", f.permissions),
      ...opt("strategy", f.strategy),
      env: f.env ?? [],
      ...opt("defaults", f.defaults),
      ...opt("timeoutMinutes", f.timeoutMinutes),
      ...opt("continueOnError", f.continueOnError),
      outputs: f.outputs ?? [],
      services: f.services ?? [],
      ...opt("container", f.container),
      ...opt("concurrency", f.concurrency),
      steps: f.steps,
    };
  });
  return job;
}

function readJobs(w: Walk, e: Entry): readonly Job[] | undefined {
  let jobs: Job[] | undefined;
  mapping(w, e.value, "jobs", "jobs", e.offset, (entries, map) => {
    if (entries.length === 0) {
      w.fail(
        "invalid_value",
        "jobs",
        "jobs",
        w.at(map, e.offset),
        "`jobs` needs at least one job.",
      );
      return;
    }
    jobs = [];
    for (const [i, entry] of entries.entries()) {
      if (i === MAX_JOBS) {
        w.fail(
          "limit_exceeded",
          "jobs",
          entry.path,
          entry.key.at,
          `A workflow has at most ${MAX_JOBS} jobs.`,
        );
        break;
      }
      if (!JOB_ID.test(entry.key.value)) {
        w.fail(
          "invalid_value",
          JOB,
          entry.path,
          entry.key.at,
          `Job id \`${cut(entry.key.value, 60)}\` must start with a letter or \`_\` and hold only letters, digits, \`-\` and \`_\`.`,
        );
        continue;
      }
      const job = readJob(w, entry);
      if (job) jobs.push(job);
    }
  });
  return jobs;
}

// The workflow ----------------------------------------------------------------------------

type WorkflowFields = Omit<Workflow, "path" | "on" | "jobs"> & {
  on: readonly Trigger[];
  jobs: readonly Job[];
};

const WORKFLOW_READERS = {
  name: (w, e) => opt("name", readText(w, e.value, e.path, "name", e.offset)),
  "run-name": (w, e) => opt("runName", readText(w, e.value, e.path, "run-name", e.offset)),
  on: (w, e) => opt("on", readOn(w, e)),
  permissions: (w, e) => opt("permissions", readPermissions(w, e)),
  env: (w, e) => opt("env", readPairs(w, e, "env")),
  defaults: (w, e) => opt("defaults", readRunDefaults(w, e, "defaults")),
  concurrency: (w, e) => opt("concurrency", readConcurrency(w, e, "concurrency")),
  jobs: (w, e) => opt("jobs", readJobs(w, e)),
} satisfies Record<TopKey, Reader<WorkflowFields>>;

function readWorkflow(w: Walk, root: Node | null, path: string): Workflow | undefined {
  let workflow: Workflow | undefined;
  mapping(w, root, "", "", 0, (entries, map) => {
    const f = readKeys<WorkflowFields>(w, entries, "", WORKFLOW_READERS);
    const at = w.at(map, 0);
    for (const key of ["on", "jobs"] as const) {
      if (!entries.some((e) => e.key.value === key)) missing(w, key, "", at, key);
    }
    if (!f.on || !f.jobs) return;
    workflow = {
      path,
      ...opt("name", f.name),
      ...opt("runName", f.runName),
      on: f.on,
      ...opt("permissions", f.permissions),
      env: f.env ?? [],
      ...opt("defaults", f.defaults),
      ...opt("concurrency", f.concurrency),
      jobs: f.jobs,
    };
  });
  return workflow;
}
