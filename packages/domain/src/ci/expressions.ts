// biome-ignore-all lint/suspicious/noTemplateCurlyInString: messages and the quoting helper write `${{` as text
/*
 * Workflow expressions: `${{ }}` templates and `if:` conditions, parsed and evaluated with
 * GitHub's semantics as the pinned runner's evaluator (gitea.dev/actionslib v1.5.2, a port of
 * actions/runner's) implements them, so a field means the same before and after dispatch.
 *
 * Pure and total: no `eval`, no `Function`, no property access on user-keyed objects, and no
 * input makes it throw. Every cost is bounded: expression length, semantic depth (GitHub's
 * rule), syntactic nesting, memory (GitHub's sizes and ledger) and work units (one per node
 * and per character a function reads or writes), so evaluation is safe on untrusted text and
 * large contexts. Which contexts a field may use, and which side evaluates it, is
 * `expression-sites.ts`'s concern.
 */
import {
  compareCodePoints,
  compareIgnoreCase,
  type ExprObject,
  type ExprValue,
  equalsIgnoreCase,
  exprArray,
  foldCase,
  isPrimitive,
  isSpace,
  isTruthy,
  parseNumberLiteral,
  readJson,
  toExprNumber,
  toExprString,
  trimSpace,
  writeJson,
} from "./expression-values.js";

/** UTF-16 units in one expression. GitHub's `ExpressionConstants.MaxLength`. */
export const MAX_EXPRESSION_LENGTH = 21_000;
/** Semantic depth, counted as GitHub counts it. GitHub's `ExpressionConstants.MaxDepth`. */
export const MAX_EXPRESSION_DEPTH = 50;
/** Open parentheses, brackets, argument lists and consecutive `!` while parsing. Proposed. */
export const MAX_NESTING = 50;
/** Bytes of live values per evaluation, in GitHub's sizes. GitHub's evaluation memory limit. */
export const MAX_EXPRESSION_MEMORY = 1 << 20;
/** Work units per evaluation, or per shared `WorkBudget`. Proposed. */
export const MAX_EXPRESSION_WORK = 4_000_000;

export const CONTEXT_NAMES = [
  "github",
  "env",
  "vars",
  "job",
  "jobs",
  "steps",
  "runner",
  "secrets",
  "strategy",
  "matrix",
  "needs",
  "inputs",
] as const;
export type ContextName = (typeof CONTEXT_NAMES)[number];

export const FUNCTION_NAMES = [
  "contains",
  "startsWith",
  "endsWith",
  "format",
  "join",
  "toJSON",
  "fromJSON",
  "hashFiles",
  "case",
  "success",
  "always",
  "cancelled",
  "failure",
] as const;
export type FunctionName = (typeof FUNCTION_NAMES)[number];
export type StatusFunction = "success" | "always" | "cancelled" | "failure";

/** Arity as GitHub's parser checks it (`ExpressionConstants`); `case` also needs an odd count. */
const ARITY: Readonly<Record<FunctionName, readonly [number, number]>> = {
  contains: [2, 2],
  startsWith: [2, 2],
  endsWith: [2, 2],
  format: [1, 255],
  join: [1, 2],
  toJSON: [1, 1],
  fromJSON: [1, 1],
  hashFiles: [1, 255],
  case: [3, 255],
  success: [0, 0],
  always: [0, 0],
  cancelled: [0, 0],
  failure: [0, 0],
};

const CONTEXTS: ReadonlyMap<string, ContextName> = new Map(
  CONTEXT_NAMES.map((n) => [n.toLowerCase(), n]),
);
const FUNCTIONS: ReadonlyMap<string, FunctionName> = new Map(
  FUNCTION_NAMES.map((n) => [n.toLowerCase(), n]),
);
const STATUS_FUNCTIONS: ReadonlySet<FunctionName> = new Set([
  "success",
  "always",
  "cancelled",
  "failure",
]);

export type ExpressionProblemCode =
  | "expression_syntax"
  | "unknown_context"
  | "unknown_function"
  | "expression_failed"
  | "limit_exceeded"
  | "condition_not_single_expression";

/** Why an expression cannot be read or evaluated. `offset` is in the field's text, from 0. */
export interface ExpressionProblem {
  readonly code: ExpressionProblemCode;
  readonly message: string;
  readonly offset: number;
}

// --- Syntax tree ---------------------------------------------------------------------------

type CompareOperator = "==" | "!=" | "<" | "<=" | ">" | ">=";

/** A node and its semantic depth (`d`) and offset in the field's text (`at`). */
export type ExprNode = { readonly at: number; readonly d: number } & (
  | { readonly k: "literal"; readonly value: null | boolean | number | string }
  | { readonly k: "context"; readonly name: ContextName }
  | { readonly k: "property"; readonly target: ExprNode; readonly name: string }
  | { readonly k: "index"; readonly target: ExprNode; readonly index: ExprNode }
  | { readonly k: "star"; readonly target: ExprNode }
  | { readonly k: "not"; readonly operand: ExprNode }
  | {
      readonly k: "compare";
      readonly op: CompareOperator;
      readonly left: ExprNode;
      readonly right: ExprNode;
    }
  | { readonly k: "and" | "or"; readonly operands: readonly ExprNode[] }
  | { readonly k: "call"; readonly fn: FunctionName; readonly args: readonly ExprNode[] }
);

/** One `${{ }}` (or a whole condition): its tree and where its text starts in the field. */
export interface Expression {
  readonly source: string;
  readonly root: ExprNode;
}

/** A field's text: literal runs and expressions, in order. */
export interface Template {
  readonly parts: readonly (string | Expression)[];
}

/** An `if:` ready to evaluate: the expression with `success() &&` added when it calls no status function. */
export interface ParsedCondition {
  readonly root: ExprNode;
}

type Read<K extends string, T> =
  | ({ readonly ok: true } & { readonly [P in K]: T })
  | { readonly ok: false; readonly problem: ExpressionProblem };

/** A sentinel thrown inside this module only; every public function catches it. */
class Stop {
  constructor(readonly problem: ExpressionProblem) {}
}

const stop = (code: ExpressionProblemCode, message: string, offset: number): never => {
  throw new Stop({ code, message, offset });
};

// --- Lexer ---------------------------------------------------------------------------------

type Punct = "(" | ")" | "[" | "]" | "," | "." | "*" | "!" | CompareOperator | "&&" | "||";
type Token =
  | { readonly k: "number"; readonly value: number; readonly at: number; readonly text: string }
  | { readonly k: "string"; readonly value: string; readonly at: number; readonly text: string }
  | { readonly k: "ident"; readonly value: string; readonly at: number; readonly text: string }
  | { readonly k: Punct; readonly at: number; readonly text: string }
  | { readonly k: "end"; readonly at: number; readonly text: string };

const SPACE = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
const BOUNDARY =
  /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000()[\],.!<>=&|}]/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** After these, a `.` starts a number (`.5`) rather than a property. */
const BEFORE_NUMBER: ReadonlySet<string> = new Set([
  "(",
  "[",
  ",",
  "!",
  "<",
  "<=",
  ">",
  ">=",
  "==",
  "!=",
  "&&",
  "||",
]);

/** Tokens of `source`, whose first character is at `base` in the field's text. */
function tokenize(source: string, base: number): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const at = () => base + i;
  const unexpected = (start: number): never =>
    stop(
      "expression_syntax",
      `Unexpected \`${source.slice(start, i + 1)}\` at character ${start + 1} of \`${source}\``,
      base + start,
    );
  while (i < source.length) {
    const c = source[i] as string;
    if (SPACE.test(c)) {
      i++;
      continue;
    }
    const start = i;
    const last = tokens.at(-1)?.k ?? "";
    if (/[A-Za-z_]/.test(c)) {
      while (i < source.length && !BOUNDARY.test(source[i] as string)) i++;
      const text = source.slice(start, i);
      if (!IDENT.test(text)) unexpected(start);
      tokens.push({ k: "ident", value: text, at: base + start, text });
    } else if (/[0-9+-]/.test(c) || (c === "." && (last === "" || BEFORE_NUMBER.has(last)))) {
      i++;
      while (i < source.length && (!BOUNDARY.test(source[i] as string) || source[i] === ".")) i++;
      const text = source.slice(start, i);
      const value = parseNumberLiteral(text);
      if (value === undefined) {
        i--;
        unexpected(start);
      }
      tokens.push({ k: "number", value: value as number, at: base + start, text });
    } else if (c === "'") {
      i++;
      let value = "";
      for (;;) {
        if (i >= source.length) {
          i = source.length - 1;
          stop(
            "expression_syntax",
            `Unclosed string at character ${start + 1} of \`${source}\``,
            base + start,
          );
        }
        if (source[i] === "'") {
          if (source[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += source[i];
        i++;
      }
      tokens.push({ k: "string", value, at: base + start, text: source.slice(start, i) });
    } else {
      const two = source.slice(i, i + 2);
      if (
        two === "==" ||
        two === "!=" ||
        two === "<=" ||
        two === ">=" ||
        two === "&&" ||
        two === "||"
      ) {
        i += 2;
        tokens.push({ k: two, at: base + start, text: two });
      } else if ("()[],.*!<>".includes(c)) {
        i++;
        tokens.push({ k: c as Punct, at: base + start, text: c });
      } else unexpected(start);
    }
  }
  tokens.push({ k: "end", at: at(), text: "" });
  return tokens;
}

// --- Parser --------------------------------------------------------------------------------

/** Parses one expression; refuses unknown names and arities, and every limit, before recursing. */
class Parser {
  #i = 0;
  #nesting = 0;
  readonly #tokens: readonly Token[];
  readonly #source: string;

  constructor(source: string, base: number) {
    this.#source = source;
    this.#tokens = tokenize(source, base);
  }

  parse(): ExprNode {
    const root = this.#or();
    const next = this.#peek();
    if (next.k !== "end") this.#unexpected(next);
    return root;
  }

  #peek(): Token {
    return this.#tokens[this.#i] as Token;
  }

  #next(): Token {
    const token = this.#peek();
    if (token.k !== "end") this.#i++;
    return token;
  }

  #unexpected(token: Token): never {
    const what = token.k === "end" ? "the end of the expression" : `\`${token.text}\``;
    return stop("expression_syntax", `Unexpected ${what} in \`${this.#source}\``, token.at);
  }

  #expect(kind: Token["k"]): Token {
    const token = this.#next();
    if (token.k !== kind) this.#unexpected(token);
    return token;
  }

  #nest(at: number) {
    this.#nesting++;
    if (this.#nesting > MAX_NESTING) {
      stop(
        "limit_exceeded",
        `The expression nests more than ${MAX_NESTING} levels of parentheses, brackets, calls or \`!\``,
        at,
      );
    }
  }

  #node<T extends ExprNode>(node: T): T {
    if (node.d > MAX_EXPRESSION_DEPTH) {
      stop(
        "limit_exceeded",
        `The expression is deeper than ${MAX_EXPRESSION_DEPTH} (GitHub's limit)`,
        node.at,
      );
    }
    return node;
  }

  #logical(kind: "and" | "or", operand: () => ExprNode): ExprNode {
    const first = operand();
    const operator = kind === "and" ? "&&" : "||";
    if (this.#peek().k !== operator) return first;
    const operands: ExprNode[] = [];
    const add = (node: ExprNode) => {
      // `(a && b) && c` is one run, as GitHub counts its depth.
      if (node.k === kind) operands.push(...node.operands);
      else operands.push(node);
    };
    add(first);
    while (this.#peek().k === operator) {
      this.#next();
      add(operand());
    }
    let d = 0;
    for (const operand of operands) d = Math.max(d, operand.d);
    d += 1;
    return this.#node({ k: kind, operands, at: first.at, d });
  }

  #or(): ExprNode {
    return this.#logical("or", () => this.#and());
  }

  #and(): ExprNode {
    return this.#logical("and", () => this.#equality());
  }

  #equality(): ExprNode {
    let left = this.#relational();
    for (let token = this.#peek(); token.k === "==" || token.k === "!="; token = this.#peek()) {
      this.#next();
      const right = this.#relational();
      left = this.#node({
        k: "compare",
        op: token.k,
        left,
        right,
        at: token.at,
        d: 1 + Math.max(left.d, right.d),
      });
    }
    return left;
  }

  #relational(): ExprNode {
    let left = this.#unary();
    for (
      let token = this.#peek();
      token.k === "<" || token.k === "<=" || token.k === ">" || token.k === ">=";
      token = this.#peek()
    ) {
      this.#next();
      const right = this.#unary();
      left = this.#node({
        k: "compare",
        op: token.k,
        left,
        right,
        at: token.at,
        d: 1 + Math.max(left.d, right.d),
      });
    }
    return left;
  }

  #unary(): ExprNode {
    const nots: Token[] = [];
    while (this.#peek().k === "!") {
      const token = this.#next();
      this.#nest(token.at);
      nots.push(token);
    }
    let node = this.#postfix();
    for (const token of nots.reverse()) {
      node = this.#node({ k: "not", operand: node, at: token.at, d: 1 + node.d });
    }
    this.#nesting -= nots.length;
    return node;
  }

  #postfix(): ExprNode {
    let node = this.#primary();
    for (;;) {
      const token = this.#peek();
      if (token.k === ".") {
        this.#next();
        const name = this.#next();
        if (name.k === "*")
          node = this.#node({ k: "star", target: node, at: token.at, d: 1 + node.d });
        else if (name.k === "ident") {
          node = this.#node({
            k: "property",
            target: node,
            name: name.value,
            at: name.at,
            d: 1 + node.d,
          });
        } else this.#unexpected(name);
      } else if (token.k === "[") {
        this.#next();
        if (this.#peek().k === "*") {
          this.#next();
          this.#expect("]");
          node = this.#node({ k: "star", target: node, at: token.at, d: 1 + node.d });
          continue;
        }
        this.#nest(token.at);
        const index = this.#or();
        this.#nesting--;
        this.#expect("]");
        node = this.#node({
          k: "index",
          target: node,
          index,
          at: token.at,
          d: 1 + Math.max(node.d, index.d),
        });
      } else return node;
    }
  }

  #primary(): ExprNode {
    const token = this.#next();
    switch (token.k) {
      case "number":
      case "string":
        return { k: "literal", value: token.value, at: token.at, d: 1 };
      case "(": {
        this.#nest(token.at);
        const inner = this.#or();
        this.#nesting--;
        this.#expect(")");
        return inner;
      }
      case "ident":
        return this.#name(token);
      default:
        return this.#unexpected(token);
    }
  }

  #name(token: Token & { k: "ident" }): ExprNode {
    if (this.#peek().k === "(") {
      const fn = FUNCTIONS.get(token.value.toLowerCase());
      if (fn === undefined) {
        return stop(
          "unknown_function",
          `\`${token.value}\` is not a function GitHub expressions have`,
          token.at,
        );
      }
      const open = this.#next();
      this.#nest(open.at);
      const args: ExprNode[] = [];
      if (this.#peek().k !== ")") {
        args.push(this.#or());
        while (this.#peek().k === ",") {
          this.#next();
          args.push(this.#or());
        }
      }
      this.#nesting--;
      this.#expect(")");
      const [min, max] = ARITY[fn];
      if (args.length < min || args.length > max || (fn === "case" && args.length % 2 === 0)) {
        const count =
          min === max
            ? `${min}`
            : fn === "case"
              ? "an odd number, at least 3,"
              : `${min} to ${max}`;
        stop(
          "expression_syntax",
          `\`${fn}\` takes ${count} arguments, not ${args.length}`,
          token.at,
        );
      }
      const d = Math.max(1, ...args.map((a) => 1 + a.d));
      return this.#node({ k: "call", fn, args, at: token.at, d });
    }
    switch (token.value) {
      case "null":
        return { k: "literal", value: null, at: token.at, d: 1 };
      case "true":
        return { k: "literal", value: true, at: token.at, d: 1 };
      case "false":
        return { k: "literal", value: false, at: token.at, d: 1 };
      case "NaN":
        return { k: "literal", value: Number.NaN, at: token.at, d: 1 };
      case "Infinity":
        return { k: "literal", value: Number.POSITIVE_INFINITY, at: token.at, d: 1 };
    }
    const name = CONTEXTS.get(token.value.toLowerCase());
    if (name === undefined) {
      return stop(
        "unknown_context",
        `\`${token.value}\` is not a context GitHub expressions have`,
        token.at,
      );
    }
    return { k: "context", name, at: token.at, d: 1 };
  }
}

/** One expression, whose text starts at `base` in the field. */
function parseOne(source: string, base: number): Expression {
  if (source.length > MAX_EXPRESSION_LENGTH) {
    stop(
      "limit_exceeded",
      `The expression is ${source.length} characters long; GitHub's limit is ${MAX_EXPRESSION_LENGTH}`,
      base,
    );
  }
  if (trimSpace(source) === "")
    stop("expression_syntax", "An expression was expected inside `${{ }}`", base);
  return { source, root: new Parser(source, base).parse() };
}

/** Text and `${{ … }}` parts, each expression ending at the first `}}` outside a string. */
function split(text: string): (string | { readonly source: string; readonly at: number })[] {
  const parts: (string | { readonly source: string; readonly at: number })[] = [];
  let rest = 0;
  for (;;) {
    const open = text.indexOf("${{", rest);
    if (open < 0) {
      if (rest < text.length) parts.push(text.slice(rest));
      return parts;
    }
    if (open > rest) parts.push(text.slice(rest, open));
    let inString = false;
    let close = -1;
    for (let i = open + 3; i < text.length; i++) {
      if (text[i] === "'") inString = !inString;
      else if (!inString && text[i] === "}" && text[i + 1] === "}") {
        close = i;
        break;
      }
    }
    if (close < 0) stop("expression_syntax", "`${{` is never closed with `}}`", open);
    const inner = text.slice(open + 3, close);
    let lead = 0;
    while (lead < inner.length && isSpace(inner.charCodeAt(lead))) lead++;
    parts.push({ source: trimSpace(inner), at: open + 3 + lead });
    rest = close + 2;
  }
}

/** A field's text: literal runs as written, each `${{ }}` parsed. */
export function parseTemplate(text: string): Read<"template", Template> {
  return attempt(() => ({
    ok: true as const,
    template: {
      parts: split(text).map((part) =>
        typeof part === "string" ? part : parseOne(part.source, part.at),
      ),
    },
  }));
}

/** One expression, as written inside `${{ }}`. */
export function parseExpression(source: string): Read<"expression", Expression> {
  return attempt(() => ({ ok: true as const, expression: parseOne(source, 0) }));
}

/**
 * An `if:`: the whole text when it holds no `${{`, or one `${{ x }}` with nothing else
 * around it. Text beside an expression, whitespace included, is refused: GitHub would read
 * the condition as a string, true whenever the status check passes. A lone string literal is
 * read as the condition's text (`${{ 'false' }}` is `false`), as the runner does. Without a
 * status function anywhere, `success() &&` is added.
 */
export function parseCondition(text: string): Read<"condition", ParsedCondition> {
  return attempt(() => {
    const parts = split(text);
    let expression: Expression | undefined;
    const only = parts.length === 1 ? parts[0] : undefined;
    if (!text.includes("${{")) {
      expression = trimSpace(text) === "" ? undefined : parseOne(text, 0);
    } else if (only !== undefined && typeof only !== "string") {
      const literal = loneStringLiteral(only.source);
      if (literal === undefined) expression = parseOne(only.source, only.at);
      else expression = trimSpace(literal) === "" ? undefined : parseOne(literal, only.at);
    } else {
      const extra = parts.filter((p): p is string => typeof p === "string").join("");
      const newline =
        trimSpace(extra) === "" && extra.endsWith("\n")
          ? " If the only extra text is a block scalar's final newline, `|-` or `>-` drops it."
          : "";
      stop(
        "condition_not_single_expression",
        `The condition \`${trimSpace(text)}\` has text beside its \`\${{ }}\`, so GitHub would read it as a string, always true when the status check passes. Put the whole condition inside one \`\${{ }}\` with nothing around it, or leave out \`\${{ }}\`.${newline}`,
        0,
      );
    }
    const success: ExprNode = { k: "call", fn: "success", args: [], at: 0, d: 1 };
    if (expression === undefined) return { ok: true as const, condition: { root: success } };
    if (callsStatusFunction(expression.root))
      return { ok: true as const, condition: { root: expression.root } };
    const root: ExprNode = {
      k: "and",
      operands: [success, expression.root],
      at: expression.root.at,
      d: 1 + expression.root.d,
    };
    return { ok: true as const, condition: { root } };
  });
}

/** `'…'` alone (quotes doubled inside), as its text; the runner's `ScanExpression` rule. */
function loneStringLiteral(source: string): string | undefined {
  if (source.length < 2 || !source.startsWith("'") || !source.endsWith("'")) return undefined;
  const inner = source.slice(1, -1);
  return inner.replaceAll("''", "").includes("'") ? undefined : inner.replaceAll("''", "'");
}

function callsStatusFunction(node: ExprNode): boolean {
  switch (node.k) {
    case "call":
      return STATUS_FUNCTIONS.has(node.fn) || node.args.some(callsStatusFunction);
    case "property":
    case "star":
      return callsStatusFunction(node.target);
    case "index":
      return callsStatusFunction(node.target) || callsStatusFunction(node.index);
    case "not":
      return callsStatusFunction(node.operand);
    case "compare":
      return callsStatusFunction(node.left) || callsStatusFunction(node.right);
    case "and":
    case "or":
      return node.operands.some(callsStatusFunction);
    default:
      return false;
  }
}

// --- Evaluation ----------------------------------------------------------------------------

/** The contexts Fyrden can provide; runner-only contexts have no field here on purpose. */
export interface ExpressionScope {
  readonly github?: ExprValue;
  readonly inputs?: ExprValue;
  readonly vars?: ExprValue;
  readonly needs?: ExprValue;
  readonly strategy?: ExprValue;
  readonly matrix?: ExprValue;
}

export type NeedResult = "success" | "failure" | "cancelled" | "skipped";

/** What a job-level status function sees. */
export interface JobStatus {
  /** The run was cancelled before this job was decided. */
  readonly cancelled: boolean;
  /** Results of every ancestor job: the transitive closure of `needs`. */
  readonly ancestors: readonly NeedResult[];
}

/** Work units spent so far; pass one budget to several evaluations to bound them together. */
export interface WorkBudget {
  readonly spent: number;
  readonly limit: number;
}

export function newWorkBudget(limit: number = MAX_EXPRESSION_WORK): WorkBudget {
  return { spent: 0, limit };
}

export type Evaluated<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: ExpressionProblem };

/** A projection (`.*`), which later accesses map over; an ordinary array once returned. */
interface Filtered {
  readonly kind: "filtered";
  readonly items: ExprValue[];
}
type Val = ExprValue | Filtered;

const STRING_OVERHEAD = 26;
const MIN_OBJECT = 24;
const REFERENCE = 8;
const NO_STATUS: JobStatus = { cancelled: false, ancestors: [] };

/**
 * GitHub's evaluation memory: a running total per depth; a primitive result (strings
 * included) replaces the charges of everything below it, a collection adds to them.
 */
class Ledger {
  readonly #tallies: number[] = [];
  #active = 0;
  #total = 0;

  add(depth: number, bytes: number, trim: boolean, at: number) {
    if (trim) {
      while (this.#active > depth + 1) {
        this.#active--;
        this.#total -= this.#tallies[this.#active] ?? 0;
        this.#tallies[this.#active] = 0;
      }
    }
    this.#active = Math.max(this.#active, depth + 1);
    this.#tallies[depth] = (this.#tallies[depth] ?? 0) + bytes;
    this.#total += bytes;
    if (this.#total > MAX_EXPRESSION_MEMORY) {
      stop(
        "limit_exceeded",
        `The expression uses more than ${MAX_EXPRESSION_MEMORY} bytes of memory (GitHub's limit)`,
        at,
      );
    }
  }
}

const stringBytes = (text: string) => STRING_OVERHEAD + 2 * text.length;

class Evaluator {
  readonly #ledger = new Ledger();

  constructor(
    readonly scope: ExpressionScope,
    readonly status: JobStatus,
    readonly budget: { spent: number; readonly limit: number },
  ) {}

  work(units: number, at: number) {
    this.budget.spent += units;
    if (this.budget.spent > this.budget.limit) {
      stop(
        "limit_exceeded",
        `The expression needs more than ${this.budget.limit} units of work`,
        at,
      );
    }
  }

  charge(value: Val, depth: number, at: number) {
    if (typeof value === "string") this.#ledger.add(depth, stringBytes(value), true, at);
    else this.#ledger.add(depth, MIN_OBJECT, value === null || typeof value !== "object", at);
  }

  project(count: number, depth: number, at: number) {
    this.#ledger.add(depth, count * REFERENCE, false, at);
    this.work(count, at);
  }

  eval(node: ExprNode, depth: number): Val {
    this.work(1, node.at);
    const value = this.#eval(node, depth);
    this.charge(value, depth, node.at);
    return value;
  }

  #eval(node: ExprNode, depth: number): Val {
    switch (node.k) {
      case "literal":
        return node.value;
      case "context":
        return this.scope[node.name as keyof ExpressionScope] ?? null;
      case "property":
        return this.#access(this.eval(node.target, depth + 1), { name: node.name }, depth, node.at);
      case "index": {
        const target = this.eval(node.target, depth + 1);
        const index = plain(this.eval(node.index, depth + 1));
        return this.#access(target, { value: index }, depth, node.at);
      }
      case "star":
        return this.#star(this.eval(node.target, depth + 1), depth, node.at);
      case "not":
        return !isTruthy(plain(this.eval(node.operand, depth + 1)));
      case "compare":
        return this.#compare(
          node.op,
          plain(this.eval(node.left, depth + 1)),
          plain(this.eval(node.right, depth + 1)),
          node.at,
        );
      case "and":
      case "or": {
        let value: ExprValue = null;
        for (const [i, operand] of node.operands.entries()) {
          value = plain(this.eval(operand, depth + 1));
          if (i < node.operands.length - 1 && isTruthy(value) === (node.k === "or")) break;
        }
        return value === 0 ? 0 : value;
      }
      case "call":
        return this.#call(node.fn, node.args, depth, node.at);
    }
  }

  /** `target.name` or `target[value]`; a projection maps over its items and drops misses. */
  #access(
    target: Val,
    key: { name: string } | { value: ExprValue },
    depth: number,
    at: number,
  ): Val {
    if (target !== null && typeof target === "object" && target.kind === "filtered") {
      const items: ExprValue[] = [];
      for (const item of target.items) {
        const found = this.#lookup(item, key, at);
        if (found === undefined) continue;
        this.project(1, depth, at);
        items.push(found);
      }
      return { kind: "filtered", items };
    }
    return this.#lookup(target, key, at) ?? null;
  }

  #lookup(
    target: ExprValue,
    key: { name: string } | { value: ExprValue },
    at: number,
  ): ExprValue | undefined {
    if (target === null || typeof target !== "object") return undefined;
    if (target.kind === "array") {
      if ("value" in key && typeof key.value === "string") this.work(key.value.length, at);
      const number = "name" in key ? Number.NaN : toExprNumber(key.value);
      if (Number.isNaN(number) || number < 0) return undefined;
      const position = Math.floor(number);
      return position < target.items.length ? target.items[position] : undefined;
    }
    let name: string;
    if ("name" in key) name = key.name;
    else if (isPrimitive(key.value)) name = toExprString(key.value);
    else return undefined;
    return this.#property(target, name, at);
  }

  /** The exact key if present, else the key equal ignoring case that sorts first by code point. */
  #property(object: ExprObject, name: string, at: number): ExprValue | undefined {
    this.work(name.length, at);
    if (object.entries.has(name)) return object.entries.get(name);
    const folded = foldCase(name);
    let match: string | undefined;
    for (const key of object.entries.keys()) {
      this.work(key.length + 1, at);
      if (foldCase(key) === folded && (match === undefined || compareCodePoints(key, match) < 0))
        match = key;
    }
    return match === undefined ? undefined : object.entries.get(match);
  }

  /** `target.*`: an array's items, an object's values, a projection's collections flattened. */
  #star(target: Val, depth: number, at: number): Filtered {
    const items: ExprValue[] = [];
    const collect = (value: ExprValue) => {
      if (value === null || typeof value !== "object") return;
      // Reserved before copying: a wide collection stops here, not after the copy.
      this.project(value.kind === "array" ? value.items.length : value.entries.size, depth, at);
      for (const item of value.kind === "array" ? value.items : value.entries.values()) {
        items.push(item);
      }
    };
    if (target !== null && typeof target === "object" && target.kind === "filtered") {
      for (const item of target.items) collect(item);
    } else collect(target);
    return { kind: "filtered", items };
  }

  #compare(op: CompareOperator, left: ExprValue, right: ExprValue, at: number): boolean {
    if (op === "==") return this.#equals(left, right, at);
    if (op === "!=") return !this.#equals(left, right, at);
    // `<=` and `>=` are equality or the strict order, as GitHub defines them: an array is
    // `<=` itself though it has no order.
    const order = this.#order(left, right, at);
    if (order === undefined) return (op === "<=" || op === ">=") && this.#equals(left, right, at);
    switch (op) {
      case "<":
        return order < 0;
      case "<=":
        return order < 0 || this.#equals(left, right, at);
      case ">":
        return order > 0;
      case ">=":
        return order > 0 || this.#equals(left, right, at);
    }
  }

  #equals(left: ExprValue, right: ExprValue, at: number): boolean {
    if (typeof left === "string" && typeof right === "string") {
      this.work(left.length + right.length, at);
      return equalsIgnoreCase(left, right);
    }
    const leftCollection = left !== null && typeof left === "object";
    const rightCollection = right !== null && typeof right === "object";
    if (leftCollection && rightCollection) return left === right;
    if (left === null && right === null) return true;
    if (typeof left === "boolean" && typeof right === "boolean") return left === right;
    this.work(
      typeof left === "string" ? left.length : typeof right === "string" ? right.length : 1,
      at,
    );
    return toExprNumber(left) === toExprNumber(right);
  }

  /** Sign of the ordering, or undefined when NaN is involved. */
  #order(left: ExprValue, right: ExprValue, at: number): number | undefined {
    if (typeof left === "string" && typeof right === "string") {
      this.work(left.length + right.length, at);
      return Math.sign(compareIgnoreCase(left, right));
    }
    this.work(
      typeof left === "string" ? left.length : typeof right === "string" ? right.length : 1,
      at,
    );
    const a = toExprNumber(left);
    const b = toExprNumber(right);
    if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  #call(fn: FunctionName, args: readonly ExprNode[], depth: number, at: number): Val {
    const arg = (i: number): ExprValue => plain(this.eval(args[i] as ExprNode, depth + 1));
    switch (fn) {
      case "contains": {
        const search = arg(0);
        if (isPrimitive(search)) {
          const item = arg(1);
          if (!isPrimitive(item)) return false;
          const haystack = toExprString(search);
          const needle = toExprString(item);
          this.work(haystack.length + needle.length, at);
          return foldCase(haystack).includes(foldCase(needle));
        }
        if (search.kind !== "array" || search.items.length === 0) return false;
        const item = arg(1);
        this.work(search.items.length, at);
        return search.items.some((element) => this.#equals(element, item, at));
      }
      case "startsWith":
      case "endsWith": {
        const text = arg(0);
        if (!isPrimitive(text)) return false;
        const affix = arg(1);
        if (!isPrimitive(affix)) return false;
        const whole = toExprString(text);
        const part = toExprString(affix);
        this.work(whole.length + part.length, at);
        return fn === "startsWith"
          ? foldCase(whole).startsWith(foldCase(part))
          : foldCase(whole).endsWith(foldCase(part));
      }
      case "format":
        return this.#format(args, depth, at);
      case "join":
        return this.#join(args, depth, at);
      case "toJSON": {
        const json = writeJson(arg(0), {
          maxBytes: MAX_EXPRESSION_MEMORY,
          work: (units) => this.work(units, at),
        });
        if (!json.ok) return stop("limit_exceeded", json.message, at);
        return json.text;
      }
      case "fromJSON": {
        const text = toExprString(arg(0));
        this.work(text.length, at);
        const json = readJson(text);
        if (!json.ok) return stop("expression_failed", `fromJSON: ${json.message}`, at);
        return json.value;
      }
      case "hashFiles":
        return stop(
          "expression_failed",
          "hashFiles reads the job's files, so only the runner evaluates it",
          at,
        );
      case "case": {
        for (let i = 0; i + 1 < args.length; i += 2) {
          const predicate = arg(i);
          if (typeof predicate !== "boolean") {
            return stop(
              "expression_failed",
              "case predicate must evaluate to a boolean value",
              (args[i] as ExprNode).at,
            );
          }
          if (predicate) return arg(i + 1);
        }
        return arg(args.length - 1);
      }
      case "always":
        return true;
      case "cancelled":
        return this.status.cancelled;
      case "success":
        return !this.status.cancelled && this.status.ancestors.every((r) => r === "success");
      case "failure":
        return this.status.ancestors.some((r) => r === "failure");
    }
  }

  /**
   * `format`, as the runner's: the string is parsed first (an index past the arguments is an
   * error before any is evaluated); `{{` and `}}` are braces, each ending a literal segment;
   * arguments are evaluated when first used, once; a format specifier (`{0:x}`) is an error
   * when its placeholder is reached; every segment and replacement used is charged.
   */
  #format(args: readonly ExprNode[], depth: number, at: number): string {
    const format = toExprString(plain(this.eval(args[0] as ExprNode, depth + 1)));
    this.work(format.length, at);
    const invalid = (): never =>
      stop("expression_failed", `format: the format string \`${format}\` is invalid`, at);
    type Segment =
      | { readonly literal: string }
      | { readonly index: number; readonly specifier: boolean };
    const segments: Segment[] = [];
    let bytes = 0;
    const count = (text: string) => {
      if (text === "") return;
      bytes += stringBytes(text);
      if (bytes > MAX_EXPRESSION_MEMORY) {
        stop("limit_exceeded", "format: the result is larger than the memory limit", at);
      }
    };
    const literal = (text: string) => {
      count(text);
      if (text !== "") segments.push({ literal: text });
    };
    let segmentStart = 0;
    for (let i = 0; i < format.length; ) {
      const c = format[i];
      if (c === "{") {
        if (format[i + 1] === "{") {
          literal(format.slice(segmentStart, i + 1));
          i += 2;
          segmentStart = i;
          continue;
        }
        const brace = i;
        i++;
        const digitsStart = i;
        while (i < format.length && format.charCodeAt(i) >= 0x30 && format.charCodeAt(i) <= 0x39)
          i++;
        const digits = format.slice(digitsStart, i);
        // GitHub reads the index as a byte.
        if (digits === "" || Number(digits) > 255) invalid();
        let specifier = false;
        if (format[i] === ":") {
          i++;
          for (;;) {
            if (i >= format.length) invalid();
            if (format[i] !== "}") {
              specifier = true;
              i++;
            } else if (format[i + 1] === "}") {
              specifier = true;
              i += 2;
            } else {
              i++;
              break;
            }
          }
        } else if (format[i] === "}") i++;
        else invalid();
        const index = Number(digits);
        if (index >= args.length - 1) {
          stop(
            "expression_failed",
            `format: the format string \`${format}\` refers to argument ${index}, but only ${args.length - 1} were given`,
            at,
          );
        }
        literal(format.slice(segmentStart, brace));
        segments.push({ index, specifier });
        segmentStart = i;
      } else if (c === "}") {
        if (format[i + 1] !== "}") invalid();
        literal(format.slice(segmentStart, i + 1));
        i += 2;
        segmentStart = i;
      } else i++;
    }
    literal(format.slice(segmentStart));
    const replacements = new Map<number, string>();
    let result = "";
    for (const segment of segments) {
      if ("literal" in segment) {
        result += segment.literal;
        continue;
      }
      let text = replacements.get(segment.index);
      if (text === undefined) {
        text = toExprString(plain(this.eval(args[segment.index + 1] as ExprNode, depth + 1)));
        replacements.set(segment.index, text);
      }
      if (segment.specifier) {
        stop(
          "expression_failed",
          `format: the format string \`${format}\` has a format specifier, which GitHub does not allow`,
          at,
        );
      }
      count(text);
      this.work(text.length, at);
      result += text;
    }
    return result;
  }

  /** `join`: items as strings with the separator, evaluated only once a second item needs it. */
  #join(args: readonly ExprNode[], depth: number, at: number): string {
    const value = plain(this.eval(args[0] as ExprNode, depth + 1));
    if (isPrimitive(value)) return toExprString(value);
    if (value.kind !== "array") return "";
    let separator = ",";
    let bytes = 0;
    let result = "";
    for (const [i, item] of value.items.entries()) {
      if (i === 1 && args.length > 1) {
        const given = plain(this.eval(args[1] as ExprNode, depth + 1));
        if (isPrimitive(given)) separator = toExprString(given);
      }
      const text = toExprString(item);
      const piece = i > 0 ? separator + text : text;
      bytes += (i > 0 ? stringBytes(separator) : 0) + stringBytes(text);
      if (bytes > MAX_EXPRESSION_MEMORY)
        stop("limit_exceeded", "join: the result is larger than the memory limit", at);
      this.work(piece.length + 1, at);
      result += piece;
    }
    return result;
  }
}

/** A projection as the array it stands for. */
function plain(value: Val): ExprValue {
  if (value !== null && typeof value === "object" && value.kind === "filtered")
    return exprArray(value.items);
  return value;
}

function attempt<T>(run: () => T): T | { readonly ok: false; readonly problem: ExpressionProblem } {
  try {
    return run();
  } catch (error) {
    if (error instanceof Stop) return { ok: false, problem: error.problem };
    throw error;
  }
}

function budgetOf(budget: WorkBudget | undefined): { spent: number; readonly limit: number } {
  return (budget ?? newWorkBudget()) as { spent: number; readonly limit: number };
}

/** Parses and evaluates one expression (the text inside `${{ }}`), with no status functions in effect. */
export function evaluateExpression(
  source: string,
  scope: ExpressionScope,
  budget?: WorkBudget,
): Evaluated<ExprValue> {
  return attempt(() => {
    const expression = parseOne(source, 0);
    const evaluator = new Evaluator(scope, NO_STATUS, budgetOf(budget));
    return { ok: true as const, value: plain(evaluator.eval(expression.root, 0)) };
  });
}

/**
 * A field's value: one `${{ x }}` with no text around it keeps `x`'s type; anything else is a
 * string of the literal runs and each expression as a string. One memory ledger per field.
 */
export function evaluateTemplate(
  template: Template,
  scope: ExpressionScope,
  budget?: WorkBudget,
): Evaluated<ExprValue> {
  return attempt(() => {
    const evaluator = new Evaluator(scope, NO_STATUS, budgetOf(budget));
    const [only] = template.parts;
    if (template.parts.length === 1 && only !== undefined && typeof only !== "string") {
      return { ok: true as const, value: plain(evaluator.eval(only.root, 0)) };
    }
    let result = "";
    for (const part of template.parts) {
      const text =
        typeof part === "string" ? part : toExprString(plain(evaluator.eval(part.root, 2)));
      evaluator.charge(text, 1, 0);
      evaluator.work(text.length, 0);
      result += text;
    }
    evaluator.charge(result, 0, 0);
    return { ok: true as const, value: result };
  });
}

/** Whether a job runs: the condition's truthiness, with job-level status functions. */
export function evaluateCondition(
  condition: ParsedCondition,
  scope: ExpressionScope,
  status: JobStatus,
  budget?: WorkBudget,
): Evaluated<boolean> {
  return attempt(() => {
    const evaluator = new Evaluator(scope, status, budgetOf(budget));
    return { ok: true as const, value: isTruthy(plain(evaluator.eval(condition.root, 0))) };
  });
}

/** Room for one quoted chunk, in UTF-16 units after doubling quotes; under the runner's limit. */
const CHUNK = 20_000;

/**
 * `value` written so the runner, which interpolates names, labels and the matrix again,
 * reads back exactly `value`: unchanged without `${{`; otherwise `${{ '…' }}` chunks, each
 * under the runner's length limit, cut between every `$` and a following `{{` so that no
 * `${{` appears except as an opening quote (the runner's undocumented `${{ insert }}` key
 * directive then cannot match).
 */
export function quoteForRunner(value: string): string {
  if (!value.includes("${{")) return value;
  const chunks: string[] = [];
  let chunk = "";
  let units = 0;
  const flush = () => {
    if (chunk !== "") chunks.push(`\${{ '${chunk.replaceAll("'", "''")}' }}`);
    chunk = "";
    units = 0;
  };
  for (let i = 0; i < value.length; ) {
    const cp = value.codePointAt(i) ?? 0;
    const character = String.fromCodePoint(cp);
    const size = character.length + (character === "'" ? 1 : 0);
    if (units + size > CHUNK) flush();
    chunk += character;
    units += size;
    i += character.length;
    if (character === "$" && value.startsWith("{{", i)) flush();
  }
  flush();
  return chunks.join("");
}
